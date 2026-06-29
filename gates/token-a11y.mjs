#!/usr/bin/env node
// Token Accessibility suite — the UNIFIED runner. One `token-a11y.json` config drives
// every member of the suite over a single token map, and the runner FAILS CLOSED if
// ANY member fails. This is the named "thing": token-level accessibility as one gate.
//
// Members (each a standalone gate, documented in TOKEN-A11Y.md):
//   · palette          — palette-gate.mjs       CVD-safe / APCA / non-text contrast
//   · pairing          — pairing-extractor.mjs  derive fg×bg pairings from CSS usage,
//                        then feed the palette check (coverage without hand-listing)
//   · typography       — typography-gate.mjs    line-height / spacing / size / weight
//   · targetSize       — target-size-gate.mjs   interactive target ≥ 24×24 (2.5.8)
//   · opacity          — opacity-contrast-gate  effective contrast of translucent fg
//   · likeness         — likeness-gate.mjs      near-duplicate + confusable categoricals
//
//   node gates/token-a11y.mjs <token-a11y.json>      # (or $TOKEN_A11Y_CONFIG)
//
// CONFIG (every member is OPTIONAL — only declared members run):
//   { "tokens": "brand/tokens/tokens.css",          // default token map (path or map)
//     "palette":   { "pairings":[…], "categorical":[…], "thresholds":{…} } | "pairings.json",
//     "pairing":   { "css":["a.css","b.css"], "declared":"pairings.json", "gate":true },
//     "typography":{ "tokens":"…", "body":["body"], "thresholds":{…} } | "typo.json",
//     "targetSize":{ "targets":[…], "thresholds":{…} } | "targets.json",
//     "opacity":   { "usages":[…], "opacityTokens":{…} } | "usages.json",
//     "likeness":  { "categorical":[…], "thresholds":{…} } | "likeness.json" }
//   A member may set its own `tokens` to override the top-level map.
//   $TOKEN_A11Y_REPORT writes the aggregate JSON report.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { runPaletteGate } from "./palette-gate.mjs";
import { runTypographyGate } from "./typography-gate.mjs";
import { runTargetSizeGate } from "./target-size-gate.mjs";
import { runOpacityContrastGate } from "./opacity-contrast-gate.mjs";
import { runLikenessGate } from "./likeness-gate.mjs";
import { runPairingExtractor } from "./pairing-extractor.mjs";

const MEMBERS = ["palette", "pairing", "typography", "targetSize", "opacity", "likeness"];

/** Resolve a path/config value relative to the config file's directory. */
function rel(base, p) {
  if (typeof p !== "string") return p;
  return isAbsolute(p) ? p : join(base, p);
}

/**
 * Run the suite from a parsed config. `base` is the dir paths resolve against.
 * Returns the aggregate report. Pure-ish (I/O only via the member runners).
 */
export async function runTokenA11y(config, base = ".") {
  const tokens = (m) => rel(base, m?.tokens ?? config.tokens);
  const members = {};
  const run = async (name, fn) => { try { members[name] = { ...(await fn()), error: null }; } catch (e) { members[name] = { passed: false, error: String(e.message || e) }; } };

  if (config.palette) {
    const m = typeof config.palette === "string" ? rel(base, config.palette) : config.palette;
    await run("palette", () => runPaletteGate({ tokens: tokens(typeof m === "object" ? m : {}), pairings: m }));
  }
  if (config.pairing) {
    const m = config.pairing;
    await run("pairing", async () => {
      const r = await runPairingExtractor({
        tokens: tokens(m), css: (m.css || []).map((c) => rel(base, c)),
        declared: m.declared ? rel(base, m.declared) : null,
      });
      // Report-only unless `gate:true`.
      return m.gate ? r : { ...r, passed: true, gated: false };
    });
  }
  if (config.typography) {
    const m = typeof config.typography === "string" ? rel(base, config.typography) : config.typography;
    await run("typography", () => runTypographyGate({ tokens: tokens(typeof m === "object" ? m : {}), config: m }));
  }
  if (config.targetSize) {
    const m = typeof config.targetSize === "string" ? rel(base, config.targetSize) : config.targetSize;
    await run("targetSize", () => runTargetSizeGate({ config: m }));
  }
  if (config.opacity) {
    const m = typeof config.opacity === "string" ? rel(base, config.opacity) : config.opacity;
    await run("opacity", () => runOpacityContrastGate({ tokens: tokens(typeof m === "object" ? m : {}), usages: m }));
  }
  if (config.likeness) {
    const m = typeof config.likeness === "string" ? rel(base, config.likeness) : config.likeness;
    await run("likeness", () => runLikenessGate({ tokens: tokens(typeof m === "object" ? m : {}), config: m }));
  }

  const ran = Object.keys(members);
  const failing = ran.filter((k) => members[k].passed === false);
  return {
    passed: failing.length === 0,
    members: Object.fromEntries(MEMBERS.filter((k) => k in members).map((k) => [k, members[k]])),
    summary: { ran, passed: ran.filter((k) => members[k].passed !== false), failing },
  };
}

/** One-line status per member, for the CLI. */
function memberLine(name, m) {
  if (m.error) return `  ✗ ${name}: error — ${m.error}`;
  const s = m.summary || {};
  const tail =
    name === "palette" ? `${s.pairs} pair(s), ${s.failingPairs} failing, ${s.categoricalCollapses} collapse(s)`
    : name === "pairing" ? `${s.total} pair(s), ${s.failing} failing${m.gated === false ? " (report-only)" : ""}`
    : name === "typography" ? `${s.styles} style(s), ${s.errors} error(s), ${s.warnings} warn(s)`
    : name === "targetSize" ? `${s.targets} target(s), ${s.belowAA} below AA${m.coverage === "none" ? " (none declared)" : ""}`
    : name === "opacity" ? `${s.usages} usage(s), ${s.failing} failing`
    : name === "likeness" ? `${s.nearDuplicates} near-dup(s), ${s.categoricalCollapses} collapse(s)`
    : "";
  return `  ${m.passed ? "✓" : "✗"} ${name}: ${tail}`;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const configPath = argv[0] || process.env.TOKEN_A11Y_CONFIG;
  if (!configPath) {
    console.error("✗ token-a11y: usage: token-a11y.mjs <token-a11y.json>  (or set $TOKEN_A11Y_CONFIG)");
    process.exit(2);
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const report = await runTokenA11y(config, dirname(resolve(configPath)));
  if (process.env.TOKEN_A11Y_REPORT) await writeFile(resolve(process.env.TOKEN_A11Y_REPORT), JSON.stringify(report, null, 2) + "\n");

  const lines = Object.entries(report.members).map(([k, m]) => memberLine(k, m));
  const head = `token-a11y: ${report.summary.ran.length} member(s) — ${report.summary.failing.length} failing`;
  if (!report.passed) { console.error(`✗ ${head}`); for (const l of lines) console.error(l); process.exit(1); }
  console.log(`✓ ${head}`); for (const l of lines) console.log(l);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ token-a11y: error —", e.stack || e.message); process.exit(1); });
}
