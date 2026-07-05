#!/usr/bin/env node
// Claim-discipline SIGNAL gate — a zero-dep lexical proxy over a corpus of prose.
//
//   node gates/claim-discipline-gate.mjs <corpus.json>            # report (WARN-only, exit 0)
//   node gates/claim-discipline-gate.mjs <corpus.json> --strict   # escalate WARNs (exit 1)
//
// HONEST FRAMING: this is a WORD-CHOICE SIGNAL, not a truth check. It surfaces
// three classes of language that undercut a claim of bounded, proven authority —
// UNBOUNDED absolutes, UNPROVEN strength words, and VAGUE quantifiers — by
// keyword, with the sentence for context. Some flagged uses are legitimate (a
// precise "never widens authority"; "unbounded" naming the problem). It measures
// form, not meaning: WARN-by-default, a review list, --strict to enforce.
//
// The CORPUS IS AN INPUT (each site curates its own copy): a JSON file that is
// EITHER an array of { "id": "...", "text": "..." } OR an object map { id: text }.
// Markup is stripped.
//
// Site-agnostic injection (all optional, neutral defaults):
//   argv[2] / $CLAIM_CORPUS      path to the corpus JSON (required).
//   $CLAIM_LEXICONS              JSON { unbounded:[], unproven:[], vague:[] } — REPLACES defaults.
//   $CLAIM_ALLOW                 comma list of "word" tokens never flagged.
import { readFile } from "node:fs/promises";

const corpusPath = process.argv[2] || process.env.CLAIM_CORPUS;
const strict = process.argv.includes("--strict");
if (!corpusPath) {
  console.error("usage: claim-discipline-gate <corpus.json> [--strict]");
  process.exit(2);
}

const DEFAULT_LEXICONS = {
  unbounded: [
    "unbounded", "infinite", "unlimited", "boundless", "always", "never",
    "everything", "anything", "everyone", "all cases", "100%", "fully",
    "completely", "totally", "guaranteed", "guarantees", "zero risk",
  ],
  unproven: [
    "proven", "battle-tested", "bulletproof", "bank-grade", "military-grade",
    "robust", "seamless", "effortless", "trivially", "obviously", "clearly",
    "simply", "of course", "needless to say", "it's easy",
  ],
  vague: [
    "some", "many", "various", "several", "a number of", "a lot", "lots of",
    "often", "usually", "generally", "typically", "kind of", "sort of",
    "stuff", "things", "etc",
  ],
};

const LEXICONS = process.env.CLAIM_LEXICONS
  ? JSON.parse(process.env.CLAIM_LEXICONS)
  : DEFAULT_LEXICONS;
const ALLOW = new Set(
  (process.env.CLAIM_ALLOW || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

// "kind of X" / "sort of X" is a compound, not the hedge — skip after a determiner.
const DET = "(?<!\\b(?:one|each|a|an|the|every|per|this|that|any|no|some|two|three|four)\\s)";
const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");

function atoms(corpus) {
  if (Array.isArray(corpus)) return corpus.map((a) => [a.id ?? "?", a.text ?? ""]);
  return Object.entries(corpus);
}
function sentenceAround(text, idx) {
  const start = Math.max(0, text.lastIndexOf(".", idx) + 1);
  let end = text.indexOf(".", idx);
  if (end < 0) end = text.length;
  return text.slice(start, end + 1).trim();
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const findings = [];
for (const [id, raw] of atoms(corpus)) {
  const text = strip(raw);
  const lower = text.toLowerCase();
  for (const [cls, words] of Object.entries(LEXICONS)) {
    for (const w of words) {
      if (ALLOW.has(w.toLowerCase())) continue;
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const guard = (w === "kind of" || w === "sort of") ? DET : "";
      const re = new RegExp(`${guard}\\b${esc}\\b`, "gi");
      let m;
      while ((m = re.exec(lower)) !== null) {
        findings.push({ id, class: cls, word: w, sentence: sentenceAround(text, m.index) });
      }
    }
  }
}

if (findings.length === 0) {
  console.log("✓ claim-discipline: no unbounded / unproven / vague candidates");
  process.exit(0);
}

const byClass = { unbounded: [], unproven: [], vague: [] };
for (const f of findings) (byClass[f.class] ??= []).push(f);
console.log(`claim-discipline: ${findings.length} candidate(s) — WARN (proxy, not a verdict)\n`);
for (const cls of Object.keys(byClass)) {
  const fs = byClass[cls];
  if (!fs?.length) continue;
  console.log(`  ${cls.toUpperCase()} (${fs.length}):`);
  for (const f of fs.slice(0, 10)) {
    console.log(`    "${f.word}" — ${f.id}: …${f.sentence.slice(0, 90)}…`);
  }
  console.log("");
}
process.exit(strict ? 1 : 0);
