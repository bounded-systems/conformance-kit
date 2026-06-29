#!/usr/bin/env node
// Likeness gate — token-HYGIENE + distinctness member of the Token Accessibility
// suite. Two perceptual-distance checks over the colour tokens, both built on the
// CIEDE2000 ΔE primitive the palette gate already ships (no duplication):
//
//   1. NEAR-DUPLICATE TOKENS (hygiene) — any two DISTINCT token NAMES whose colours
//      are within ΔE < ~2 (CIEDE2000) are perceptually identical (ΔE ≈ 2.3 is the
//      classic "just-noticeable difference" — below it the eye can't tell them
//      apart). They're redundant: a consolidate-candidate, and a maintenance hazard
//      (two names that silently mean the same colour drift apart later). Reported as
//      a WARNING (it's hygiene, not a WCAG failure) — escalate via `dupSeverity`.
//
//   2. CONFUSABLE CATEGORICALS (a11y) — colours the consumer DECLARES must stay
//      mutually distinguishable (status colours, chart series, map keys) are checked
//      for collapse: every pair must stay ≥ a ΔE floor under NORMAL vision AND under
//      deuteranopia / protanopia / tritanopia (Machado-2009). A categorical pair
//      that collapses (especially only under a CVD) is an ERROR — it fails the
//      design's own distinctness contract for some viewers. This reuses the palette
//      gate's `evaluateCategorical`. Maps to the spirit of SC 1.4.1 (Use of Colour):
//      if meaning rides on colour, the colours must actually differ for everyone.
//
// HONEST SCOPE: "redundant" is a perceptual claim about the token VALUES; whether a
// near-duplicate is INTENTIONAL (e.g. a hover state 1 step away) is design intent the
// gate can't read — hence WARNING, with the ΔE surfaced so a human decides. The
// distinctness floor is a proxy, not a guarantee of legibility at any size.
//
// Zero-dependency; primitives imported from the palette gate. Fail-closed CLI.
//
//   node gates/likeness-gate.mjs <tokens.(json|css)> [config.json]
//
// INPUTS:
//   argv[2] / $LIKENESS_TOKENS  the token map (DTCG json | tokens.css).
//   argv[3] / $LIKENESS_CONFIG  a `config.json`:
//     { "thresholds": { "dupDeltaE": 2, "collapseDeltaE": 10, "dupSeverity":"warn" },
//       "ignore": ["tokenA","tokenB"],                  // names to skip in dup scan
//       "categorical": [ { "name":"status", "members":["enforced","partial",…] } ] }
//     (a bare `["a","b",…]` categorical array is also accepted = one unnamed group.)
//   $LIKENESS_REPORT            path to write the machine-readable JSON report.
//
// Thresholds (config ⊕ env), fail closed on categorical collapse:
//   $LIKENESS_DUP_DELTAE       (default 2)   near-duplicate ΔE ceiling
//   $LIKENESS_COLLAPSE_DELTAE  (default 10)  categorical distinctness floor
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseHex, toHex, rgbToLab, ciede2000, loadTokens, resolveColor, evaluateCategorical } from "./palette-gate.mjs";

export const DEFAULT_THRESHOLDS = {
  dupDeltaE: 2, // CIEDE2000 — below ≈ JND ⇒ perceptually identical
  collapseDeltaE: 10, // categorical distinctness floor (normal + CVD)
  dupSeverity: "warn", // "warn" | "error"
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Scan a token map for near-duplicate colours (CIEDE2000 ΔE < dupDeltaE). Returns
 * the unordered pairs, with ΔE and an `identical` flag (ΔE === 0, e.g. two aliases
 * of the same primitive). Pure.
 */
export function findNearDuplicates(tokenMap, thresholds = DEFAULT_THRESHOLDS, ignore = []) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const skip = new Set(ignore);
  const entries = Object.entries(tokenMap)
    .filter(([k]) => !skip.has(k))
    .map(([name, hex]) => { try { return { name, rgb: parseHex(hex), hex: toHex(parseHex(hex)) }; } catch { return null; } })
    .filter(Boolean);
  const dups = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const A = entries[i], B = entries[j];
      const dE = ciede2000(rgbToLab(A.rgb), rgbToLab(B.rgb));
      if (dE + 1e-9 < t.dupDeltaE) {
        dups.push({ a: A.name, b: B.name, aHex: A.hex, bHex: B.hex, deltaE: round2(dE), identical: dE === 0 });
      }
    }
  }
  dups.sort((x, y) => x.deltaE - y.deltaE);
  return { threshold: t.dupDeltaE, count: dups.length, duplicates: dups };
}

