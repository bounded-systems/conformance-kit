#!/usr/bin/env node
// integrity · structure-audit — a deterministic, whole-page structure gate.
//
//   node integrity/structure-audit/audit.mjs <distDir> [--check]
//
// Validates the document STRUCTURE + reader survivability + the internal link
// graph, and extracts a content-addressed `structure.json` so the page skeleton is
// a pure function of source (drift fails CI under --check).
//
// Checks (errors fail the gate):
//   1. reader survivability (articles) — run Mozilla Readability (what Firefox
//      Reader runs); it must extract an article that still contains the <h1> and
//      isn't mostly-empty. The free test of "do the semantics survive the CSS being
//      stripped." Scoped to articles; list/error pages aren't reader targets.
//   2. outline — exactly one <h1>, no skipped heading levels (all pages).
//   3. landmarks — at most one <main>; a content page with none is a warning.
//   4. internal link-graph — every internal href resolves to a served file, an
//      in-page anchor, or a known deploy-time sidecar; dead links error, and a
//      served page reachable from nothing is an orphan (warn).
//
// Deterministic: same dist → byte-identical structure.json (sorted, hashed).
//
// Site-agnostic injection points (all optional, neutral defaults):
//   $STRUCTURE_AUDIT_SIDECARS  comma-separated deploy-time paths to treat as live
//                              (e.g. /resume.pdf), beyond the built-in set.
//   $STRUCTURE_ARTICLE_PREFIX  dir prefix whose pages are "articles" for the reader
//                              check (default "blog/"); its own index is excluded.
//   $STRUCTURE_ERROR_PAGE      the error page exempt from the <main>/orphan rules
//                              (default "404.html").
//   $STRUCTURE_BASELINE        path to the committed structure.json baseline
//                              (default: structure.json next to this script — so a
//                              vendored, hash-pinned copy keeps the baseline in the
//                              CONSUMER, not in the kit file).
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const dist = resolve(process.argv[2] || process.env.DIST || "dist");
const CHECK = process.argv.includes("--check");
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const ARTICLE_PREFIX = process.env.STRUCTURE_ARTICLE_PREFIX || "blog/";
const ERROR_PAGE = process.env.STRUCTURE_ERROR_PAGE || "404.html";

// Generated at deploy, so absent from a local build — treat as resolvable rather
// than dead. (The post-deploy edge check verifies they serve.) Consumers add their
// own deploy-time assets via STRUCTURE_AUDIT_SIDECARS (comma-separated), e.g.
// bd-site's /resume.pdf, which is print-to-pdf'd during deploy.
const DEPLOY_SIDECARS = ["/rekor", "/provenance.json", "/site.sha256",
  ...(process.env.STRUCTURE_AUDIT_SIDECARS || "").split(",").map((s) => s.trim()).filter(Boolean)];

async function walk(dir, ext) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(abs, ext));
    else if (e.name.endsWith(ext)) out.push(abs);
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

const pages = (await walk(dist, ".html")).sort();
const servedCanon = new Set(pages.map((p) => canon("/" + relative(dist, p))));
let errors = 0, warns = 0;
const err = (m) => { console.error(`  ✗ ${m}`); errors++; };
const warn = (m) => { console.error(`  ⚠ ${m}`); warns++; };

// Resolve an internal href to a canonical served key, or "ok"/"dead".
async function resolveHref(pageAbs, href) {
  if (!href || /^(https?:|mailto:|tel:|#|data:)/i.test(href)) return { kind: "skip" };
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return { kind: "skip" };
  if (DEPLOY_SIDECARS.some((s) => clean === s || clean.startsWith(s + "/"))) return { kind: "ok", key: canon(clean) };
  const base = clean.startsWith("/") ? join(dist, clean) : resolve(dirname(pageAbs), clean);
  for (const cand of [base, base + ".html", join(base, "index.html")]) {
    if (await exists(cand)) return { kind: "ok", key: canon("/" + relative(dist, cand)) };
  }
  return { kind: "dead" };
}

const structure = {};
const reachable = new Set();

for (const pageAbs of pages) {
  const rel = relative(dist, pageAbs).replace(/\\/g, "/");
  const html = await readFile(pageAbs, "utf8");
  const { document } = parseHTML(html);

  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => +h.tagName[1]);
  const h1s = hs.filter((l) => l === 1).length;
  if (h1s !== 1) err(`${rel}: ${h1s} <h1> (want exactly 1)`);
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) { err(`${rel}: heading jump h${hs[i - 1]}→h${hs[i]} (skipped level)`); break; }

  const mains = document.querySelectorAll("main").length;
  if (mains > 1) err(`${rel}: ${mains} <main> (want at most 1)`);
  else if (mains === 0 && rel !== ERROR_PAGE) warn(`${rel}: no <main> landmark`);

  // reader survivability — articles only
  const isArticle = rel.startsWith(ARTICLE_PREFIX) && rel !== `${ARTICLE_PREFIX}index.html`;
  let readerOk = null;
  if (isArticle) {
    const h1text = (document.querySelector("h1")?.textContent || "").trim();
    try {
      const article = new Readability(parseHTML(html).document).parse();
      const txt = (article?.textContent || "").replace(/\s+/g, " ").trim();
      readerOk = !!article && txt.length > 200 && (!h1text || article.title?.includes(h1text.slice(0, 24)) || txt.includes(h1text.slice(0, 24)));
      if (!readerOk) err(`${rel}: reader view didn't extract the article + its <h1> (semantics may be CSS-only)`);
    } catch (e) { err(`${rel}: Readability threw (${e.message})`); readerOk = false; }
  }

  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    const r = await resolveHref(pageAbs, href);
    if (r.kind === "dead") err(`${rel}: dead internal link → ${href}`);
    if (r.kind === "ok") reachable.add(r.key);
    if (href && href.startsWith("/")) links.push(href);
  }

  structure[rel] = { h1: (document.querySelector("h1")?.textContent || "").trim().slice(0, 80), outline: hs.join(""), mains, readerOk, internalLinks: links.sort() };
}

// orphans — served pages reachable from nothing (home + error page are legit roots)
const errorKey = canon("/" + ERROR_PAGE);
for (const key of servedCanon) {
  if (key === "/" || key === errorKey) continue;
  if (!reachable.has(key)) warn(`orphan: ${key} is not linked from any page`);
}

const json = JSON.stringify(Object.fromEntries(Object.keys(structure).sort().map((k) => [k, structure[k]])), null, 2) + "\n";
const digest = createHash("sha256").update(json).digest("hex").slice(0, 12);
// Baseline lives in the CONSUMER (default: next to this script), so a vendored,
// hash-pinned copy of the kit isn't mutated by --check. Override with $STRUCTURE_BASELINE.
const outPath = process.env.STRUCTURE_BASELINE
  ? resolve(process.env.STRUCTURE_BASELINE)
  : join(dirname(fileURLToPath(import.meta.url)), "structure.json");

if (CHECK) {
  const current = (await exists(outPath)) ? await readFile(outPath, "utf8") : "";
  if (current !== json) { console.error("✗ structure.json is stale — regenerate and commit."); errors++; }
} else {
  await writeFile(outPath, json);
}

console.log(`structure-audit: ${pages.length} pages · sha256:${digest} · ${errors} error(s) · ${warns} warn(s)`);
if (errors) { console.error(`✗ structure-audit failed (${errors})`); process.exit(1); }
console.log("✓ structure-audit passed");
