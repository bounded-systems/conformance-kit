#!/usr/bin/env node
// axe accessibility gate — turns "we ran axe once" into a CONTINUOUSLY-ENFORCED
// member of the conformance contract. It loads each BUILT page in a real browser,
// runs axe-core with the WCAG 2.x A/AA ruleset, and FAILS CLOSED (exit 1) on any
// violation at or above a configurable impact threshold (default: serious). The
// machine-readable result it emits is exactly the shape lone's conformance() model
// consumes for `a11y.axe-serious-critical` (`{ serious, critical }`), so a clean run
// is what lets a site honestly assert that criterion — and a regression turns CI red.
//
//   node gates/axe-gate.mjs [distDir]          # build gate (exit 1 on any blocking violation)
//
// Pure data in → typed report out. The browser is the ONLY impurity: axe needs real
// layout/computed-style (e.g. colour-contrast, target-size), so a DOM shim is not
// enough. Two interchangeable runners drive a real engine:
//   - playwright (default) — `@axe-core/playwright` + Playwright's bundled Chromium.
//     The CI runner: hermetic, headless, cross-platform.
//   - tezcatl              — macOS-native headless WebKit. Injects axe.min.js into the
//     served page and reads the result back. The LOCAL runner (no Chromium download).
// Both serve dist/ over an ephemeral localhost HTTP origin first, so absolute asset
// paths (`/assets/…css`, fonts) resolve — running file:// would strip the styles and
// fabricate layout-dependent violations.
//
// Everything is config-driven; NOTHING about any one site is hard-coded:
//   argv[2] / $DIST            built output dir                  (default: "dist")
//   $AXE_PAGES                 comma list of page paths under dist to scan
//                              (default: every *.html discovered in dist)
//   $AXE_TAGS                  comma list of axe ruleset tags
//                              (default: wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa)
//   $AXE_IMPACT_THRESHOLD      lowest impact that BLOCKS: minor|moderate|serious|critical
//                              (default: serious)
//   $AXE_RUNNER               playwright | tezcatl              (default: playwright)
//   $AXE_REPORT               path to write the JSON report     (default: none → stdout only)
//   $AXE_TEZCATL_WAIT         ms to let axe settle, tezcatl runner (default: 3000)
//
// The pure evaluation/report functions are exported for unit testing without a browser.
import { readFile, readdir, access, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// ── Pure core (browser-free; unit-testable) ──────────────────────────────────

/** Impact levels, weakest → strongest. A violation BLOCKS when its impact ranks at
 *  or above the configured threshold. axe may report `impact: null`; such findings
 *  rank below `minor` and so never block (but are still counted/reported). */
export const IMPACT_ORDER = ["minor", "moderate", "serious", "critical"];
export const DEFAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
export const DEFAULT_THRESHOLD = "serious";

export const impactRank = (impact) => IMPACT_ORDER.indexOf(impact); // -1 when null/unknown
export const blocksAt = (impact, threshold) => {
  const t = impactRank(threshold);
  return t >= 0 && impactRank(impact) >= t;
};

/** Normalise one axe violation to the compact, stable shape we report/persist. */
export function normalizeViolation(v) {
  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  const targets = nodes
    .map((n) => (Array.isArray(n.target) ? n.target.join(" ") : String(n.target ?? "")))
    .filter(Boolean);
  return {
    id: v.id,
    impact: v.impact ?? null,
    help: v.help ?? "",
    helpUrl: v.helpUrl ?? "",
    nodes: nodes.length,
    targets: targets.slice(0, 8), // cap; full detail lives in axe's own helpUrl
  };
}

/** Empty {critical,serious,moderate,minor,unknown} counter. */
const emptyCounts = () => ({ critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 });

/** Evaluate one page's raw axe violations against the threshold. */
export function evaluatePage(page, rawViolations, threshold = DEFAULT_THRESHOLD) {
  const violations = (rawViolations ?? []).map(normalizeViolation);
  const counts = emptyCounts();
  let blocking = 0;
  for (const v of violations) {
    counts[v.impact && v.impact in counts ? v.impact : "unknown"]++;
    if (blocksAt(v.impact, threshold)) blocking++;
  }
  // Group by impact for the machine-readable report (serious/critical first).
  const byImpact = {};
  for (const lvl of [...IMPACT_ORDER].reverse()) {
    const inLvl = violations.filter((v) => v.impact === lvl);
    if (inLvl.length) byImpact[lvl] = inLvl;
  }
  const unknown = violations.filter((v) => impactRank(v.impact) < 0);
  if (unknown.length) byImpact.unknown = unknown;
  return { page, counts, blocking, violations: byImpact };
}

/** Fold per-page evaluations into the whole-run report consumed by conformance(). */
export function summarize(pageResults, { threshold = DEFAULT_THRESHOLD, tags = DEFAULT_TAGS, runner = "playwright" } = {}) {
  const totals = emptyCounts();
  let blocking = 0;
  for (const p of pageResults) {
    for (const k of Object.keys(totals)) totals[k] += p.counts[k];
    blocking += p.blocking;
  }
  return {
    tool: "axe-core",
    runner,
    standard: "WCAG 2.x A/AA (axe ruleset)",
    tags,
    impactThreshold: threshold,
    generatedAt: new Date().toISOString(),
    pages: pageResults,
    totals,
    // The exact envelope lone's `a11y.axe-serious-critical` evaluator reads.
    axe: { serious: totals.serious, critical: totals.critical },
    blocking, // count of violations at/above threshold across all pages
    passed: blocking === 0,
  };
}

// ── dist discovery + static origin (shared by both runners) ──────────────────

async function walkHtml(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(abs, base));
    else if (e.name.endsWith(".html")) out.push(relative(base, abs).replace(/\\/g, "/"));
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
  ".mjs": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".xml": "application/xml",
  ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".pdf": "application/pdf",
};

