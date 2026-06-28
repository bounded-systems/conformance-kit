#!/usr/bin/env node
// SEO technical gate — turns the site's discoverability contract into an ENFORCEABLE
// check over the BUILT dist/. SEO "best practices" are usually advice you hope you
// followed; this gate fails closed (exit 1) the moment the built bytes break one.
//
//   node gates/seo-gate.mjs [distDir]      # build gate (exit 1 on any violation)
//
// What it enforces:
//   1. canonical  — every indexable page has exactly one <link rel="canonical">, and
//                   it is SELF-consistent: the canonical URL maps back to THIS file.
//   2. title      — every indexable page has a non-empty <title>, unique across pages.
//   3. description— every indexable page has a non-empty <meta name="description">,
//                   unique across pages.
//   4. noindex    — no indexable page carries an accidental robots `noindex` (the
//                   error page is the only place noindex is allowed/expected).
//   5. robots.txt — parses per RFC 9309: groups start with user-agent line(s); rules
//                   (allow/disallow) never precede a user-agent; Sitemap values are
//                   absolute URLs; the advertised sitemap resolves to a built file.
//   6. sitemap    — every <loc> in sitemap.xml resolves to a built page (canonicalised),
//                   and every URL shares the site's single origin.
//   7. links      — zero broken internal links across all pages.
//
// Pure + offline: reads dist/ only, no network. Zero-dep.
//
// Site-agnostic injection (all optional, neutral defaults):
//   argv[2] / $DIST       built output dir (default: "dist").
//   $SEO_ERROR_PAGE       the page exempt from canonical/title/desc + required to be
//                         noindex (default: "404.html").
//   $SEO_DEPLOY_SIDECARS  comma list of deploy-time paths to treat as live links
//                         (e.g. /rekor,/provenance.json,/resume.pdf).
import { readFile, readdir, access } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";

const dist = resolve(process.argv[2] || process.env.DIST || "dist");
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const ERROR_PAGE = process.env.SEO_ERROR_PAGE || "404.html";
// Deploy-time sidecars: written by the deploy workflow (not the local/hermetic
// build), so a link to one is resolvable rather than dead.
const DEPLOY_SIDECARS = (process.env.SEO_DEPLOY_SIDECARS || "/rekor,/provenance.json,/site.sha256")
  .split(",").map((s) => s.trim()).filter(Boolean);

let errors = 0;
const err = (m) => { console.error(`  ✗ ${m}`); errors++; };

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(abs));
    else if (e.name.endsWith(".html")) out.push(abs);
  }
  return out;
}

// Normalise a served path to a canonical key (drop index.html / .html / trailing /).
const canon = (p) => {
  let s = p.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s || "/";
};

