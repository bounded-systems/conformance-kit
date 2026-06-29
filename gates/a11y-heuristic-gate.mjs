#!/usr/bin/env node
// a11y-heuristic-gate — MACHINE accessibility heuristic pass over built pages.
//
//   node gates/a11y-heuristic-gate.mjs [distDir]          # static-only runner (default)
//   AXE_RUNNER=playwright node gates/a11y-heuristic-gate.mjs [distDir]  # full browser pass
//
// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  HONEST LABELING — READ BEFORE CITING THIS GATE                            ║
// ║                                                                              ║
// ║  This is an AGENT/STATIC HEURISTIC review, NOT AT-user testing.             ║
// ║  It checks machine-readable accessibility properties:                        ║
// ║    • ARIA landmark presence (static DOM parse)                               ║
// ║    • Interactive-element accessible names (static DOM parse)                 ║
// ║    • Heading hierarchy integrity (static DOM parse)                          ║
// ║    • Skip-navigation pattern (static DOM parse)                              ║
// ║    • Image alt attributes (static DOM parse)                                 ║
// ║    • Language attribute (static DOM parse)                                   ║
// ║    • Positive tabindex warning (static DOM parse)                            ║
// ║    • Page title presence (static DOM parse)                                  ║
// ║    • [playwright runner] Accessibility tree snapshot (roles/names/states)    ║
// ║    • [playwright runner] axe-core corroboration (WCAG 2.x A/AA)              ║
// ║                                                                              ║
// ║  A clean run RAISES THE FLOOR but does NOT replace:                         ║
// ║    — Manual screen reader testing (NVDA+Firefox, JAWS+Chrome, VoiceOver)    ║
// ║    — Manual keyboard-only navigation of complete user flows                  ║
// ║    — Usability testing with real AT users                                    ║
// ║    — A full WCAG 2.2 AA audit signed off by an independent assessor          ║
// ║                                                                              ║
// ║  `a11y.wcag22-aa-manual` stays `not-assessed` — this gate cannot clear it.  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// Config (all optional):
//   argv[2] / $DIST          built output dir            (default: "dist")
//   $A11Y_PAGES              comma list of page paths    (default: all *.html in dist)
//   $A11Y_RUNNER             static | playwright         (default: static)
//   $A11Y_REPORT             path to write JSON report   (default: none)
//   $A11Y_KNOWN_LANDMARKS    comma list of extra landmark roles to accept as nav
//
// Evidence key: `agentHeuristic`
// Report field `evidenceType` = "agent/static heuristic review — NOT AT-user testing"

import { readFile, readdir, access, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, resolve, extname } from "node:path";
import { parseHTML } from "linkedom";

// ── Pure static checks (no browser) ──────────────────────────────────────────

export const EVIDENCE_TYPE = "agent/static heuristic review — NOT AT-user testing";
export const HONEST_WARNING =
  "This gate checks machine-readable accessibility properties. " +
  "It DOES NOT substitute for AT-user testing, manual screen reader testing, " +
  "or a WCAG 2.2 AA audit verified by an independent assessor.";

/** Accessible name computation (heuristic; covers most common patterns). */
function accessibleName(el) {
  return (
    el.getAttribute("aria-labelledby") ||
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    (el.tagName === "INPUT" ? el.getAttribute("placeholder") : null) ||
    (el.textContent || "").trim()
  ).trim();
}

/** Check that element has a non-empty accessible name. */
function hasName(el) {
  return accessibleName(el).length > 0;
}

/** Extract the landmark roles + semantic elements that serve as landmarks. */
function getLandmarks(document) {
  const roles = {
    main: 0, navigation: 0, banner: 0, contentinfo: 0,
    search: 0, complementary: 0, form: 0, region: 0,
  };
  // Semantic HTML elements that map to landmark roles
  const queries = [
    { tag: "main", role: "main" },
    { tag: "nav", role: "navigation" },
    { tag: "header:not([role])", role: "banner" },
    { tag: "footer:not([role])", role: "contentinfo" },
    { tag: "search", role: "search" },
    { tag: "aside", role: "complementary" },
    { tag: "form[aria-label],form[aria-labelledby]", role: "form" },
    { tag: "section[aria-label],section[aria-labelledby]", role: "region" },
  ];
  for (const { tag, role } of queries) {
    roles[role] += document.querySelectorAll(tag).length;
  }
  // Explicit role attributes
  for (const el of document.querySelectorAll("[role]")) {
    const r = (el.getAttribute("role") || "").trim().toLowerCase();
    if (r in roles) roles[r]++;
  }
  return roles;
}

