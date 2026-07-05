# Changelog

## 0.11.0 — 2026-07-05

### Minor

- `ck-token-grounding-gate` — the layer-1 check: every copy token that asserts a figure must trace to a proof atom (grounding.json). Plus LAYERS.md, the check-layer manifest (validate the new shape, trust the layer below) + a purity audit tagging every gate to its layer.

## 0.10.0 — 2026-07-05

### Minor

- `ck-doc-scope-gate` — a per-document proxy for one topic + bounded length over a prose corpus. Reports word count, a focus score (top-term concentration), and each doc's inferred topic terms; WARNs on long or unfocused docs. Corpus-based, WARN-by-default, honest-framed.

## 0.9.0 — 2026-07-05

### Minor

- Two prose-proxy gates: `ck-claim-discipline-gate` (unbounded/unproven/vague word-choice signal) and `ck-grammar-repetition-gate` (over-repeated sentence openers). Corpus-based, WARN-by-default, honest-framed — the same convention as the readability gate, so any repo can run the org's quality checks.
- add `css-purity-gate` (ck-css-purity-gate): "no inline values, always tokens" — a static, declaration-aware scanner that fails closed on raw dimensions (320px / 28px / 999px …) in layout properties, forcing every spacing/sizing/layout value through a coherent `var(--bs-*)` token scale. The shift-left counterpart to a runtime layout gate: it prevents the overflow/overlap class at the source rather than catching it at render. Generalises the colour-purity check to dimensions (opt-in `$PURITY_COLORS` still covers literal colours + token-membership).
- adopt @bounded-systems/mint for versioning + signed release provenance: per-PR `.release/` intents → `mint version` → signed `v*` tag, replacing the hand-edited package.json version + the publish-branch fast-forward (the npm registry publish is unchanged)