// Resolve an internal href to "ok" / "dead" / "skip" (external/anchor/etc).
async function resolveHref(pageAbs, href) {
  if (!href || /^(https?:|mailto:|tel:|#|data:)/i.test(href)) return "skip";
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return "skip";
  if (DEPLOY_SIDECARS.some((s) => clean === s || clean.startsWith(s + "/"))) return "ok";
  const base = clean.startsWith("/") ? join(dist, clean) : resolve(dirname(pageAbs), clean);
  for (const cand of [base, base + ".html", join(base, "index.html")]) {
    if (await exists(cand)) return "ok";
  }
  return "dead";
}

const head = (html) => (html.match(/<head[\s\S]*?<\/head>/i) || [""])[0];

async function main() {
  if (!(await exists(dist))) { console.error(`✗ seo-gate: ${dist} not found — build first.`); process.exit(2); }

  const pages = (await walk(dist)).sort();
  const servedCanon = new Set(pages.map((p) => canon("/" + relative(dist, p))));

  const isIndexable = (rel) => rel !== ERROR_PAGE;

  const titles = new Map();        // title → first page (uniqueness)
  const descriptions = new Map();  // description → first page (uniqueness)
  let origin = null;               // the single canonical origin, learned from page 1

  // ---- per-page <head> contract -------------------------------------------------
  for (const pageAbs of pages) {
    const rel = relative(dist, pageAbs).replace(/\\/g, "/");
    const html = await readFile(pageAbs, "utf8");
    const h = head(html);

    const robotsMetas = [...h.matchAll(/<meta\s+name="robots"\s+content="([^"]*)"\s*\/?>/gi)].map((m) => m[1]);
    const hasNoindex = robotsMetas.some((c) => /\bnoindex\b/i.test(c));
    if (isIndexable(rel) && hasNoindex) err(`${rel}: indexable page carries robots noindex`);
    if (!isIndexable(rel) && !hasNoindex) err(`${rel}: error page should be noindex (missing robots noindex)`);

    if (!isIndexable(rel)) continue;

    const canons = [...h.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/gi)].map((m) => m[1]);
    if (canons.length !== 1) {
      err(`${rel}: ${canons.length} <link rel="canonical"> (want exactly 1)`);
    } else {
      const url = canons[0];
      let u;
      try { u = new URL(url); } catch { u = null; }
      if (!u) err(`${rel}: canonical is not an absolute URL — ${url}`);
      else {
        const thisOrigin = u.origin;
        if (origin === null) origin = thisOrigin;
        else if (thisOrigin !== origin) err(`${rel}: canonical origin ${thisOrigin} ≠ site origin ${origin}`);
        const want = canon("/" + rel);
        const got = canon(u.pathname);
        if (got !== want) err(`${rel}: canonical points at ${got} but this file serves ${want} (not self-consistent)`);
      }
    }

    const title = (h.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
    if (!title) err(`${rel}: empty or missing <title>`);
    else if (titles.has(title)) err(`${rel}: duplicate <title> (also in ${titles.get(title)}): "${title}"`);
    else titles.set(title, rel);

    let desc = null;
    for (const m of h.matchAll(/<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/gi)) desc = m[1];
    if (desc == null || !desc.trim()) err(`${rel}: empty or missing <meta name="description">`);
    else if (descriptions.has(desc.trim())) err(`${rel}: duplicate meta description (also in ${descriptions.get(desc.trim())})`);
    else descriptions.set(desc.trim(), rel);
  }

  // ---- robots.txt — RFC 9309 ------------------------------------------------------
  const robotsPath = join(dist, "robots.txt");
  if (!(await exists(robotsPath))) {
    err("robots.txt: missing from dist/");
  } else {
    const lines = (await readFile(robotsPath, "utf8")).split(/\r?\n/);
    let seenUserAgent = false;
    let groupOpen = false;
    const sitemaps = [];
    lines.forEach((raw, i) => {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) return;
      const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) { err(`robots.txt:${i + 1}: not a "field: value" record — ${raw.trim()}`); return; }
      const field = m[1].toLowerCase();
      const value = m[2].trim();
      if (field === "user-agent") { seenUserAgent = true; groupOpen = true; }
      else if (field === "allow" || field === "disallow") {
        if (!groupOpen) err(`robots.txt:${i + 1}: ${field} rule before any user-agent (RFC 9309 groups start with user-agent)`);
        if (value && !value.startsWith("/") && !value.startsWith("*")) err(`robots.txt:${i + 1}: ${field} path should start with "/" — ${value}`);
      }
      else if (field === "sitemap") {
        try { new URL(value); sitemaps.push(value); } catch { err(`robots.txt:${i + 1}: Sitemap is not an absolute URL — ${value}`); }
      }
      else if (field === "crawl-delay" || field === "host") { /* tolerated non-standard extensions */ }
      else { /* RFC 9309 §2.2.4: unrecognised fields are ignored, not an error */ }
    });
    if (!seenUserAgent) err("robots.txt: no user-agent group (RFC 9309 requires at least one group)");
    for (const sm of sitemaps) {
      const u = new URL(sm);
      if (origin && u.origin === origin) {
        const f = canon(u.pathname);
        const built = pages.some((p) => canon("/" + relative(dist, p)) === f) || (await exists(join(dist, u.pathname.replace(/^\//, ""))));
        if (!built) err(`robots.txt: advertised Sitemap ${sm} does not resolve to a built file`);
      }
    }
  }

  // ---- sitemap.xml — every <loc> resolves to a built page -------------------------
  const sitemapPath = join(dist, "sitemap.xml");
  if (!(await exists(sitemapPath))) {
    err("sitemap.xml: missing from dist/");
  } else {
    const xml = await readFile(sitemapPath, "utf8");
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (locs.length === 0) err("sitemap.xml: no <loc> entries");
    for (const loc of locs) {
      let u;
      try { u = new URL(loc); } catch { err(`sitemap.xml: <loc> is not an absolute URL — ${loc}`); continue; }
      if (origin && u.origin !== origin) err(`sitemap.xml: <loc> origin ${u.origin} ≠ site origin ${origin} — ${loc}`);
      const key = canon(u.pathname);
      if (!servedCanon.has(key)) err(`sitemap.xml: <loc> ${loc} does not resolve to a built page (${key})`);
    }
  }

  // ---- internal link graph — zero broken links ------------------------------------
  for (const pageAbs of pages) {
    const rel = relative(dist, pageAbs).replace(/\\/g, "/");
    const html = await readFile(pageAbs, "utf8");
    for (const a of html.matchAll(/<a\s[^>]*href="([^"]*)"/gi)) {
      const href = a[1];
      if ((await resolveHref(pageAbs, href)) === "dead") err(`${rel}: dead internal link → ${href}`);
    }
  }

  console.log("");
  if (errors) {
    console.error(`✗ seo-gate: ${errors} violation(s) across ${pages.length} built page(s).`);
    process.exit(1);
  }
  console.log(`✓ seo-gate: ${pages.length} page(s) — canonical/title/description/robots/sitemap/links all consistent (origin ${origin}).`);
}

main().catch((e) => { console.error("✗ seo-gate: error —", e.message); process.exit(1); });
