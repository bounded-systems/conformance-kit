#!/usr/bin/env node
// HTML-validity gate — turns "the Nu HTML Checker passed once" into a
// CONTINUOUSLY-ENFORCED member of the conformance contract. It runs vnu (the Nu
// Html Checker, the reference HTML conformance checker, as a self-contained Java
// jar — headless, no browser, no network) over a project's BUILT pages and FAILS
// CLOSED (exit 1) when the error count exceeds a configurable threshold (default 0).
// The machine-readable result is exactly the shape lone's conformance() model
// consumes for `html.validator-clean` (`{ errors }`), so a clean run lets a site
// honestly assert that criterion — and a regression turns CI red.
//
//   node gates/html-validator-gate.mjs [distDir]   # build gate (exit 1 over threshold)
//
// Everything is config-driven; NOTHING about any one site is hard-coded:
//   argv[2] / $HTML_DIST       built output dir                     (default: "dist")
//   $HTML_PAGES               comma list of page paths under dist   (default: every *.html)
//   $HTML_THRESHOLD           highest tolerated error count         (default: 0)
//   $HTML_REPORT              path to write the JSON report         (default: none)
//
// Requires a JRE on PATH (CI: actions/setup-java; the jar ships with `vnu-jar`).
// The pure parse/evaluation functions are exported for unit testing without Java.
import { writeFile, access, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// ── Pure core (Java-free; unit-testable) ─────────────────────────────────────

/** Extract error-type messages from a vnu `--format json` payload (string or object). */
export function parseVnu(payload) {
  const json = typeof payload === "string" ? JSON.parse(payload || '{"messages":[]}') : (payload || {});
  const messages = Array.isArray(json.messages) ? json.messages : [];
  return messages.filter((m) => m && m.type === "error");
}

/** Evaluate parsed errors against the threshold. Pure: (errors[], threshold) → report. */
export function evaluateHtml(errors, threshold = 0) {
  const count = errors.length;
  return {
    passed: count <= threshold,
    threshold,
    errors: count,
    // The envelope lone's conformance() consumes for `html.validator-clean`.
    htmlValidator: { errors: count },
    detail: errors.slice(0, 20).map((e) => ({
      page: (e.url || "").replace(/^file:/, ""),
      line: e.lastLine,
      message: e.message,
    })),
  };
}

// ── Impure runner ────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

async function walkHtml(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(p, base));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** Run vnu over the given files; returns the error-type messages. vnu writes its
 *  JSON report to stderr and exits non-zero when errors exist, so we read stderr
 *  regardless of exit code. */
export function runVnu(files) {
  const jar = String(require("vnu-jar"));
  const res = spawnSync("java", ["-jar", jar, "--errors-only", "--format", "json", ...files], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`cannot run vnu (${res.error.message}). Is a JRE on PATH?`);
  return parseVnu(res.stderr || '{"messages":[]}');
}

/** Walk → vnu → evaluate → report. Exposed for programmatic use and the kit's test. */
export async function runHtmlGate({ dist, pages, threshold = 0 }) {
  const files = pages && pages.length
    ? pages.map((p) => resolve(dist, p))
    : (await walkHtml(resolve(dist))).sort();
  const report = evaluateHtml(runVnu(files), threshold);
  report.pages = files.length;
  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const dist = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.HTML_DIST || "dist");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) { console.error(`✗ html-validator-gate: ${dist} not found — build first.`); process.exit(2); }

  const threshold = Number.parseInt(process.env.HTML_THRESHOLD ?? "0", 10);
  if (!Number.isInteger(threshold) || threshold < 0) {
    console.error(`✗ html-validator-gate: $HTML_THRESHOLD must be an integer ≥ 0 (got "${process.env.HTML_THRESHOLD}")`);
    process.exit(2);
  }
  const pages = (process.env.HTML_PAGES || "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean);

  const report = await runHtmlGate({ dist, pages, threshold });
  if (process.env.HTML_REPORT) {
    await writeFile(resolve(process.env.HTML_REPORT), JSON.stringify(report, null, 2) + "\n");
  }

  const line = `html-validator-gate: ${report.errors} Nu HTML Checker error(s) over ${report.pages} built page(s) · threshold ${threshold}`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const d of report.detail) console.error(`  ${d.page} L${d.line}: ${d.message}`);
    process.exit(1);
  }
  console.log(`✓ ${line}`);
}

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ html-validator-gate: error —", e.stack || e.message); process.exit(1); });
}
