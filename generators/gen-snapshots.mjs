#!/usr/bin/env node
// Reader-view snapshot generator — for every built page, emit a clean READER
// extraction (the same Readability engine that powers Firefox/Safari Reader) as
// both HTML and Markdown. The Markdown is the durable, analysis-friendly twin of
// the page: machine-readable, diffable, and far easier to run NLP / LLM analysis
// over than scraping live HTML — and it doubles as the AI-readable Markdown sibling
// (`semantic.ai-readability`). A non-empty extraction is also the PROOF of the
// "reader survivability" the structure-audit grades (`readerOk`).
//
//   node generators/gen-snapshots.mjs [distDir]    # write <page>.reader.{html,md}
//
// Pure (no browser, no network): linkedom parses the DOM, @mozilla/readability
// extracts the article, turndown renders Markdown. (The PRINTED/PDF view needs a
// real print-CSS renderer — tezcatl --pdf locally — and is a separate generator.)
//
// Config-driven; NOTHING about any one site is hard-coded:
//   argv[2] / $SNAPSHOT_DIST   built output dir                  (default: "dist")
//   $SNAPSHOT_PAGES           comma list of page paths under dist (default: every *.html)
//   $SNAPSHOT_BASE_URL        site origin, recorded as `source` in the front-matter
//   $SNAPSHOT_SUFFIX          output basename suffix              (default: ".reader")
//
// The pure extract/markdown functions are exported for unit testing.
import { writeFile, readFile, readdir, access } from "node:fs/promises";
import { resolve, join, relative, dirname, basename, extname } from "node:path";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

// ── Pure core (browser-free; unit-testable) ──────────────────────────────────

/** Extract the reader view of an HTML document. Returns null when Readability
 *  cannot find article content (e.g. a nav-only or empty page). */
export function extractReader(html, { url = "" } = {}) {
  const { document } = parseHTML(html);
  const article = new Readability(document).parse();
  if (!article || !article.content) return null;
  return {
    url,
    title: article.title || "",
    byline: article.byline || "",
    excerpt: article.excerpt || "",
    siteName: article.siteName || "",
    length: article.length || 0,
    contentHtml: article.content,
    text: article.textContent || "",
  };
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

/** Render a reader extraction to Markdown with a small YAML front-matter (title,
 *  byline, excerpt, source) so the snapshot is self-describing for analysis. */
export function toMarkdown(reader) {
  const q = (s) => JSON.stringify(String(s));
  const fm = [
    "---",
    `title: ${q(reader.title)}`,
    reader.byline ? `byline: ${q(reader.byline)}` : null,
    reader.excerpt ? `excerpt: ${q(reader.excerpt)}` : null,
    reader.url ? `source: ${reader.url}` : null,
    "---",
  ].filter((x) => x != null).join("\n");
  return `${fm}\n\n${turndown.turndown(reader.contentHtml).trim()}\n`;
}

// ── Impure runner ────────────────────────────────────────────────────────────

async function walkHtml(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(p, base));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const dist = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.SNAPSHOT_DIST || "dist");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) { console.error(`✗ gen-snapshots: ${dist} not found — build first.`); process.exit(2); }

  const suffix = process.env.SNAPSHOT_SUFFIX || ".reader";
  const baseUrl = (process.env.SNAPSHOT_BASE_URL || "").replace(/\/$/, "");
  let pages = (process.env.SNAPSHOT_PAGES || "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean);
  pages = pages.length ? pages.map((p) => resolve(dist, p)) : (await walkHtml(dist)).sort();

  let wrote = 0, skipped = 0;
  for (const file of pages) {
    const rel = relative(dist, file);
    const url = baseUrl ? `${baseUrl}/${rel.replace(/index\.html$/, "").replace(/\.html$/, "")}` : "";
    const reader = extractReader(await readFile(file, "utf8"), { url });
    if (!reader) { console.error(`  · skipped ${rel} (no article content)`); skipped++; continue; }
    const stem = join(dirname(file), basename(file, extname(file)) + suffix);
    await writeFile(`${stem}.html`, reader.contentHtml.trim() + "\n");
    await writeFile(`${stem}.md`, toMarkdown(reader));
    console.log(`  ✓ ${rel} → ${relative(dist, stem)}.{html,md} (${reader.length} chars)`);
    wrote++;
  }
  console.log(`✓ gen-snapshots: ${wrote} reader snapshot(s) written${skipped ? `, ${skipped} skipped` : ""}.`);
}

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ gen-snapshots: error —", e.stack || e.message); process.exit(1); });
}
