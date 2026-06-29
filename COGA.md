# COGA Framework — W3C "Making Content Usable for People with Cognitive and Learning Disabilities"

> **Status**: Objective 5 IMPLEMENTED (via `cognitive.focus-budget`). Objectives 1–4, 6–8 staged as `not-assessed` placeholders for future work.
>
> **Source standard**: [W3C COGA Making Content Usable for People with Cognitive and Learning Disabilities](https://www.w3.org/TR/coga-usable/) — supplementary guidance aligned with WCAG 2.x and WCAG 3.

---

## Honest framing

COGA defines usability goals for people with cognitive and learning disabilities — including ADHD, dyslexia, dyscalculia, memory impairments, autism, and acquired cognitive impairments. Many COGA criteria cannot be mechanically verified; they require:

- Usability testing with people who have cognitive disabilities
- Human judgment about content clarity and complexity
- Participant feedback from people with ADHD, dyslexia, memory impairments, etc.

The gates in this kit provide **honest proxy measurements** (static heuristics) that raise the floor. They are NOT substitutes for participant testing. Each gate is explicitly labeled with its evidence type.

---

## The 8 COGA Objectives

### Objective 1 — Help users understand what things are and how to use them

**Status**: `not-assessed`

**What it covers**: Familiar design patterns, recognizable iconography, consistent naming, affordance clarity. Users should be able to understand the purpose of UI elements without prior learning.

**Why not-assessed**: Requires participant testing with users with cognitive disabilities or a manual expert review against COGA patterns. No automated gate can verify recognition or familiarity.

**Future path**: Manual review against [COGA Design Guide — User needs](https://www.w3.org/TR/coga-usable/#user-needs) + participant sessions.

---

### Objective 2 — Help users find what they need

**Status**: `not-assessed`

**What it covers**: Clear and consistent navigation, predictable page structure, search functionality, breadcrumbs, landmark regions accessible to AT. Users can locate content without cognitive map-building.

**Partial overlap**: `a11y.agent-heuristic-review` checks ARIA landmarks and navigation structure (machine-readable signals only). SEO technical checks verify internal link integrity. Neither covers wayfinding as experienced by users with spatial/memory difficulties.

**Future path**: Navigation usability testing; consistency audit across page templates.

---

### Objective 3 — Use clear and understandable content and text

**Status**: `not-assessed`

**What it covers**: Plain language, short sentences, active voice, concrete examples, no unexplained jargon, defined abbreviations, consistent terminology.

**Partial overlap**: `cognitive.focus-budget` (Obj-5) measures reading grade, sentence length, and jargon density as static proxies. These signals are necessary but not sufficient for Obj-3 — they do not verify clarity, comprehension, or the presence of concrete examples.

**Why not-assessed**: Comprehension quality requires participant testing or manual expert review. Reading grade is a surface proxy; a text can have low grade-level but still be confusing.

**Future path**: Readability audit by a plain-language expert + comprehension testing with users.

---

### Objective 4 — Help users avoid and correct mistakes

**Status**: `not-assessed`

**What it covers**: Clear error messages, error prevention, error recovery paths, form validation with helpful feedback, undo functionality, confirmation dialogs before destructive actions.

**Why not-assessed**: Requires forms and interactive workflows that generate errors. This site (robertdelanghe.dev + bounded.tools) has minimal form interaction. When interactive forms are added, this objective should be assessed.

**Future path**: Form usability testing with users who have cognitive disabilities; error-message review against COGA error guidance.

---

### Objective 5 — Help users focus ✅ IMPLEMENTED

**Status**: `implemented` — backed by the `cognitive.focus-budget` gate

**What it covers**: Reducing extraneous cognitive load and maintaining user attention. Two dimensions:

#### A) Content cognitive-density

| Metric | Threshold | Configurable |
|--------|-----------|--------------|
| Coleman-Liau reading grade | ≤ 10 | `FOCUS_GRADE_WARN` / `cognitive.config.json` |
| Average sentence length | ≤ 20 words | `FOCUS_SENT_WARN` |
| Jargon/acronym density | ≤ 0.5 per 100 words | `FOCUS_JARGON_PER_100` |
| Section word count (without subheadings) | ≤ 200 words | `FOCUS_SECTION_WORD_MAX` |

#### B) Interaction/attention DOM patterns

| Pattern | Check | Severity |
|---------|-------|----------|
| Auto-opening dialogs | `<dialog open>` on load | Error |
| Autoplay video/audio | `<video autoplay>`, `<audio autoplay>` | Error |
| Time limits | `<meta http-equiv="refresh">` | Error |
| Inline focus-ring removal | `outline:none`/`outline:0` in style attr | Error |
| Animation without motion guard | CSS `animation`/`transition` without `@media (prefers-reduced-motion)` | Warn |
| Missing "where am I" | No `[aria-current]` in navigation | Warn |
| Competing primary CTAs | > 2 primary-style CTAs per section | Warn |

**Gate**: `gates/cognitive/focus-budget-gate.mjs`

**Evidence key**: `focusBudget` in `conformance-evidence.json`

**Evidence type**: `"agent/static interface-complexity proxy for COGA Obj-5 — NOT COGA usability testing"`

**Honest labeling**: The `cognitive.focus-budget` criterion reports `not-yet-met` when thresholds are breached. This is honest reporting — the gate does NOT auto-fix content. Editorial decisions (rewriting, simplifying, adding definitions) are the maintainer's call.

**Current site baselines**:
- **bounded.tools**: grade ≈ 12.9, avg sentence ≈ 25.1, 16 unexpanded jargon terms → `not-yet-met`
- **robertdelanghe.dev**: grade ≈ 16.6, avg sentence ≈ 26.4, 5 jargon hits → `not-yet-met`

Both sites exceed reading-grade and sentence-length thresholds. The gate reports this honestly. Fixing requires editorial work (the maintainer's call), not a code change.

---

### Objective 6 — Ensure processes do not rely on memory

**Status**: `not-assessed`

**What it covers**: No reliance on short-term memory across steps, visible progress indicators for multi-step processes, persistent display of previously entered information, no memory puzzles (CAPTCHAs that require recall).

**Why not-assessed**: This site has no multi-step processes or forms requiring memory. If sign-up flows, checkout, or wizard-style UIs are added, this objective becomes relevant.

**Future path**: Process walkthrough review with COGA participants when interactive flows are added.

---

### Objective 7 — Provide help and support

**Status**: `not-assessed`

**What it covers**: Contextual help, tooltips, glossaries, human support options, clear "contact us" paths, FAQs, error documentation.

**Why not-assessed**: Requires a review of the support mechanisms available on the site, and participant testing to verify they are discoverable and usable.

**Future path**: Review current help affordances against COGA help-and-support patterns.

---

### Objective 8 — Support adaptation and personalization

**Status**: `not-assessed`

**What it covers**: Support for user agent customization (font size, spacing, color schemes), respect for OS-level accessibility settings (`prefers-reduced-motion`, `prefers-color-scheme`, `prefers-contrast`), personalization APIs (COGA `personalization` attribute), symbol support.

**Partial overlap**: The `cognitive.focus-budget` gate checks for `prefers-reduced-motion` guards on animations (Obj-5 boundary; also supports Obj-8). CSS baseline check verifies progressive enhancement. Neither covers the full Obj-8 scope.

**Future path**: COGA personalization attribute review; `prefers-color-scheme` + `prefers-contrast` audit; user testing with AT settings varied.

---

## Gate summary

| Gate | Criterion | Tier | Status |
|------|-----------|------|--------|
| `gates/a11y-heuristic-gate.mjs` | `a11y.agent-heuristic-review` | Tier 2 | Implemented (non-gating) |
| `gates/cognitive/focus-budget-gate.mjs` | `cognitive.focus-budget` | Cognitive | Implemented (non-gating) |
| (manual review) | `cognitive.coga-usability-testing` | Cognitive | `not-assessed` |

## Run gates locally

```sh
# A11y heuristic review (static runner — no browser)
node vendor/conformance-kit/gates/a11y-heuristic-gate.mjs dist

# A11y heuristic review (playwright runner — adds a11y tree snapshot + axe)
A11Y_RUNNER=playwright node vendor/conformance-kit/gates/a11y-heuristic-gate.mjs dist

# COGA Obj-5 focus budget
node vendor/conformance-kit/gates/cognitive/focus-budget-gate.mjs dist

# With strict mode (fail on content-density threshold breaches too)
node vendor/conformance-kit/gates/cognitive/focus-budget-gate.mjs dist --strict
```

## Configuring thresholds

Create a `cognitive.config.json` in the project root (one level above `dist/`):

```json
{
  "gradeWarn": 10,
  "sentWarn": 20,
  "jargonPer100": 0.5,
  "sectionWordMax": 200,
  "allowlist": "slsa,oidc,sbom,spdx"
}
```

Or set env vars: `FOCUS_GRADE_WARN`, `FOCUS_SENT_WARN`, `FOCUS_JARGON_PER_100`, `FOCUS_SECTION_WORD_MAX`, `FOCUS_ALLOWLIST`.

---

## Design philosophy

**Obj-5 is personal.** The maintainer has ADHD. This gate is designed to genuinely serve attention needs, not tick boxes:

- Thresholds are set at cognitively accessible levels (grade 10 = comfortable for most adult readers), not at "acceptable corporate text" levels (grade 14+).
- Jargon terms are flagged because unexplained acronyms interrupt reading flow — particularly for users with cognitive disabilities who may not recognize them.
- Animation guards matter: unsuppressed animation can be profoundly disruptive for people with ADHD, vestibular disorders, and epilepsy.
- Auto-opening dialogs and autoplay are blocking errors, not warnings — they are known ADHD/anxiety triggers with broad research backing.

The gate reports `not-yet-met` honestly when content exceeds thresholds. It does not mass-rewrite content (editorial is the maintainer's call). It surfaces the problem; the human fixes it.
