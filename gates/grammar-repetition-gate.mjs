#!/usr/bin/env node
// Grammar-repetition SIGNAL gate — a zero-dep structural proxy over a prose corpus.
//
//   node gates/grammar-repetition-gate.mjs <corpus.json>            # report (WARN-only, exit 0)
//   node gates/grammar-repetition-gate.mjs <corpus.json> --strict   # escalate WARNs (exit 1)
//
// HONEST FRAMING: this is a STRUCTURE SIGNAL, not a style verdict. It counts the
// first two words of every sentence across the corpus and flags any opener used
// more than a threshold — monotony that reads flat and lowers density. Deliberate
// anaphora (a rhetorical repeat) will trip it and is fine. WARN-by-default.
//
// The CORPUS IS AN INPUT: a JSON file that is EITHER an array of
// { "id": "...", "text": "..." } OR an object map { id: text }. Markup is stripped.
//
// Site-agnostic injection (all optional):
//   argv[2] / $REPETITION_CORPUS   path to the corpus JSON (required).
//   $REPETITION_THRESHOLD          openers used more than this are flagged (default 3).
import { readFile } from "node:fs/promises";

const corpusPath = process.argv[2] || process.env.REPETITION_CORPUS;
const strict = process.argv.includes("--strict");
if (!corpusPath) {
  console.error("usage: grammar-repetition-gate <corpus.json> [--strict]");
  process.exit(2);
}
const THRESHOLD = Number(process.env.REPETITION_THRESHOLD || 3);

const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");
function atoms(corpus) {
  if (Array.isArray(corpus)) return corpus.map((a) => a.text ?? "");
  return Object.values(corpus);
}
function openers(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 4)
    .map((s) => s.replace(/^[^A-Za-z]+/, "").toLowerCase().split(/\s+/).slice(0, 2).join(" "))
    .filter(Boolean);
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const counts = new Map();
for (const raw of atoms(corpus)) {
  for (const opener of openers(strip(raw))) {
    counts.set(opener, (counts.get(opener) ?? 0) + 1);
  }
}

const flagged = [...counts.entries()]
  .filter(([, n]) => n > THRESHOLD)
  .sort((a, b) => b[1] - a[1]);

if (flagged.length === 0) {
  console.log(`✓ grammar-repetition: no opener used more than ${THRESHOLD}× (proxy)`);
  process.exit(0);
}
console.log(`grammar-repetition: ${flagged.length} over-repeated opener(s) — WARN (proxy)\n`);
for (const [opener, n] of flagged) console.log(`  "${opener}…" ×${n}`);
process.exit(strict ? 1 : 0);