/**
 * Serve `root` over an ephemeral localhost origin. When `inject` is set, HTML
 * responses get axe-core + a runner appended before </body>, and `/__axe-core.js`
 * serves the axe source — used by the tezcatl runner, which cannot inject async JS
 * itself. Returns { origin, close }.
 */
async function startServer(root, { inject = false, tags = DEFAULT_TAGS } = {}) {
  let axeSrc = "";
  if (inject) {
    const require = createRequire(import.meta.url);
    axeSrc = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  }
  const runnerScript =
    `<script src="/__axe-core.js"></script><script>` +
    `window.addEventListener("load",function(){setTimeout(function(){` +
    `axe.run(document,{runOnly:{type:"tag",values:${JSON.stringify(tags)}}}).then(function(r){` +
    `var e=document.createElement("script");e.type="application/json";e.id="__axe_results";` +
    `e.textContent=JSON.stringify({violations:r.violations});document.documentElement.appendChild(e);` +
    `}).catch(function(err){var e=document.createElement("script");e.type="application/json";` +
    `e.id="__axe_results";e.textContent=JSON.stringify({error:String(err)});document.documentElement.appendChild(e);});` +
    `},150);});</script>`;

  const server = createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (inject && urlPath === "/__axe-core.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        return res.end(axeSrc);
      }
      let file = join(root, urlPath);
      if (urlPath.endsWith("/")) file = join(file, "index.html");
      let buf;
      try { buf = await readFile(file); }
      catch { try { buf = await readFile(file + ".html"); file += ".html"; } catch { res.writeHead(404); return res.end("not found"); } }
      const ext = extname(file).toLowerCase();
      if (inject && ext === ".html") {
        let html = buf.toString("utf8");
        html = html.includes("</body>") ? html.replace("</body>", runnerScript + "</body>") : html + runnerScript;
        buf = Buffer.from(html, "utf8");
      }
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(buf);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// ── Runners: page → raw axe violations[] ─────────────────────────────────────

async function collectWithPlaywright(pages, { dist, tags }) {
  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import("playwright"));
    ({ default: AxeBuilder } = await import("@axe-core/playwright"));
  } catch (e) {
    throw new Error(
      "playwright runner needs `playwright` + `@axe-core/playwright` installed " +
      "(and `npx playwright install --with-deps chromium`). " + e.message,
    );
  }
  const srv = await startServer(dist, { inject: false });
  const browser = await chromium.launch();
  const out = new Map();
  try {
    const ctx = await browser.newContext();
    for (const page of pages) {
      const pg = await ctx.newPage();
      await pg.goto(`${srv.origin}/${page}`, { waitUntil: "load" });
      const results = await new AxeBuilder({ page: pg }).withTags(tags).analyze();
      out.set(page, results.violations);
      await pg.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  return out;
}

// Run tezcatl async (NOT execFileSync) — the static origin lives on this same event
// loop, so a blocking child would deadlock its own server. Resolves to trimmed stdout.
function tezcatl(args) {
  return new Promise((res, rej) => {
    const ch = spawn("tezcatl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("error", (e) => rej(new Error(`tezcatl not runnable (on PATH?): ${e.message}`)));
    ch.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error(`tezcatl exit ${code}: ${err.trim() || out.trim()}`))));
  });
}

