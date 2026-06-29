#!/usr/bin/env node
// AI-readability gate — re-proves lone's `semantic.ai-readability` criterion at build
// time: a site is legible to LLM agents when it ships an `llms.txt` index, that index's
// links actually resolve, and every page has a Markdown sibling (the clean,
// chrome-free source an agent reads instead of scraping rendered HTML).
//
// It emits exactly the evidence shape the standard consumes —
//   aiReadability: { llmsTxtPresent, linksResolve, markdownSiblings }
// — so the consumer asserts the criterion and THIS gate proves it (fail-closed).
//
//   node gates/ai-readability-gate.mjs [distDir]
//
// Static / build-time only. The HTTP half of AI-readability — `Accept: text/markdown`
// content negotiation (`Content-Type: text/markdown; Vary: Accept`) — is served-edge
// behaviour, not a build artifact; probe that at deploy with `ck-http-probe`.
//
// Config (nothing site-specific hard-coded):
//   argv / $AIR_DIST       built output dir                    (default: "dist")
//   $AIR_LLMS              index filename under dist            (default: "llms.txt")
//   $AIR_SIBLING_SUFFIX    Markdown sibling suffix             (default: ".md")
//   $AIR_SIBLING_IGNORE    comma globs of pages needing none   (default: "404")
//   $AIR_PRIVATE           comma path prefixes that are private (default: none)
//   $AIR_REPORT            write the evidence JSON to this path (optional)
//   $AIR_STRICT=0          report only, never exit non-zero    (default: fail-closed)
import { readFile, readdir, access } from "node:fs/promises";
import { resolve, join, dirname, relative, extname, posix } from "node:path";

// ── Pure core (filesystem-free; unit-testable) ───────────────────────────────

/** Extract link targets from Markdown: `[text](url)` + `<url>` autolinks. */
export function extractMarkdownLinks(md) {
  const out = [];
  const text = String(md);
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/<((?:https?:\/\/|\/)[^>\s]+)>/g)) out.push(m[1]);
  return out;
}

/** internal (relative / root-absolute) · external (scheme or //) · anchor (#…). */
export function classifyLink(url) {
  const u = String(url).trim();
  if (u.startsWith("#")) return "anchor";
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//")) return "external";
  return "internal";
}

export function stripFragment(url) {
  return String(url).split("#")[0].split("?")[0];
}

/** Candidate dist files an internal link could resolve to (extensionless → .html / dir index). */
export function resolveCandidates(url, fromDir) {
  const clean = stripFragment(url);
  const base = clean.startsWith("/") ? clean.slice(1) : posix.join(fromDir, clean);
  const cands = [base];
  if (base.endsWith("/")) cands.push(posix.join(base, "index.html"));
  else if (!extname(base)) cands.push(base + ".html", posix.join(base, "index.html"));
  return cands.map((c) => c.replace(/^\/+/, ""));
}

/** Markdown sibling for an HTML page: dist/blog/x.html → dist/blog/x<suffix>. */
export function siblingFor(htmlRel, suffix = ".md") {
  return htmlRel.replace(/\.html$/, suffix);
}

export function isPrivate(url, prefixes = []) {
  const p = stripFragment(url);
  return prefixes.some((pre) => pre && (p === pre || p.startsWith(pre.endsWith("/") ? pre : pre + "/") || p.startsWith(pre)));
}

export function matchesAny(rel, globs = []) {
  return globs.some((g) => {
    const re = new RegExp("^" + g.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "(\\.html)?$");
    return re.test(rel) || re.test(rel.replace(/\.html$/, ""));
  });
}

// ── Impure: read dist + evaluate ─────────────────────────────────────────────

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function walkHtml(dir, root = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(p, root));
    else if (e.name.endsWith(".html")) out.push(relative(root, p));
  }
  return out;
}

