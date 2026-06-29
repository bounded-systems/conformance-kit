#!/usr/bin/env node
// known-vulnerability gate — turns "npm audit looked fine once" into a
// CONTINUOUSLY-ENFORCED member of the conformance contract. It runs `npm audit`
// over a project's lockfile and FAILS CLOSED (exit 1) when the count of known
// critical/high advisories exceeds a configurable threshold (default 0). The
// machine-readable result is exactly the shape lone's conformance() model consumes
// for `security.no-critical-vulns` (`{ knownCriticalOrHighVulns }`), so a clean run
// is what lets a site honestly assert that criterion — and a new advisory turns CI red.
//
//   node gates/vuln-gate.mjs [projectDir]      # build gate (exit 1 when over threshold)
//
// Everything is config-driven; NOTHING about any one project is hard-coded:
//   argv[2] / $VULN_ROOT       project dir containing the lockfile   (default: ".")
//   $VULN_OMIT_DEV             "true" → audit production deps only    (default: "true")
//                             A static site SHIPS no runtime deps, so production scope
//                             == the deployed bytes; the build toolchain's own
//                             advisories are a separate concern. Set "false" to audit all.
//   $VULN_THRESHOLD           highest tolerated known critical/high   (default: 0)
//   $VULN_REPORT              path to write the JSON report           (default: none)
//
// The pure parse/evaluation functions are exported for unit testing without a network.
import { writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// ── Pure core (network-free; unit-testable) ──────────────────────────────────

/** Extract the known critical + high count from an `npm audit --json` payload.
 *  Tolerates both the v2 `metadata.vulnerabilities` shape and a missing field. */
export function parseAudit(json) {
  const v = (json && json.metadata && json.metadata.vulnerabilities) || {};
  const critical = v.critical || 0;
  const high = v.high || 0;
  return { critical, high, known: critical + high };
}

/** Evaluate a parsed audit against the threshold. Pure: (parsed, threshold) → report. */
export function evaluateVulns({ critical, high, known }, threshold = 0) {
  return {
    passed: known <= threshold,
    threshold,
    critical,
    high,
    knownCriticalOrHighVulns: known,
    // The envelope lone's conformance() consumes for `security.no-critical-vulns`.
    vulns: { knownCriticalOrHighVulns: known },
  };
}

// ── Impure runner ────────────────────────────────────────────────────────────

/** Run `npm audit --json` and return the parsed payload. npm exits non-zero when
 *  advisories exist, so we capture stdout regardless of exit code. */
export function runNpmAudit({ root = ".", omitDev = true } = {}) {
  const args = ["audit", "--json", ...(omitDev ? ["--omit=dev"] : [])];
  const res = spawnSync("npm", args, { cwd: resolve(root), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`cannot run npm audit (${res.error.message})`);
  if (!res.stdout) throw new Error(`npm audit produced no JSON (stderr: ${(res.stderr || "").slice(0, 300)})`);
  return JSON.parse(res.stdout);
}

/** Audit + evaluate → report. Exposed for programmatic use and the kit's own test. */
export function runVulnGate({ root = ".", omitDev = true, threshold = 0 } = {}) {
  return evaluateVulns(parseAudit(runNpmAudit({ root, omitDev })), threshold);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const root = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.VULN_ROOT || ".");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(resolve(root, "package-lock.json"))) && !(await exists(resolve(root, "npm-shrinkwrap.json")))) {
    console.error(`✗ vuln-gate: no package-lock.json under ${root} — nothing to audit.`);
    process.exit(2);
  }
  const omitDev = (process.env.VULN_OMIT_DEV ?? "true").trim() !== "false";
  const threshold = Number.parseInt(process.env.VULN_THRESHOLD ?? "0", 10);
  if (!Number.isInteger(threshold) || threshold < 0) {
    console.error(`✗ vuln-gate: $VULN_THRESHOLD must be an integer ≥ 0 (got "${process.env.VULN_THRESHOLD}")`);
    process.exit(2);
  }

  const report = runVulnGate({ root, omitDev, threshold });
  if (process.env.VULN_REPORT) {
    await writeFile(resolve(process.env.VULN_REPORT), JSON.stringify(report, null, 2) + "\n");
  }

  const scope = omitDev ? "production deps" : "all deps";
  const line = `vuln-gate: ${report.knownCriticalOrHighVulns} known critical/high in ${scope} (${report.critical} critical, ${report.high} high) · threshold ${threshold}`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    console.error(`  a known critical/high advisory exceeds the threshold — fix it, or (if accepted) raise $VULN_THRESHOLD.`);
    process.exit(1);
  }
  console.log(`✓ ${line}`);
}

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ vuln-gate: error —", e.stack || e.message); process.exit(1); });
}