/** Normalize the config's categorical groups to [{ name, members:[{ref,hex}] }]. */
function resolveGroups(config, map) {
  let groups = config.categorical || [];
  if (Array.isArray(groups) && groups.every((g) => typeof g === "string")) groups = [{ name: "categorical", members: groups }];
  return groups.map((g) => ({
    name: g.name || "categorical",
    members: (g.members || []).map((ref) => ({ ref, hex: resolveColor(map, ref) })),
  }));
}

/** Whole-suite evaluation → fail-closed report. Pure given resolved inputs. */
export function evaluateLikeness({ tokenMap = {}, groups = [], thresholds = DEFAULT_THRESHOLDS, ignore = [] } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const near = findNearDuplicates(tokenMap, t, ignore);

  const categorical = groups.map((g) => {
    const res = evaluateCategorical(g.members, { collapseDeltaE: t.collapseDeltaE });
    return { name: g.name, members: g.members.map((m) => ({ ref: m.ref, hex: toHex(parseHex(m.hex)) })), ...res };
  });
  const collapseCount = categorical.reduce((n, c) => n + c.count, 0);

  const dupIsError = t.dupSeverity === "error";
  const errors = (dupIsError ? near.count : 0) + collapseCount;

  return {
    passed: errors === 0,
    thresholds: t,
    summary: {
      tokens: Object.keys(tokenMap).length,
      nearDuplicates: near.count,
      identicalPairs: near.duplicates.filter((d) => d.identical).length,
      categoricalGroups: categorical.length,
      categoricalCollapses: collapseCount,
    },
    nearDuplicates: near,
    categorical,
    // Envelope a future lone `likeness.*` criterion can consume.
    likeness: {
      distinctCategoricals: collapseCount === 0,
      noRedundantTokens: near.count === 0,
    },
  };
}

export async function runLikenessGate({ tokens, config = {}, thresholds = {} }) {
  const map = typeof tokens === "string" ? await loadTokens(tokens) : tokens;
  const cfg = typeof config === "string" ? JSON.parse(await readFile(config, "utf8")) : config;
  const groups = resolveGroups(cfg, map);
  return evaluateLikeness({
    tokenMap: map,
    groups,
    ignore: cfg.ignore || [],
    thresholds: { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}), ...thresholds },
  });
}

function envThresholds() {
  const t = {};
  const num = (e) => (process.env[e] != null ? Number(process.env[e]) : undefined);
  const set = (k, e) => { const v = num(e); if (v != null && !Number.isNaN(v)) t[k] = v; };
  set("dupDeltaE", "LIKENESS_DUP_DELTAE");
  set("collapseDeltaE", "LIKENESS_COLLAPSE_DELTAE");
  if (process.env.LIKENESS_DUP_SEVERITY) t.dupSeverity = process.env.LIKENESS_DUP_SEVERITY;
  return t;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tokens = argv[0] || process.env.LIKENESS_TOKENS;
  const config = argv[1] || process.env.LIKENESS_CONFIG;
  if (!tokens) {
    console.error("✗ likeness-gate: usage: likeness-gate.mjs <tokens.(json|css)> [config.json]  (or set $LIKENESS_TOKENS)");
    process.exit(2);
  }
  const report = await runLikenessGate({ tokens, config: config || {}, thresholds: envThresholds() });
  if (process.env.LIKENESS_REPORT) await writeFile(resolve(process.env.LIKENESS_REPORT), JSON.stringify(report, null, 2) + "\n");

  const s = report.summary;
  const line = `likeness-gate: ${s.tokens} token(s) — ${s.nearDuplicates} near-duplicate(s) (${s.identicalPairs} identical), ${s.categoricalCollapses} categorical collapse(s)`;
  const dupLine = (d) => `  · ${d.identical ? "identical" : "near-dup"}: ${d.a} ≈ ${d.b} (${d.aHex}/${d.bHex}) ΔE ${d.deltaE}`;
  const colLine = (c) => `  · collapse: ${c.a} vs ${c.b} (${c.aHex}/${c.bHex}) under ${c.condition} — ΔE ${c.deltaE} < ${c.min}`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const c of report.categorical) for (const x of c.collapses) console.error(colLine(x));
    if (report.thresholds.dupSeverity === "error") for (const d of report.nearDuplicates.duplicates) console.error(dupLine(d));
    process.exit(1);
  }
  console.log(`✓ ${line}`);
  for (const d of report.nearDuplicates.duplicates) console.log(dupLine(d)); // hygiene warnings
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ likeness-gate: error —", e.stack || e.message); process.exit(1); });
}