/**
 * Run the static heuristic checks on one page's HTML.
 * Returns { page, findings, counts }.
 */
export function checkPage(html, pagePath) {
  const { document } = parseHTML(html);
  const findings = []; // { severity, code, detail }
  const err = (code, detail) => findings.push({ severity: "error", code, detail });
  const warn = (code, detail) => findings.push({ severity: "warn", code, detail });

  // ── 1. Language ──────────────────────────────────────────────────────────
  const htmlEl = document.documentElement;
  const lang = htmlEl ? htmlEl.getAttribute("lang") : null;
  if (!lang || lang.trim().length === 0) {
    err("LANG_MISSING", `${pagePath}: <html> has no lang attribute — WCAG 3.1.1`);
  }

  // ── 2. Page title ────────────────────────────────────────────────────────
  const title = document.querySelector("title");
  if (!title || !title.textContent.trim()) {
    err("TITLE_MISSING", `${pagePath}: <title> is absent or empty — WCAG 2.4.2`);
  }

  // ── 3. Landmarks ─────────────────────────────────────────────────────────
  const landmarks = getLandmarks(document);
  if (landmarks.main === 0) {
    err("LANDMARK_MAIN_MISSING", `${pagePath}: no <main> landmark — screen readers need a skip target`);
  }
  if (landmarks.main > 1) {
    warn("LANDMARK_MAIN_MULTIPLE", `${pagePath}: ${landmarks.main} <main> elements — only one allowed`);
  }
  if (landmarks.navigation === 0) {
    warn("LANDMARK_NAV_MISSING", `${pagePath}: no <nav> landmark — screen readers cannot navigate by landmark`);
  }
  if (landmarks.banner === 0) {
    warn("LANDMARK_BANNER_MISSING", `${pagePath}: no <header> (banner) landmark`);
  }
  if (landmarks.contentinfo === 0) {
    warn("LANDMARK_CONTENTINFO_MISSING", `${pagePath}: no <footer> (contentinfo) landmark`);
  }

  // ── 4. Heading hierarchy ─────────────────────────────────────────────────
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({
    level: parseInt(h.tagName[1], 10),
    text: (h.textContent || "").trim().slice(0, 60),
  }));
  if (headings.length === 0) {
    warn("HEADING_NONE", `${pagePath}: no headings found — navigation by heading impossible`);
  } else {
    if (headings.filter((h) => h.level === 1).length === 0) {
      err("HEADING_H1_MISSING", `${pagePath}: no h1 — WCAG 1.3.1 / screen reader document title`);
    }
    if (headings.filter((h) => h.level === 1).length > 1) {
      warn("HEADING_H1_MULTIPLE", `${pagePath}: ${headings.filter((h) => h.level === 1).length} h1 elements`);
    }
    let prevLevel = 0;
    for (const { level, text } of headings) {
      if (prevLevel > 0 && level > prevLevel + 1) {
        warn("HEADING_SKIP", `${pagePath}: heading skip h${prevLevel}→h${level} ("${text}") — WCAG 1.3.1`);
      }
      prevLevel = level;
    }
  }

  // ── 5. Skip navigation ───────────────────────────────────────────────────
  const firstLinks = [...document.querySelectorAll("a[href]")].slice(0, 5);
  const hasSkip = firstLinks.some((a) => {
    const href = a.getAttribute("href") || "";
    const text = (a.textContent || "").toLowerCase();
    return (href.startsWith("#") && /skip|jump|main|content/i.test(text)) ||
      /skip.*(nav|content|main)/i.test(text);
  });
  if (!hasSkip && (document.querySelectorAll("nav").length > 0 || document.querySelectorAll("[role=navigation]").length > 0)) {
    warn("SKIP_NAV_MISSING", `${pagePath}: no skip-navigation link — keyboard users must tab through every nav item`);
  }

  // ── 6. Interactive elements — accessible names ───────────────────────────
  const buttons = [...document.querySelectorAll("button")];
  const namedButtons = buttons.filter(hasName);
  if (namedButtons.length < buttons.length) {
    const unnamed = buttons.length - namedButtons.length;
    err("BUTTON_UNNAMED", `${pagePath}: ${unnamed} button(s) with no accessible name — WCAG 4.1.2`);
  }

  const links = [...document.querySelectorAll("a[href]")];
  const namedLinks = links.filter(hasName);
  if (namedLinks.length < links.length) {
    const unnamed = links.length - namedLinks.length;
    err("LINK_UNNAMED", `${pagePath}: ${unnamed} link(s) with no accessible name — WCAG 2.4.6 / 4.1.2`);
  }

  const inputs = [...document.querySelectorAll("input:not([type=hidden]),select,textarea")];
  let unnamedInputs = 0;
  for (const input of inputs) {
    const id = input.getAttribute("id");
    const hasLabel = id && document.querySelector(`label[for="${id}"]`);
    const hasAriaLabel = input.getAttribute("aria-label") || input.getAttribute("aria-labelledby");
    const hasTitle = input.getAttribute("title");
    if (!hasLabel && !hasAriaLabel && !hasTitle) unnamedInputs++;
  }
  if (unnamedInputs > 0) {
    err("INPUT_UNLABELED", `${pagePath}: ${unnamedInputs} form input(s) with no associated label — WCAG 1.3.1 / 4.1.2`);
  }

  // ── 7. Images — alt text ─────────────────────────────────────────────────
  const imgs = [...document.querySelectorAll("img")];
  let imgsNoAlt = 0;
  for (const img of imgs) {
    if (!img.hasAttribute("alt")) imgsNoAlt++;
  }
  if (imgsNoAlt > 0) {
    err("IMG_NO_ALT", `${pagePath}: ${imgsNoAlt} <img>(s) with no alt attribute — WCAG 1.1.1`);
  }

  // ── 8. Tabindex abuse ─────────────────────────────────────────────────────
  const positiveTabindex = [...document.querySelectorAll("[tabindex]")].filter((el) => {
    const t = parseInt(el.getAttribute("tabindex"), 10);
    return t > 0;
  });
  if (positiveTabindex.length > 0) {
    warn("TABINDEX_POSITIVE", `${pagePath}: ${positiveTabindex.length} element(s) with positive tabindex — disrupts natural focus order — WCAG 2.4.3`);
  }

  // ── 9. Focus ring — inline style trap ────────────────────────────────────
  const focusKillers = [...document.querySelectorAll("[style]")].filter((el) => {
    const s = (el.getAttribute("style") || "").replace(/\s/g, "");
    return s.includes("outline:none") || s.includes("outline:0");
  });
  if (focusKillers.length > 0) {
    err("FOCUS_RING_REMOVED_INLINE", `${pagePath}: ${focusKillers.length} element(s) with inline outline:none/0 — WCAG 2.4.11`);
  }

  // ── 10. ARIA roles — basic sanity ─────────────────────────────────────────
  const invalidAriaRoles = [];
  const VALID_ROLES = new Set([
    "alert", "alertdialog", "application", "article", "banner", "blockquote", "button",
    "caption", "cell", "checkbox", "code", "columnheader", "combobox", "comment",
    "complementary", "contentinfo", "definition", "deletion", "dialog", "directory",
    "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
    "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem",
    "log", "main", "mark", "marquee", "math", "menu", "menubar", "menuitem",
    "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none", "note", "option",
    "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region",
    "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator",
    "slider", "spinbutton", "status", "strong", "subscript", "suggestion",
    "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term",
    "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
  ]);
  for (const el of document.querySelectorAll("[role]")) {
    const roles = (el.getAttribute("role") || "").trim().split(/\s+/);
    for (const r of roles) {
      if (r && !VALID_ROLES.has(r)) invalidAriaRoles.push(r);
    }
  }
  if (invalidAriaRoles.length > 0) {
    err("ARIA_INVALID_ROLE", `${pagePath}: invalid ARIA role(s): ${[...new Set(invalidAriaRoles)].join(", ")} — WCAG 4.1.2`);
  }

  const counts = {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
    landmarks: Object.values(landmarks).reduce((a, b) => a + b, 0),
    headings: headings.length,
    buttons: buttons.length,
    links: links.length,
    images: imgs.length,
  };

  return { page: pagePath, findings, counts, landmarks, headings };
}

