#!/usr/bin/env node
// Target-size gate — STATIC analysis over a site/brand's INTERACTIVE-TARGET size
// tokens (the dimensions a design system ships for buttons, controls, icon hit-
// areas, list rows, …), member of the Token Accessibility suite. Reasons about the
// size TOKENS, not a rendered layout, so it answers: "do these control tokens
// PERMIT a large-enough pointer target, or do they bake in a too-small one?"
//
// Checks, mapped to WCAG 2.2:
//   1. TARGET SIZE (Minimum) — SC 2.5.8 (AA): the bounding box of a pointer target
//      must be ≥ 24×24 CSS px (unless an exception applies). A declared target token
//      whose min(width,height) < 24px → ERROR (fails closed).
//   2. TARGET SIZE (Enhanced) — SC 2.5.5 (AAA): ≥ 44×44 px. Reported as STATUS only
//      (pass/fail per target) — not a hard failure, since 2.5.5 is AAA.
//
// SC 2.5.8 EXCEPTIONS (spacing, inline, user-agent, essential): a consumer may mark
// a target `exception: "inline" | "essential" | "user-agent" | "spacing"` with a
// `reason`; an exempt target is recorded (not failed) but the reason is surfaced so
// the claim stays auditable. The HONEST SCOPE: tokens declare *intended* dimensions;
// only the rendered DOM proves the actual box and the spacing-offset exception — so
// this gate verifies the tokens don't UNDERCUT the floor, not that every instance
// meets it. (The axe-gate / a manual check cover the rendered side.)
//
// Zero-dependency, pure exported primitives + a fail-closed CLI.
//
//   node gates/target-size-gate.mjs [config.json]
//
// INPUTS the consumer supplies (the consumer DECLARES which tokens are targets —
// nothing is auto-assumed, because "is this token a tap target?" is design intent):
//   argv[2] / $TARGET_CONFIG  a `config.json`:
//     { "thresholds": { "minPx": 24, "aaaPx": 44 },
//       "tokens": { "control-min": "44px", … },           // optional token map
//       "targets": [ { "name":"icon-button", "width":"{control-min}"|"24px",
//                      "height":"24px", "exception?":"inline", "reason?":"…" } ] }
//     `width`/`height` (or a single `size` for a square) are a literal px, a `{name}`
//     ref into `tokens`, or a number. A target with only one dimension is treated as
//     a square of that side.
//   $TARGET_REPORT            path to write the machine-readable JSON report.
//
// Thresholds (config ⊕ env), fail closed:
//   $TARGET_MIN_PX  (default 24)  SC 2.5.8 AA floor
//   $TARGET_AAA_PX  (default 44)  SC 2.5.5 AAA target (status only)
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_THRESHOLDS = {
  minPx: 24, // WCAG 2.2 SC 2.5.8 (AA)
  aaaPx: 44, // WCAG 2.2 SC 2.5.5 (AAA)
};

export const EXCEPTIONS = new Set(["inline", "essential", "user-agent", "spacing"]);

/** Resolve a dimension ref (`"24px"` | `24` | `"{token}"`) against a token map → px or null. */
export function resolveDimension(ref, tokens = {}) {
  if (ref == null) return null;
  if (typeof ref === "number") return ref;
  let s = String(ref).trim();
  const m = /^\{(.+)\}$/.exec(s);
  if (m) { if (!(m[1] in tokens)) return null; s = String(tokens[m[1]]).trim(); }
  const px = /^(-?[0-9]*\.?[0-9]+)\s*px$/.exec(s) || /^(-?[0-9]*\.?[0-9]+)$/.exec(s);
  if (px) return parseFloat(px[1]);
  const rem = /^(-?[0-9]*\.?[0-9]+)\s*rem$/.exec(s);
  if (rem) return parseFloat(rem[1]) * 16;
  return null;
}

