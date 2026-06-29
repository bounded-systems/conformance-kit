#!/usr/bin/env node
// Opacity-contrast gate — the CROSS-CUTTING guard of the Token Accessibility suite,
// and the one that catches a whole class of real bugs (the bounded.tools opacity
// regression): a colour token that clears AA at full strength but is APPLIED at a
// reduced opacity — `opacity: .6`, `color-mix(… N%, transparent)`, an `--alpha`
// token, an 8-digit `#rrggbbaa` — so the EFFECTIVE, composited colour silently
// drops below contrast. Per-pair palette checks miss it because they test the
// opaque token; per-page axe can miss it when the element isn't sampled.
//
// For every consumer-declared "opacity applied to a foreground" usage we composite
// the foreground OVER its background at the stated alpha (Porter-Duff source-over,
// opaque backdrop) and require the EFFECTIVE WCAG contrast to clear the floor:
//   · text        ≥ 4.5:1   (WCAG 2.2 SC 1.4.3 AA)
//   · large-text  ≥ 3:1     (SC 1.4.3 AA, large)
//   · ui          ≥ 3:1     (SC 1.4.11 non-text)
// We report BOTH the nominal (alpha = 1) ratio and the effective ratio, so the DROP
// the opacity introduces is visible. A combo that drops below its floor → FAIL.
//
// HONEST SCOPE: this assumes the backdrop the consumer declares is the actual one
// (the real backdrop is a DOM/stacking-context fact). If a translucent layer sits
// over an unknown/photo background, contrast can't be guaranteed statically — the
// gate flags such usages as `unknownBackdrop` for manual review rather than passing
// them. Stacked translucent layers can be expressed by pre-compositing.
//
// Zero-dependency: colour-science primitives are imported from the palette gate.
//
//   node gates/opacity-contrast-gate.mjs <tokens.(json|css)> <usages.json>
//
// INPUTS:
//   argv[2] / $OPACITY_TOKENS  the token map (DTCG json | tokens.css), same loader
//                              as the palette gate.
//   argv[3] / $OPACITY_USAGES  a `usages.json` the consumer authors:
//     { "thresholds": { … }, "opacityTokens": { "muted": 0.6, … },
//       "usages": [ { "fg":"token|#hex", "bg":"token|#hex",
//                     "opacity": 0.6 | "{muted}",   // 0..1, or a ref into opacityTokens
//                     "kind": "text"|"large-text"|"ui", "name?":"…",
//                     "unknownBackdrop?": true } ] }
//
// Thresholds (config ⊕ env), fail closed:
//   $OPACITY_MIN_RATIO_TEXT  (default 4.5)  SC 1.4.3 (AA, text)
//   $OPACITY_MIN_RATIO_LARGE (default 3.0)  SC 1.4.3 (AA, large)
//   $OPACITY_MIN_RATIO_UI    (default 3.0)  SC 1.4.11 (non-text)
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseHex, toHex, wcagContrast, loadTokens, resolveColor } from "./palette-gate.mjs";