// ── Playwright runner — accessibility tree snapshot + axe corroboration ──────

async function collectWithPlaywright(pages, { dist, tags }) {
  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import("playwright"));
    ({ default: AxeBuilder } = await import("@axe-core/playwright"));
  } catch (e) {
    throw new Error(
      "playwright runner needs `playwright` + `@axe-core/playwright` installed. " + e.message,
    );
  }
  const { default: { readFile: rf } } = await import("node:fs/promises").then(m => ({ default: m }));
  const { createServer: cs } = await import("node:http").then(m => m);

  const srv = await startServer(dist);
  const browser = await chromium.launch();
  const out = new Map();
  try {
    const ctx = await browser.newContext();
    for (const page of pages) {
      const pg = await ctx.newPage();
      await pg.goto(`${srv.origin}/${page}`, { waitUntil: "load" });

      // Accessibility tree snapshot
      let treeSnapshot = null;
      try {
        treeSnapshot = await pg.accessibility.snapshot();
      } catch (_) {
        // page.accessibility.snapshot() is deprecated in newer Playwright — fall back to evaluate
        treeSnapshot = await pg.evaluate(() => {
          const nodes = [];
          document.querySelectorAll("[role], main, nav, header, footer, h1, h2, h3, h4, button, a[href], input, select, textarea").forEach(el => {
            nodes.push({
              role: el.getAttribute("role") || el.tagName.toLowerCase(),
              name: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 60) || "",
              hidden: el.getAttribute("aria-hidden") === "true",
            });
          });
          return nodes;
        });
      }

      // Axe corroboration
      let axeViolations = [];
      try {
        const results = await new AxeBuilder({ page: pg }).withTags(tags).analyze();
        axeViolations = results.violations;
      } catch (_) {
        // Axe optional
      }

      out.set(page, { treeSnapshot, axeViolations });
      await pg.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  return out;
}

