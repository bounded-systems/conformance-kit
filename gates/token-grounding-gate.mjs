#!/usr/bin/env node
// Token-grounding SIGNAL gate — the layer-1 check: a copy token that asserts a
// FIGURE must trace to a proof atom. This is the "proof behind the tokens" — it
// keeps the copy honest at the root, before it composes into prose or renders.
//
//   node gates/token-grounding-gate.mjs <tokens.json> <grounding.json>            # report
//   node gates/token-grounding-gate.mjs <tokens.json> <grounding.json> --strict   # exit 1 if ungrounded
//
// HONEST FRAMING + LAYER PURITY: this validates ONE shape — that a token's
// numeric/figure claims exist in the proof set. It does NOT judge prose (layer 3),
// graph structure (layer 2), or whether the proof itself is true (layer 0 owns
// that). It grounds FIGURES ("200+", "20%", "7 days"); qualitative claims are the
// job of an attested-claims mechanism, not this gate. A flagged token asserts a
// number with no proof behind it — fix the copy or add the evidence.
//
//   tokens.json     strings.json shape: { key: {$value|value} } OR { key: "value" }.
//   grounding.json  the proof atoms: an array of strings, or an object whose
//                   values are strings/arrays. Every figure that appears here is
//                   considered grounded.
import { readFile } from "node:fs/promises";

const [tokensPath, groundingPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const strict = process.argv.includes("--strict");
if (!tokensPath || !groundingPath) {
  console.error("usage: token-grounding-gate <tokens.json> <grounding.json> [--strict]");
  process.exit(2);
}

const tokenValue = (t) => t?.$value ?? t?.value ?? (typeof t === "string" ? t : "");
// A figure: a number with optional thousands/decimals and a +, %, or ×/x suffix.
const FIGURE = /(?<![a-z\d])\d[\d,]*(?:\.\d+)?\s*(?:%|\+|x|×)?/gi;
const normFigure = (s) => s.replace(/[,\s]/g, "").replace(/×/g, "x").toLowerCase();

function figures(text) {
  return (String(text).match(FIGURE) ?? [])
    .map(normFigure)
    // drop bare years/versions and trivial 1-digit counts — too noisy to ground
    .filter((f) => !/^\d{4}$/.test(f) && !/^\d$/.test(f));
}

const tokens = JSON.parse(await readFile(tokensPath, "utf8"));
const grounding = JSON.parse(await readFile(groundingPath, "utf8"));

// proof figure set: every figure appearing anywhere in the grounding atoms
const proofText = Array.isArray(grounding)
  ? grounding.join(" ")
  : Object.values(grounding).flat().join(" ");
const proof = new Set(figures(proofText));

const findings = [];
for (const [key, tok] of Object.entries(tokens)) {
  if (key.startsWith("$")) continue;
  const val = tokenValue(tok);
  const claimed = [...new Set(figures(val))];
  const ungrounded = claimed.filter((f) => !proof.has(f));
  if (ungrounded.length) findings.push({ key, val, ungrounded });
}

const claimTokens = Object.entries(tokens).filter(([k, t]) => !k.startsWith("$") && figures(tokenValue(t)).length).length;

if (findings.length === 0) {
  console.log(`✓ token-grounding: every figure-claim across ${claimTokens} claim-token(s) traces to proof`);
  process.exit(0);
}
console.log(`token-grounding: ${findings.length}/${claimTokens} claim-token(s) with an UNGROUNDED figure (proof: ${proof.size} atoms)\n`);
for (const f of findings.slice(0, 20)) {
  console.log(`  ⚠ ${f.key} — ungrounded ${f.ungrounded.join(", ")}`);
  console.log(`      "${String(f.val).slice(0, 80)}"`);
}
process.exit(strict ? 1 : 0);