export const DEFAULT_THRESHOLDS = {
  minRatioText: 4.5, // SC 1.4.3
  minRatioLarge: 3.0, // SC 1.4.3 large
  minRatioUi: 3.0, // SC 1.4.11
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Composite a foreground sRGB over a background sRGB at alpha (0..1).
 * Porter-Duff "source-over" with an OPAQUE backdrop: out = fg·α + bg·(1−α),
 * computed per channel in sRGB space. (sRGB compositing is what a browser's
 * `opacity` / `rgba()` / `color-mix(… transparent)` effectively does for a single
 * translucent layer over an opaque backdrop.)
 * Ref: Porter & Duff (1984), "Compositing Digital Images"; CSS Color 4 alpha.
 */
export function compositeOver(fgRgb, bgRgb, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return [0, 1, 2].map((i) => fgRgb[i] * a + bgRgb[i] * (1 - a));
}

export function ratioFloor(kind, t) {
  if (kind === "ui") return t.minRatioUi;
  if (kind === "large-text") return t.minRatioLarge;
  return t.minRatioText;
}

/** Evaluate ONE opacity-on-foreground usage. `fgHex`/`bgHex` resolved. Pure. */
export function evaluateUsage(usage, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const kind = usage.kind || "text";
  const fg = parseHex(usage.fgHex);
  const bg = parseHex(usage.bgHex);
  const alpha = usage.opacity == null ? 1 : Number(usage.opacity);
  const floor = ratioFloor(kind, t);

  const nominal = wcagContrast(fg, bg);
  const composited = compositeOver(fg, bg, alpha);
  const effective = wcagContrast(composited, bg);
  const pass = effective + 1e-9 >= floor;

  const findings = [];
  if (usage.unknownBackdrop) {
    findings.push({ severity: "error", sc: kind === "ui" ? "1.4.11" : "1.4.3", msg: `translucent fg over an UNKNOWN backdrop — effective contrast cannot be guaranteed statically (declared backdrop ${toHex(bg)} assumed)` });
  } else if (!pass) {
    findings.push({ severity: "error", sc: kind === "ui" ? "1.4.11" : "1.4.3", msg: `effective contrast ${round2(effective)}:1 < ${floor}:1 at opacity ${alpha} (nominal ${round2(nominal)}:1)` });
  }

  return {
    name: usage.name || `${usage.fg}@${alpha} on ${usage.bg}`,
    fg: { ref: usage.fg, hex: toHex(fg) },
    bg: { ref: usage.bg, hex: toHex(bg) },
    kind,
    opacity: alpha,
    effectiveHex: toHex(composited),
    nominalRatio: round2(nominal),
    effectiveRatio: round2(effective),
    floor,
    drop: round2(nominal - effective),
    unknownBackdrop: !!usage.unknownBackdrop,
    findings,
    passed: findings.length === 0,
  };
}

/** Whole-suite evaluation → fail-closed report. Pure. */
export function evaluateOpacityContrast({ usages = [], thresholds = DEFAULT_THRESHOLDS } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const results = usages.map((u) => evaluateUsage(u, t));
  const failing = results.filter((r) => !r.passed);
  return {
    passed: failing.length === 0,
    thresholds: t,
    summary: {
      usages: results.length,
      failing: failing.length,
      unknownBackdrops: results.filter((r) => r.unknownBackdrop).length,
      worstDrop: results.reduce((m, r) => Math.max(m, r.drop), 0),
    },
    usages: results,
    // Envelope a future lone `opacity.effective-contrast` criterion can consume.
    opacity: { effectiveContrast: failing.length === 0 },
  };
}

/** Resolve an opacity value: a number 0..1, or `{name}` into opacityTokens. */
export function resolveOpacity(ref, opacityTokens = {}) {
  if (ref == null) return 1;
  if (typeof ref === "number") return ref;
  const m = /^\{(.+)\}$/.exec(String(ref).trim());
  if (m) return Number(opacityTokens[m[1]] ?? 1);
  return Number(ref);
}

/** Full run: load tokens + usages → resolve → evaluate. Exposed for tests. */
export async function runOpacityContrastGate({ tokens, usages, thresholds = {} }) {
  const map = typeof tokens === "string" ? await loadTokens(tokens) : tokens;
  const spec = typeof usages === "string" ? JSON.parse(await readFile(usages, "utf8")) : usages;
  const resolved = (spec.usages || []).map((u) => ({
    ...u,
    fgHex: resolveColor(map, u.fg),
    bgHex: resolveColor(map, u.bg),
    opacity: resolveOpacity(u.opacity, spec.opacityTokens || {}),
  }));
  return evaluateOpacityContrast({
    usages: resolved,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(spec.thresholds || {}), ...thresholds },
  });
}

function envThresholds() {
  const t = {};
  const num = (e) => (process.env[e] != null ? Number(process.env[e]) : undefined);
  const set = (k, e) => { const v = num(e); if (v != null && !Number.isNaN(v)) t[k] = v; };
  set("minRatioText", "OPACITY_MIN_RATIO_TEXT");
  set("minRatioLarge", "OPACITY_MIN_RATIO_LARGE");
  set("minRatioUi", "OPACITY_MIN_RATIO_UI");
  return t;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tokens = argv[0] || process.env.OPACITY_TOKENS;
  const usages = argv[1] || process.env.OPACITY_USAGES;
  if (!tokens || !usages) {
    console.error("✗ opacity-contrast-gate: usage: opacity-contrast-gate.mjs <tokens.(json|css)> <usages.json>");
    console.error("  (or set $OPACITY_TOKENS and $OPACITY_USAGES)");
    process.exit(2);
  }
  const report = await runOpacityContrastGate({ tokens, usages, thresholds: envThresholds() });
  if (process.env.OPACITY_REPORT) await writeFile(resolve(process.env.OPACITY_REPORT), JSON.stringify(report, null, 2) + "\n");

  const s = report.summary;
  const line = `opacity-contrast-gate: ${s.usages} usage(s) — ${s.failing} failing (worst drop ${s.worstDrop}:1)`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const u of report.usages) for (const f of u.findings) console.error(`  · ${u.name} [${u.kind}] ${u.fg.hex}@${u.opacity}→${u.effectiveHex}/${u.bg.hex}: ${f.msg}`);
    process.exit(1);
  }
  console.log(`✓ ${line}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ opacity-contrast-gate: error —", e.stack || e.message); process.exit(1); });
}