// ── Static file server (shared with playwright runner) ───────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
  ".mjs": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

async function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let file = join(root, urlPath);
      if (urlPath.endsWith("/")) file = join(file, "index.html");
      let buf;
      try { buf = await readFile(file); }
      catch { try { buf = await readFile(file + ".html"); file += ".html"; } catch { res.writeHead(404); return res.end("not found"); } }
      const ext = extname(file).toLowerCase();
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(buf);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// ── HTML walker ───────────────────────────────────────────────────────────────

async function walkHtml(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(abs, base));
    else if (e.name.endsWith(".html")) out.push(relative(base, abs).replace(/\\/g, "/"));
  }
  return out;
}

// ── Summarise ─────────────────────────────────────────────────────────────────

export function summarize(pageResults, { runner = "static" } = {}) {
  const totals = { errors: 0, warnings: 0 };
  for (const p of pageResults) {
    totals.errors += p.findings.filter((f) => f.severity === "error").length;
    totals.warnings += p.findings.filter((f) => f.severity === "warn").length;
  }
  return {
    tool: "a11y-heuristic-gate",
    version: "1.0.0",
    runner,
    evidenceType: EVIDENCE_TYPE,
    warning: HONEST_WARNING,
    generatedAt: new Date().toISOString(),
    pages: pageResults,
    totals,
    // The envelope lone's `a11y.agent-heuristic-review` evaluator reads.
    agentHeuristic: {
      landmarksPresent: pageResults.every((p) => (p.landmarks?.main ?? 0) > 0),
      interactiveNamesClean: pageResults.every((p) =>
        !p.findings.some((f) => ["BUTTON_UNNAMED", "LINK_UNNAMED", "INPUT_UNLABELED"].includes(f.code))
      ),
      headingHierarchyClean: pageResults.every((p) =>
        !p.findings.some((f) => ["HEADING_H1_MISSING", "HEADING_SKIP"].includes(f.code))
      ),
      imagesAltClean: pageResults.every((p) =>
        !p.findings.some((f) => f.code === "IMG_NO_ALT")
      ),
      focusRingClean: pageResults.every((p) =>
        !p.findings.some((f) => f.code === "FOCUS_RING_REMOVED_INLINE")
      ),
      errors: totals.errors,
      warnings: totals.warnings,
      pages: pageResults.length,
    },
    passed: totals.errors === 0,
  };
}

