#!/usr/bin/env node
// Plain-language gate — flags UNDEFINED JARGON in a site's prose. For people with
// cognitive/learning disabilities (W3C COGA, WCAG 3.1.3 Unusual Words / 3.1.4
// Abbreviations) AND for machine/AI readers, an unusual term should be DEFINED on
// first use. This gate extracts the prose (excluding code), finds words that are
// not in a large English dictionary and not on an allowlist, and reports those that
// the page does not DEFINE (via <abbr title>, <dfn>, or a <dl> glossary).
//
// WARN-only by default (it reports signal); `--strict` fails closed above a threshold.
//
//   node gates/jargon-gate.mjs [distDir] [--strict]
//
// Config-driven; NOTHING about any one site is hard-coded:
//   argv / $JARGON_DIST        built output dir                  (default: "dist")
//   $JARGON_ALLOWLIST         comma list of accepted domain terms (lowercased)
//   $JARGON_MIN_LENGTH        ignore tokens shorter than this    (default: 3)
//   $JARGON_THRESHOLD         max undefined-jargon terms (--strict) (default: 0)
//   $JARGON_REPORT            path to write the JSON report      (default: none)
//
// The pure tokenize/detect/evaluate functions are exported for unit testing.
import { readFile, readdir, access, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";

// The dictionary ships as JSON; createRequire loads it without an import attribute.
const words = createRequire(import.meta.url)("an-array-of-english-words");
const DICTIONARY = new Set(words);
export const DEFAULT_MIN_LENGTH = 3;

// Stems left behind when "n't" contractions are atomized (couldn't → couldn, t).
// They are not jargon; skip them so the signal isn't polluted by punctuation.
const CONTRACTION_STEMS = new Set([
  "couldn", "doesn", "didn", "isn", "wasn", "aren", "weren", "haven", "hasn",
  "hadn", "wouldn", "shouldn", "mustn", "mightn", "needn", "shan", "daren",
]);

// ── Pure core (unit-testable) ────────────────────────────────────────────────

/** Split prose into lowercased ATOMIC word tokens (pure letter runs). Atomizing on
 *  every non-letter means possessives and hyphenated compounds break into their
 *  parts — "build's" → build, s; "agent-authored" → agent, authored — so only a
 *  genuinely non-dictionary atom (e.g. "asvs", "frobnicator") can be flagged. */
export function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z]+/g) || [];
}

/** Candidate jargon: tokens not in the dictionary nor the allowlist, ≥ minLength. */
export function candidateJargon(text, { allowlist = new Set(), minLength = DEFAULT_MIN_LENGTH } = {}) {
  const out = new Set();
  for (const t of tokenize(text)) {
    if (t.length < minLength) continue;
    if (DICTIONARY.has(t) || allowlist.has(t) || CONTRACTION_STEMS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Evaluate candidate jargon against the terms the page DEFINES. */
export function evaluateJargon({ candidates, definitions = new Set(), threshold = 0 }) {
  const undefinedJargon = [...candidates].filter((t) => !definitions.has(t)).sort();
  return {
    passed: undefinedJargon.length <= threshold,
    threshold,
    count: undefinedJargon.length,
    undefinedJargon,
    // Envelope a future lone `cognitive.plain-language` criterion can consume.
    plainLanguage: { undefinedJargon: undefinedJargon.length, glossaryPresent: definitions.size > 0 },
  };
}

// ── Impure: pull prose + defined terms out of a built page ───────────────────

/** Extract the visible PROSE (excluding code/script/style/nav) and the set of
 *  terms the page DEFINES (<abbr title>, <dfn>, <dl><dt>), all lowercased. */
export function extractProseAndDefinitions(html) {
  const { document } = parseHTML(html);
  const definitions = new Set();
  const add = (s) => { for (const w of tokenize(s)) definitions.add(w); };
  for (const el of document.querySelectorAll("abbr")) { add(el.textContent || ""); add(el.getAttribute("title") || ""); }
  for (const el of document.querySelectorAll("dfn")) add(el.textContent || "");
  for (const el of document.querySelectorAll("dl dt")) add(el.textContent || "");
  // Prose = body text minus code/script/style/nav. Walk text nodes and insert a
  // boundary space at every element edge, so adjacent blocks (e.g. <dt>/<dd>) don't
  // merge into a fake token ("frobnicator"+"the" → "frobnicatorthe").
  for (const el of document.querySelectorAll("script,style,code,pre,nav")) el.remove();
  const root = document.body || document.documentElement;
  const parts = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.nodeType === 3) parts.push(c.textContent || "");
      else if (c.nodeType === 1) { walk(c); parts.push(" "); }
    }
  };
  walk(root);
  return { text: parts.join(" "), definitions };
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function walkHtml(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** Scan dist → aggregate candidates + definitions → evaluate. Exposed for tests. */
export async function runJargonGate({ dist, pages, allowlist = new Set(), minLength = DEFAULT_MIN_LENGTH, threshold = 0 }) {
  const files = pages && pages.length ? pages.map((p) => resolve(dist, p)) : (await walkHtml(resolve(dist))).sort();
  const candidates = new Set();
  const definitions = new Set();
  for (const file of files) {
    const { text, definitions: defs } = extractProseAndDefinitions(await readFile(file, "utf8"));
    for (const t of candidateJargon(text, { allowlist, minLength })) candidates.add(t);
    for (const d of defs) definitions.add(d);
  }
  const report = evaluateJargon({ candidates, definitions, threshold });
  report.pages = files.length;
  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const distArg = argv.find((a) => !a.startsWith("--"));
  const dist = resolve(distArg || process.env.JARGON_DIST || "dist");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) { console.error(`✗ jargon-gate: ${dist} not found — build first.`); process.exit(2); }

  const allowlist = new Set((process.env.JARGON_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const minLength = Number.parseInt(process.env.JARGON_MIN_LENGTH ?? String(DEFAULT_MIN_LENGTH), 10);
  const threshold = Number.parseInt(process.env.JARGON_THRESHOLD ?? "0", 10);

  const report = await runJargonGate({ dist, allowlist, minLength, threshold });
  if (process.env.JARGON_REPORT) await writeFile(resolve(process.env.JARGON_REPORT), JSON.stringify(report, null, 2) + "\n");

  const sample = report.undefinedJargon.slice(0, 30).join(", ");
  const line = `jargon-gate: ${report.count} undefined jargon term(s) across ${report.pages} page(s)` +
    `${report.plainLanguage.glossaryPresent ? " (glossary present)" : " (no glossary/<abbr> definitions found)"}`;

  if (strict && !report.passed) {
    console.error(`✗ ${line}`);
    console.error(`  ${sample}${report.count > 30 ? ` … (+${report.count - 30} more)` : ""}`);
    console.error(`  define unusual terms on first use (<abbr title>, <dfn>, or a glossary), or allowlist accepted domain terms via $JARGON_ALLOWLIST.`);
    process.exit(1);
  }
  console.log(`✓ ${line}`);
  if (report.count) console.log(`  ${sample}${report.count > 30 ? ` … (+${report.count - 30} more)` : ""}  (WARN-only; pass --strict to block)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ jargon-gate: error —", e.stack || e.message); process.exit(1); });
}