/** Evaluate ONE declared target. Pure. */
export function evaluateTarget(target, tokens = {}, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const w = resolveDimension(target.width ?? target.size, tokens);
  const h = resolveDimension(target.height ?? target.size, tokens);
  const minSide = [w, h].filter((n) => n != null).length ? Math.min(...[w, h].filter((n) => n != null)) : null;

  const exception = target.exception && EXCEPTIONS.has(target.exception) ? target.exception : null;
  const aaPass = minSide == null ? null : minSide + 1e-9 >= t.minPx;
  const aaaPass = minSide == null ? null : minSide + 1e-9 >= t.aaaPx;

  const findings = [];
  if (minSide == null) {
    findings.push({ severity: "warn", sc: "2.5.8", msg: `target "${target.name}" has no resolvable dimension` });
  } else if (!aaPass && !exception) {
    findings.push({ severity: "error", sc: "2.5.8", msg: `${minSide}px < ${t.minPx}px (AA minimum)` });
  } else if (!aaPass && exception) {
    findings.push({ severity: "info", sc: "2.5.8", msg: `${minSide}px < ${t.minPx}px but exempt via "${exception}"${target.reason ? `: ${target.reason}` : ""}` });
  }

  return {
    name: target.name,
    width: w, height: h, minSide,
    exception,
    reason: target.reason ?? null,
    aa: { min: t.minPx, pass: aaPass },
    aaa: { min: t.aaaPx, pass: aaaPass },
    findings,
    passed: findings.every((f) => f.severity !== "error"),
  };
}

/** Whole-suite evaluation → fail-closed report. Pure. */
export function evaluateTargets({ targets = [], tokens = {}, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const results = targets.map((tg) => evaluateTarget(tg, tokens, t));
  const errors = results.flatMap((r) => r.findings.filter((f) => f.severity === "error"));
  const notes = [];
  if (targets.length === 0) {
    notes.push("no interactive-target tokens declared — target-size cannot be asserted from tokens alone (declare the controls' size tokens to enable this gate)");
  }
  return {
    passed: errors.length === 0,
    thresholds: t,
    summary: {
      targets: results.length,
      belowAA: results.filter((r) => r.aa.pass === false && !r.exception).length,
      exempt: results.filter((r) => r.exception).length,
      meetsAAA: results.filter((r) => r.aaa.pass === true).length,
      unresolved: results.filter((r) => r.minSide == null).length,
    },
    targets: results,
    notes,
    coverage: targets.length === 0 ? "none" : "declared",
    // Envelope a future lone `target.min-size` criterion can consume.
    target: { minSizeAA: errors.length === 0, declared: targets.length },
  };
}

export async function runTargetSizeGate({ config = {}, thresholds = {} }) {
  const cfg = typeof config === "string" ? JSON.parse(await readFile(config, "utf8")) : config;
  return evaluateTargets({
    targets: cfg.targets || [],
    tokens: cfg.tokens || {},
    thresholds: { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}), ...thresholds },
  });
}

function envThresholds() {
  const t = {};
  const num = (e) => (process.env[e] != null ? Number(process.env[e]) : undefined);
  const set = (k, e) => { const v = num(e); if (v != null && !Number.isNaN(v)) t[k] = v; };
  set("minPx", "TARGET_MIN_PX");
  set("aaaPx", "TARGET_AAA_PX");
  return t;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const config = argv[0] || process.env.TARGET_CONFIG;
  if (!config) {
    console.error("✗ target-size-gate: usage: target-size-gate.mjs <config.json>  (or set $TARGET_CONFIG)");
    process.exit(2);
  }
  const report = await runTargetSizeGate({ config, thresholds: envThresholds() });
  if (process.env.TARGET_REPORT) await writeFile(resolve(process.env.TARGET_REPORT), JSON.stringify(report, null, 2) + "\n");

  const s = report.summary;
  const line = `target-size-gate: ${s.targets} target(s) — ${s.belowAA} below AA, ${s.exempt} exempt, ${s.meetsAAA} meet AAA`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const r of report.targets) for (const f of r.findings) if (f.severity === "error") console.error(`  · ${r.name}: ${f.msg}`);
    process.exit(1);
  }
  console.log(`✓ ${line}`);
  for (const n of report.notes) console.log(`  · note: ${n}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ target-size-gate: error —", e.stack || e.message); process.exit(1); });
}