// ── Runner entry point ────────────────────────────────────────────────────────

export async function runA11yHeuristicGate({ dist, pages, runner = "static", tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }) {
  const htmlFiles = pages && pages.length ? pages : (await walkHtml(dist)).sort();

  const pageResults = [];
  let playwrightData = null;

  if (runner === "playwright") {
    playwrightData = await collectWithPlaywright(htmlFiles, { dist, tags });
  }

  for (const page of htmlFiles) {
    const html = await readFile(join(dist, page), "utf8");
    const result = checkPage(html, page);

    if (playwrightData && playwrightData.has(page)) {
      const { treeSnapshot, axeViolations } = playwrightData.get(page);
      result.accessibilityTree = treeSnapshot;
      result.axeCorroboration = {
        violations: axeViolations.length,
        serious: axeViolations.filter((v) => v.impact === "serious").length,
        critical: axeViolations.filter((v) => v.impact === "critical").length,
      };
      // Add axe-critical and axe-serious to findings
      for (const v of axeViolations) {
        if (v.impact === "critical" || v.impact === "serious") {
          result.findings.push({
            severity: "error",
            code: `AXE_${v.impact.toUpperCase()}`,
            detail: `${page}: axe [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s))`,
          });
        }
      }
    }

    pageResults.push(result);
  }

  return summarize(pageResults, { runner });
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const dist = resolve(
    process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.DIST || "dist"
  );
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) {
    console.error(`✗ a11y-heuristic-gate: ${dist} not found — build first.`);
    process.exit(2);
  }

  const runner = (process.env.A11Y_RUNNER || "static").trim();
  const tags = (process.env.AXE_TAGS || "wcag2a,wcag2aa,wcag21aa,wcag22aa").split(",").map((s) => s.trim()).filter(Boolean);
  let pages = (process.env.A11Y_PAGES || "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean);
  if (pages.length === 0) pages = null;

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  a11y-heuristic-gate — AGENT/STATIC HEURISTIC REVIEW        ║");
  console.log("║  NOT a substitute for AT-user testing or WCAG 2.2 AA audit  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  runner: ${runner} · dist: ${dist}`);
  console.log("");

  const report = await runA11yHeuristicGate({ dist, pages, runner, tags });

  if (process.env.A11Y_REPORT) {
    await writeFile(resolve(process.env.A11Y_REPORT), JSON.stringify(report, null, 2) + "\n");
    console.log(`  ↳ wrote ${process.env.A11Y_REPORT}`);
  }

  for (const p of report.pages) {
    const errors = p.findings.filter((f) => f.severity === "error").length;
    const warns = p.findings.filter((f) => f.severity === "warn").length;
    const mark = errors ? "✗" : "✓";
    console.log(`  ${mark} ${p.page} — ${errors} error(s), ${warns} warning(s)`);
    for (const f of p.findings) {
      const icon = f.severity === "error" ? "    ✗" : "    ⚠";
      console.log(`${icon} [${f.code}] ${f.detail}`);
    }
    if (p.axeCorroboration) {
      console.log(`    axe: ${p.axeCorroboration.critical} critical, ${p.axeCorroboration.serious} serious`);
    }
  }

  console.log("");
  console.log(`Totals: ${report.totals.errors} error(s), ${report.totals.warnings} warning(s) across ${report.pages.length} page(s)`);
  console.log(`Evidence type: ${report.evidenceType}`);
  console.log(`Warning: ${report.warning}`);
  console.log("");

  if (!report.passed) {
    console.error(`✗ a11y-heuristic-gate: ${report.totals.errors} error finding(s) — see details above.`);
    process.exit(1);
  }
  console.log(`✓ a11y-heuristic-gate: 0 errors across ${report.pages.length} page(s) (${report.totals.warnings} warning(s)).`);
  console.log(`  Evidence type: ${report.evidenceType}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ a11y-heuristic-gate: error —", e.stack || e.message); process.exit(1); });
}
