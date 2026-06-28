#!/usr/bin/env node
// Readability SIGNAL gate — a zero-dep readability report over a corpus of prose.
//
//   node gates/readability-gate.mjs <corpus.json>            # report (WARN-only, exit 0)
//   node gates/readability-gate.mjs <corpus.json> --strict   # escalate WARNs (exit 1)
//
// HONEST FRAMING: this is a READABILITY SIGNAL, not a "cognitive-load score".
// Flesch-Kincaid / Gunning Fog estimate a US reading grade from surface features
// (sentence length, syllables-per-word). They do NOT measure how hard an idea is to
// think about. The gate is WARN-by-default: it reports the signal and flags long
// sentences, long paragraphs, passive voice, and unexplained acronyms — but it only
// fails the build on EGREGIOUS thresholds, or when run with --strict.
//
// The CORPUS IS AN INPUT (each site curates its own copy): supply a JSON file that
// is EITHER an array of { "id": "...", "text": "..." } OR an object map { id: text }.
// Markup/HTML in text is stripped; atoms under the word floor are skipped — a
// reading-grade formula is meaningless on a two-word button.
//
// Site-agnostic injection (all optional, neutral defaults):
//   argv[2] / $READABILITY_CORPUS  path to the corpus JSON (required).
//   $READABILITY_THRESHOLDS        JSON {gradeWarn,gradeBlock,sentWarn,sentBlock,paraWarn}.
//   $READABILITY_MIN_WORDS         per-atom word floor (default 6).
//   $READABILITY_KNOWN_ACRONYMS    comma list of acronyms NOT to warn on.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const corpusPath = process.argv[2] || process.env.READABILITY_CORPUS;
const strict = process.argv.includes("--strict");
if (!corpusPath) { console.error("usage: readability-gate <corpus.json> [--strict]"); process.exit(2); }

// Thresholds (documented, deliberately generous for terse technical copy):
//   reading grade   WARN > 14 (college) · EGREGIOUS (block) > 22
//   sentence length WARN > 30 words      · EGREGIOUS (block) > 60 words
//   paragraph length WARN > 90 words
const T = {
  gradeWarn: 14, gradeBlock: 22, sentWarn: 30, sentBlock: 60, paraWarn: 90,
  ...(process.env.READABILITY_THRESHOLDS ? JSON.parse(process.env.READABILITY_THRESHOLDS) : {}),
};
const MIN_WORDS = Number(process.env.READABILITY_MIN_WORDS || 6);

// A small default of common/explained acronyms; the consumer extends via env.
const KNOWN_ACRONYMS = new Set([
  "AI", "CLI", "PR", "PRS", "CI", "AWS", "DOM", "HTML", "CSS", "JSON", "RDF", "URL", "RSS",
  "SLSA", "PDF", "US", "OCI", "GHCR", "OIDC", "API", "SBOM", "CID", "IPFS",
  "SPDX", "DNS", "MCP", "VC", "TS", "SHA", "TDD", "SHACL", "RFC", "SEO", "ID",
  ...(process.env.READABILITY_KNOWN_ACRONYMS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
]);

// ---- text utilities (zero-dep) --------------------------------------------------
const stripMarkup = (s) =>
  String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&middot;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const words = (s) => (s.match(/[A-Za-z][A-Za-z'’-]*/g) || []);
const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((x) => x.trim()).filter(Boolean);

const syllables = (w) => {
  w = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  let groups = (w.match(/[aeiouy]+/g) || []).length;
  if (/e$/.test(w) && !/[aeiouy]e$/.test(w) && groups > 1) groups--; // silent final e
  return Math.max(1, groups);
};
const complex = (w) => syllables(w) >= 3; // Gunning Fog "complex word"

// ---- load + normalise the corpus -------------------------------------------------
const raw = JSON.parse(await readFile(resolve(corpusPath), "utf8"));
const entries = Array.isArray(raw)
  ? raw.map((e) => [e.id, e.text])
  : Object.entries(raw).filter(([id, v]) => !id.startsWith("_") && typeof v === "string");

const corpus = []; // { id, text }
for (const [id, text] of entries) {
  const t = stripMarkup(text);
  if (t && words(t).length >= MIN_WORDS) corpus.push({ id, text: t });
}
if (corpus.length === 0) { console.error(`✗ readability-gate: no prose atoms (≥ ${MIN_WORDS} words) in ${corpusPath}`); process.exit(2); }

// ---- score ----------------------------------------------------------------------
let warns = 0, blocks = 0;
const warn = (m) => { console.log(`  ⚠ ${m}`); warns++; };
const block = (m) => { console.error(`  ✗ ${m}`); blocks++; };

const PASSIVE = /\b(?:is|are|was|were|be|been|being|am)\b\s+(?:[a-z]+ly\s+)?(?:[a-z]+ed|written|built|made|done|shown|given|held|kept|driven|known|seen|taken|drawn|met|run|set|read|put|sent|brought|caught)\b/gi;

let totW = 0, totS = 0, totSyl = 0, totComplex = 0;
for (const { id, text } of corpus) {
  const ws = words(text);
  const ss = sentences(text);
  const syl = ws.reduce((a, w) => a + syllables(w), 0);
  const cx = ws.filter(complex).length;
  totW += ws.length; totS += ss.length; totSyl += syl; totComplex += cx;

  for (const s of ss) {
    const n = words(s).length;
    if (n > T.sentBlock) block(`${id}: sentence of ${n} words exceeds egregious cap (${T.sentBlock}) — "${s.slice(0, 70)}…"`);
    else if (n > T.sentWarn) warn(`${id}: long sentence (${n} words) — "${s.slice(0, 70)}…"`);
  }
  if (ws.length > T.paraWarn) warn(`${id}: long paragraph (${ws.length} words)`);
  for (const m of text.match(PASSIVE) || []) warn(`${id}: possible passive voice — "${m.trim()}"`);
  for (const tok of text.match(/\b[A-Z][A-Z0-9]{1,6}s?\b/g) || []) {
    const base = tok.replace(/s$/, "").toUpperCase();
    if (!KNOWN_ACRONYMS.has(tok.toUpperCase()) && !KNOWN_ACRONYMS.has(base)) warn(`${id}: unexplained acronym "${tok}"`);
  }
}

const fk = 0.39 * (totW / totS) + 11.8 * (totSyl / totW) - 15.59;
const fog = 0.4 * ((totW / totS) + 100 * (totComplex / totW));
const grade = (fk + fog) / 2;
const g = (x) => x.toFixed(1);

console.log("");
console.log(`readability signal (${corpus.length} prose atoms, ${totW} words, ${totS} sentences):`);
console.log(`  Flesch-Kincaid grade ${g(fk)} · Gunning Fog ${g(fog)} · mean ${g(grade)}`);
console.log(`  (a US reading-grade SIGNAL from sentence length + syllables — NOT a cognitive-load score)`);
console.log("");

if (grade > T.gradeBlock) block(`mean reading grade ${g(grade)} exceeds egregious cap (${T.gradeBlock})`);
else if (grade > T.gradeWarn) warn(`mean reading grade ${g(grade)} above college level (${T.gradeWarn})`);

console.log("");
if (blocks) {
  console.error(`✗ readability-gate: ${blocks} egregious finding(s), ${warns} warning(s).`);
  process.exit(1);
}
if (strict && warns) {
  console.error(`✗ readability-gate (--strict): ${warns} warning(s) escalated to errors.`);
  process.exit(1);
}
console.log(`✓ readability-gate: signal reported — ${warns} warning(s), 0 egregious. (WARN-only; pass --strict to block on warnings.)`);
