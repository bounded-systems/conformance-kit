#!/usr/bin/env node
// Doc-scope SIGNAL gate — a zero-dep proxy for two things a good post holds:
// ONE topic, and a bounded LENGTH. Over a corpus of composed prose (blog posts,
// docs), it reports per-document word count and a focus score, and WARNs when a
// doc runs long or reads as unfocused.
//
//   node gates/doc-scope-gate.mjs <corpus.json>            # report (WARN-only, exit 0)
//   node gates/doc-scope-gate.mjs <corpus.json> --strict   # escalate WARNs (exit 1)
//
// HONEST FRAMING: FOCUS is a proxy, not a topic classifier. It measures how much
// of a doc's content-word mass its top terms carry — a focused piece reuses its
// key nouns; a sprawling one scatters. A low score flags a doc to REVIEW (maybe
// split it), it doesn't prove two topics. LENGTH is a plain word count. Both
// WARN-by-default. The top terms are printed so you can see the inferred topic.
//
// The CORPUS IS AN INPUT: a JSON file, EITHER an array of { "id","text" } OR an
// object map { id: text }. Markup is stripped.
//
// Site-agnostic injection (all optional):
//   argv[2] / $DOC_CORPUS      path to the corpus JSON (required).
//   $DOC_WORDS_MAX             WARN over this word count (default 1500).
//   $DOC_FOCUS_MIN             WARN under this focus score 0..1 (default 0.10).
//   $DOC_TOP_TERMS             how many top terms define the focus (default 8).
import { readFile } from "node:fs/promises";

const corpusPath = process.argv[2] || process.env.DOC_CORPUS;
const strict = process.argv.includes("--strict");
if (!corpusPath) {
  console.error("usage: doc-scope-gate <corpus.json> [--strict]");
  process.exit(2);
}
const WORDS_MAX = Number(process.env.DOC_WORDS_MAX || 1500);
const FOCUS_MIN = Number(process.env.DOC_FOCUS_MIN || 0.10);
const TOP_TERMS = Number(process.env.DOC_TOP_TERMS || 8);

const STOP = new Set(
  ("a an the and or but if then else of to in on at by for with from into over as is are was were be been being " +
    "it its this that these those they them their there here we you your our i he she his her not no do does did " +
    "so such than too very can could should would may might will just also more most some any each per one two " +
    "what which who whom whose when where why how all out up down off about above below between through during " +
    "has have had having only own same other another because while both few many much own now new").split(/\s+/),
);
const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ");

function atoms(corpus) {
  if (Array.isArray(corpus)) return corpus.map((a) => [a.id ?? "?", a.text ?? ""]);
  return Object.entries(corpus);
}

function analyze(raw) {
  const text = strip(raw);
  const words = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const content = words.filter((w) => !STOP.has(w) && w.length >= 4);
  const freq = new Map();
  for (const w of content) freq.set(w, (freq.get(w) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TERMS);
  const topMass = top.reduce((n, [, c]) => n + c, 0);
  const focus = content.length ? topMass / content.length : 1;
  return { words: words.length, focus, top: top.map(([w]) => w) };
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const docs = atoms(corpus).map(([id, raw]) => ({ id, ...analyze(raw) }));

let warns = 0;
console.log(`doc-scope: ${docs.length} doc(s) — WARN (proxies: length + focus)\n`);
for (const d of docs) {
  const flags = [];
  if (d.words > WORDS_MAX) flags.push(`LONG ${d.words}w > ${WORDS_MAX}`);
  if (d.focus < FOCUS_MIN) flags.push(`UNFOCUSED ${d.focus.toFixed(2)} < ${FOCUS_MIN}`);
  warns += flags.length ? 1 : 0;
  const mark = flags.length ? "⚠ " : "  ";
  console.log(`${mark}${d.id} — ${d.words}w · focus ${d.focus.toFixed(2)} · topic: ${d.top.slice(0, 5).join(", ")}`);
  if (flags.length) console.log(`      ${flags.join(" · ")}`);
}

if (warns === 0) {
  console.log(`\n✓ every doc within scope (≤ ${WORDS_MAX}w, focus ≥ ${FOCUS_MIN})`);
  process.exit(0);
}
console.log(`\n${warns} doc(s) to review`);
process.exit(strict ? 1 : 0);