export async function evaluateAiReadability({
  dist, llmsName = "llms.txt", siblingSuffix = ".md", siblingIgnore = ["404"], privatePrefixes = [],
}) {
  const distAbs = resolve(dist);
  const llmsPath = join(distAbs, llmsName);

  // 1. llms.txt present?
  const llmsTxtPresent = await exists(llmsPath);

  // 2. its internal links resolve to real files (and none point to private paths).
  const brokenLinks = [], privateLinks = [];
  if (llmsTxtPresent) {
    const md = await readFile(llmsPath, "utf8");
    const fromDir = dirname(relative(distAbs, llmsPath));
    for (const url of extractMarkdownLinks(md)) {
      if (classifyLink(url) !== "internal") continue;
      if (isPrivate(url, privatePrefixes)) { privateLinks.push(url); continue; }
      const cands = resolveCandidates(url, fromDir === "." ? "" : fromDir);
      let ok = false;
      for (const c of cands) if (await exists(join(distAbs, c))) { ok = true; break; }
      if (!ok) brokenLinks.push(url);
    }
  }
  const linksResolve = llmsTxtPresent && brokenLinks.length === 0 && privateLinks.length === 0;

  // 3. every content page has a Markdown sibling.
  const pages = (await walkHtml(distAbs)).sort();
  const missingSiblings = [];
  for (const rel of pages) {
    if (matchesAny(rel, siblingIgnore)) continue;
    if (!(await exists(join(distAbs, siblingFor(rel, siblingSuffix))))) missingSiblings.push(rel);
  }
  const markdownSiblings = pages.length > 0 && missingSiblings.length === 0;

  return {
    aiReadability: { llmsTxtPresent, linksResolve, markdownSiblings },
    details: { llmsPath: relative(distAbs, llmsPath), brokenLinks, privateLinks, missingSiblings, pages: pages.length, siblingSuffix },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const distArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const dist = resolve(distArg || process.env.AIR_DIST || "dist");
  if (!(await exists(dist))) { console.error(`✗ ai-readability-gate: ${dist} not found — build first.`); process.exit(2); }

  const res = await evaluateAiReadability({
    dist,
    llmsName: process.env.AIR_LLMS || "llms.txt",
    siblingSuffix: process.env.AIR_SIBLING_SUFFIX || ".md",
    siblingIgnore: (process.env.AIR_SIBLING_IGNORE ?? "404").split(",").map((s) => s.trim()).filter(Boolean),
    privatePrefixes: (process.env.AIR_PRIVATE || "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  const { llmsTxtPresent, linksResolve, markdownSiblings } = res.aiReadability;
  const d = res.details;

  if (process.env.AIR_REPORT) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolve(process.env.AIR_REPORT), JSON.stringify(res.aiReadability, null, 2) + "\n");
  }
  if (process.argv.includes("--json")) { console.log(JSON.stringify(res, null, 2)); return; }

  console.log(`  ${llmsTxtPresent ? "✓" : "✗"} llms.txt present (${d.llmsPath})`);
  console.log(`  ${linksResolve ? "✓" : "✗"} llms.txt links resolve` +
    (d.brokenLinks.length ? ` — broken: ${d.brokenLinks.slice(0, 5).join(", ")}` : "") +
    (d.privateLinks.length ? ` — private: ${d.privateLinks.slice(0, 5).join(", ")}` : ""));
  console.log(`  ${markdownSiblings ? "✓" : "✗"} Markdown siblings (${d.siblingSuffix}) for ${d.pages} page(s)` +
    (d.missingSiblings.length ? ` — missing: ${d.missingSiblings.slice(0, 5).join(", ")}` : ""));

  const pass = llmsTxtPresent && linksResolve && markdownSiblings;
  console.log(`${pass ? "✓" : "✗"} ai-readability-gate: ${pass ? "AI-readable" : "NOT AI-readable"} (semantic.ai-readability)`);
  if (!pass && process.env.AIR_STRICT !== "0") process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ ai-readability-gate: error —", e.stack || e.message); process.exit(1); });
}
