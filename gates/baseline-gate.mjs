#!/usr/bin/env node
// Baseline-availability gate — turns "our CSS is interoperable" into a
// CONTINUOUSLY-ENFORCED member of the conformance contract. It maps a project's
// SHIPPED CSS to web-features Baseline data (via stylelint-plugin-use-baseline —
// headless, no browser) and FAILS CLOSED (exit 1) when the site-wide status is
// below a configurable target (default: widely). The machine-readable result is
// exactly the shape lone's conformance() model consumes for `compatibility.baseline`
// (`{ status, fallbackTested }`), so a clean run lets a site honestly assert that
// criterion — and a regression to a newer/limited feature turns CI red.
//
//   node gates/baseline-gate.mjs [cssGlob]     # build gate (exit 1 below target)
//
// HONEST, NOT ASPIRATIONAL: the gate reports the MEASURED status whatever it is.
// The site-wide status is the WORST feature used (a feature guarded behind an
// `@supports` query is a tested fallback and does not count against it):
//   • 0 features below "widely"                  -> "widely"
//   • some below "widely" but none below "newly" -> "newly"
//   • any feature below "newly"                  -> "limited"
//
// Config-driven; NOTHING about any one site is hard-coded:
//   argv[2] / $BASELINE_CSS    glob of CSS to scan       (default: "dist/**/*.css")
//   $BASELINE_TARGET          lowest acceptable status   (widely|newly, default: widely)
//   $BASELINE_REPORT          path to write the JSON report (default: none)
//
// The pure classify/threshold functions are exported for unit testing.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Pure core (unit-testable) ────────────────────────────────────────────────

export const STATUS_ORDER = ["limited", "newly", "widely"]; // worst → best

/** Site-wide status from the two stylelint passes (counts of features below each bar). */
export function classify(belowWidely, belowNewly) {
  if (belowWidely === 0) return "widely";
  return belowNewly > 0 ? "limited" : "newly";
}

/** Whether `status` is at or above the `target` bar. */
export function meetsTarget(status, target) {
  return STATUS_ORDER.indexOf(status) >= STATUS_ORDER.indexOf(target);
}

/** Build the report from a measured status. Pure: (status, target, offenders) → report. */
export function evaluateBaseline(status, target = "widely", offenders = []) {
  return {
    passed: meetsTarget(status, target),
    target,
    status,
    offenders,
    // The envelope lone's conformance() consumes for `compatibility.baseline`.
    baseline: { status, fallbackTested: false },
  };
}

// ── Impure runner (stylelint; deterministic, no browser/network) ─────────────

async function violationsAt(files, available) {
  const stylelint = (await import("stylelint")).default;
  const res = await stylelint.lint({
    files,
    config: {
      plugins: ["stylelint-plugin-use-baseline"],
      rules: { "plugin/use-baseline": [true, { available }] },
    },
  });
  const feats = [];
  for (const r of res.results) for (const w of r.warnings) feats.push(w.text.replace(/\s+plugin\/use-baseline$/, ""));
  return feats;
}

/** Scan → classify → evaluate → report. Exposed for programmatic use and the test. */
export async function runBaselineGate({ css, target = "widely" }) {
  const belowWidely = await violationsAt(css, "widely");
  let status = "widely";
  if (belowWidely.length > 0) {
    const belowNewly = await violationsAt(css, "newly");
    status = classify(belowWidely.length, belowNewly.length);
  }
  return evaluateBaseline(status, target, belowWidely);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const css = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.BASELINE_CSS || "dist/**/*.css");
  const target = (process.env.BASELINE_TARGET || "widely").trim();
  if (target !== "widely" && target !== "newly") {
    console.error(`✗ baseline-gate: $BASELINE_TARGET must be "widely" or "newly" (got "${target}")`);
    process.exit(2);
  }

  const report = await runBaselineGate({ css: resolve(process.cwd(), css), target });
  if (process.env.BASELINE_REPORT) {
    await writeFile(resolve(process.env.BASELINE_REPORT), JSON.stringify(report, null, 2) + "\n");
  }

  const line = `baseline-gate: shipped CSS is Baseline "${report.status}" (${report.offenders.length} feature(s) below widely) · target "${target}"`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const o of report.offenders) console.error(`  · ${o}`);
    console.error(`  guard newer features behind an @supports feature query (the tested fallback), or lower $BASELINE_TARGET.`);
    process.exit(1);
  }
  console.log(`✓ ${line}`);
  for (const o of report.offenders) console.log(`  · ${o}`);
}

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ baseline-gate: error —", e.stack || e.message); process.exit(1); });
}