async function collectWithTezcatl(pages, { dist, tags }) {
  const waitMs = Number(process.env.AXE_TEZCATL_WAIT || 3000);
  const readResults = `--eval=(function(){var e=document.getElementById('__axe_results');return e?e.textContent:'';})()`;
  const srv = await startServer(dist, { inject: true, tags });
  const out = new Map();
  try {
    for (const page of pages) {
      const url = `${srv.origin}/${page}`;
      let text = "";
      for (const attempt of [waitMs, waitMs * 2]) { // one retry with a longer settle window
        const raw = await tezcatl([url, `--wait=${attempt}`, readResults]);
        if (raw && raw !== "NORESULT") { text = raw; break; }
      }
      if (!text) throw new Error(`tezcatl: no axe result for ${page} (raise $AXE_TEZCATL_WAIT?)`);
      const parsed = JSON.parse(text);
      if (parsed.error) throw new Error(`axe failed on ${page}: ${parsed.error}`);
      out.set(page, parsed.violations || []);
    }
  } finally {
    await srv.close();
  }
  return out;
}

const RUNNERS = { playwright: collectWithPlaywright, tezcatl: collectWithTezcatl };

/**
 * Run the configured runner over `pages` of `dist` and return the summarized report.
 * Exposed for programmatic use (and the kit's own test) in addition to the CLI.
 */
export async function runAxeGate({ dist, pages, tags = DEFAULT_TAGS, threshold = DEFAULT_THRESHOLD, runner = "playwright" }) {
  const collect = RUNNERS[runner];
  if (!collect) throw new Error(`unknown runner "${runner}" (expected: ${Object.keys(RUNNERS).join(", ")})`);
  const raw = await collect(pages, { dist, tags });
  const pageResults = pages.map((p) => evaluatePage(p, raw.get(p) || [], threshold));
  return summarize(pageResults, { threshold, tags, runner });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const dist = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.DIST || "dist");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) { console.error(`✗ axe-gate: ${dist} not found — build first.`); process.exit(2); }

  const tags = (process.env.AXE_TAGS || DEFAULT_TAGS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = (process.env.AXE_IMPACT_THRESHOLD || DEFAULT_THRESHOLD).trim();
  if (!IMPACT_ORDER.includes(threshold)) {
    console.error(`✗ axe-gate: $AXE_IMPACT_THRESHOLD must be one of ${IMPACT_ORDER.join("|")} (got "${threshold}")`);
    process.exit(2);
  }
  const runner = (process.env.AXE_RUNNER || "playwright").trim();
  let pages = (process.env.AXE_PAGES || "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean);
  if (pages.length === 0) pages = (await walkHtml(dist)).sort();
  if (pages.length === 0) { console.error(`✗ axe-gate: no HTML pages found under ${dist}`); process.exit(2); }

  console.log(`axe-gate: ${runner} runner · ${pages.length} page(s) · tags [${tags.join(", ")}] · block ≥ ${threshold}`);
  const report = await runAxeGate({ dist, pages, tags, threshold, runner });

  if (process.env.AXE_REPORT) {
    await writeFile(resolve(process.env.AXE_REPORT), JSON.stringify(report, null, 2) + "\n");
    console.log(`  ↳ wrote ${process.env.AXE_REPORT}`);
  }

  for (const p of report.pages) {
    const tally = IMPACT_ORDER.map((l) => `${p.counts[l]} ${l}`).join(", ");
    const mark = p.blocking ? "✗" : "✓";
    console.log(`  ${mark} ${p.page} — ${tally}${p.counts.unknown ? `, ${p.counts.unknown} unknown` : ""}`);
    if (p.blocking) {
      for (const lvl of ["critical", "serious", "moderate", "minor"]) {
        for (const v of p.violations[lvl] || []) {
          if (!blocksAt(lvl, threshold)) continue;
          console.error(`      [${lvl}] ${v.id} — ${v.help} (${v.nodes} node(s)) ${v.helpUrl}`);
          for (const t of v.targets) console.error(`         · ${t}`);
        }
      }
    }
  }

  console.log("");
  if (!report.passed) {
    console.error(`✗ axe-gate: ${report.blocking} violation(s) at or above "${threshold}" across ${report.pages.length} page(s) (${report.totals.critical} critical, ${report.totals.serious} serious).`);
    process.exit(1);
  }
  console.log(`✓ axe-gate: ${report.pages.length} page(s) clean — 0 violations at or above "${threshold}" (axe ${tags.includes("wcag22aa") ? "WCAG 2.2 A/AA" : "WCAG A/AA"}).`);
}

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ axe-gate: error —", e.stack || e.message); process.exit(1); });
}
