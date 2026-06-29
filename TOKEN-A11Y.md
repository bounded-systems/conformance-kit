# The Token Accessibility standard

**Token Accessibility** is the conformance bar for a design system's **tokens** — the
colour, type, size, spacing and opacity values it ships — *before* any of them is
rendered into a page. It is the static, per-source counterpart to the page-level a11y
gates (axe, HTML validation): instead of asking "is this rendered DOM accessible?", it
asks **"do these tokens PERMIT accessible use, or do they bake a barrier into the
source of truth everything downstream inherits?"**

A barrier caught here is caught once, at the root, for every surface that consumes the
tokens — and long before it ships. This document is the standard: every constraint the
suite enforces, mapped to its WCAG 2.2 Success Criterion, with an honest statement of
what static token analysis **can** and **cannot** verify.

> **The honest scope, stated once and meant throughout.** A token is a *permission*,
> not a *render*. This suite verifies tokens **do not preclude** accessible use and
> **do not bake in** a known barrier. It cannot verify that every rendered instance is
> accessible — real backdrops, real DOM nesting, real font files, and real user
> overrides are runtime facts. Where a check depends on a runtime fact (the actual
> backdrop, the actual hit-box, "no loss of content"), this document says so, and the
> page-level gates (axe-gate) plus a manual audit cover the rest. Claim **"tokens meet
> the Token Accessibility standard"**, never "the site is accessible".

The suite is **zero-dependency** and **fails closed**: every colour-science / APCA /
ΔE primitive is computed by hand and cited inline; any error-severity finding exits
non-zero. Thresholds are config-driven (per-member config ⊕ env) so a consumer tunes
the bar without forking the gates.

---

## Members and the criteria they enforce

| # | Member (gate) | What it checks | WCAG 2.2 SC | Static scope (can / cannot) |
|---|---|---|---|---|
| 1 | **palette** (`palette-gate.mjs`) | CVD-safe contrast (Machado-2009), APCA Lc, non-text contrast, categorical collapse over declared fg/bg pairs | 1.4.3, 1.4.11, 1.4.1 | **can**: the colour math for every declared pair under normal + 3 CVD types · **cannot**: that the pair actually co-occurs (→ pairing extractor) |
| 2 | **pairing extractor** (`pairing-extractor.mjs`) | derives the real fg×bg pairings from stylesheet usage, feeds the palette check, emits the pairing matrix | (coverage for 1.4.3/1.4.11) | **can**: every fg/bg the CSS *plausibly* puts together · **cannot**: the exact cascade (no DOM) — output is a reviewed **superset** |
| 3 | **typography** (`typography-gate.mjs`) | body line-height ≥ 1.5; spacing achievable; min font-size; weight×size legibility | 1.4.12, 1.4.4, 1.4.8 | **can**: the authored values + their unit (overridable?) · **cannot**: "no loss of content" when the user applies overrides |
| 4 | **target-size** (`target-size-gate.mjs`) | interactive target tokens ≥ 24×24 (AA), ≥ 44×44 status (AAA) | 2.5.8, 2.5.5 | **can**: that the declared size token clears the floor · **cannot**: the rendered hit-box or the spacing-offset exception |
| 5 | **opacity-contrast** (`opacity-contrast-gate.mjs`) | composites a translucent foreground over its backdrop and requires **effective** contrast ≥ floor | 1.4.3, 1.4.11 | **can**: the effective contrast for a *declared* backdrop · **cannot**: an unknown/photographic backdrop (flagged for review) |
| 6 | **likeness** (`likeness-gate.mjs`) | near-duplicate tokens (ΔE < JND); confusable categoricals (collapse under CVD) | 1.4.1 (+ hygiene) | **can**: perceptual distance of the values · **cannot**: whether a near-duplicate is *intended* (→ warning, human decides) |

The **unified runner** (`token-a11y.mjs`, bin `ck-token-a11y`) drives all members from
one `token-a11y.json` config over one token map and fails closed if **any** member fails.

---

## 1. Palette — colour contrast & distinctness (`palette-gate.mjs`)

The founding member. For every consumer-declared fg/bg pair it computes the WCAG-2
contrast ratio, the **APCA-W3** Lc (reported alongside, the WCAG-3 candidate metric),
and re-checks contrast with **both colours simulated** under deuteranopia / protanopia /
tritanopia (Machado-2009 matrices); categorical colours are checked for **collapse**
(CIEDE2000 ΔE below a floor) post-transform.

- Normal text ≥ **4.5:1** — **SC 1.4.3** (AA).
- Large text ≥ **3:1** — **SC 1.4.3** (AA).
- Non-text (`kind:"ui"`: borders, focus rings, icon glyphs) ≥ **3:1** — **SC 1.4.11**.
- CVD-safe: each pair must also clear its floor under every CVD type — supports **SC 1.4.1**
  (information not conveyed by colour alone) by proving the colours stay legible for CVD viewers.
- Categorical distinctness: chart/status colours stay ≥ ΔE apart under all CVD — **SC 1.4.1**.

**Scope:** verifies the colour math for the pairs it is *given*. Completeness of that
list is the pairing extractor's job. See `gates/palette-gate.mjs` header for the full
algorithm citations (WCAG luminance, sRGB transfer, CIEDE2000 Sharma et al. 2005,
APCA-W3 ~0.1.9, Machado 2009).

## 2. Pairing coverage — extract pairings from usage (`pairing-extractor.mjs`)

A hand-maintained `pairings.json` is only as complete as its author's memory — and a
missed combo is exactly how an opacity-contrast regression slipped into production. The
extractor removes the human from coverage: it parses the stylesheet(s), resolves
`var(--token)` and literal colours against the token map, and derives the fg×bg pairs
that actually co-occur:

1. **rule** confidence — a rule sets both a foreground and a background ⇒ definite pair.
2. **surface** confidence — a foreground-only rule is paired with the nearest **ancestor**
   selector (by selector-string prefix) that declares a background.
3. **root** confidence — otherwise paired with the `:root`/`html`/`body` surface.

`border-color`/`outline-color` foregrounds are tagged `kind:"ui"`; the rest default to
`text`. Results are de-duplicated and **unioned** with any declared pairings
(declared ∪ extracted), then every pair is scored and rendered as a **pairing matrix**
(WCAG ratio · APCA Lc · per-CVD ratios · pass) so a reviewer can *see* what co-occurs.

**Scope (read this before trusting a row):** with no DOM there is no true cascade, so
containment-by-prefix is a heuristic. It **over-generates** (a light foreground may be
attributed to the root surface when its real backdrop is a dark panel) rather than
under-generates — a superset is the safe direction for coverage. The `confidence`
column is the trust signal: `rule`/`surface`/`declared` are reliable; `root` rows are
the ones to verify. The extractor is therefore **report-only by default** (set
`gate:true` / `$PAIRING_GATE=1` only once the matrix has been reviewed and backdrops
pinned). It is a *coverage and review* surface, not an oracle.

## 3. Typography — type tokens (`typography-gate.mjs`)

Over the `$type:"typography"` recipes (or `.bs-text-*` CSS classes), with the consumer
declaring which styles are **body** text:

- **Body line-height ≥ 1.5** — **SC 1.4.12** (Text Spacing). 1.4.12 is authored as a
  *user-override* criterion ("no loss of content when the reader sets line-height to
  1.5"); a token check approximates its spirit by requiring the shipped body recipe not
  undercut 1.5 and (next bullet) remain overridable. Headings/labels are exempt.
- **Text-spacing achievability** — **SC 1.4.12**. The criterion guarantees the reader can
  reach letter-spacing ≥ 0.12em, word-spacing ≥ 0.16em, paragraph-spacing ≥ 2em,
  line-height ≥ 1.5. From tokens we cannot prove "no loss of content", but we **can**
  prove the tokens don't *preclude* it: spacing/line-height must be in **relative,
  overridable** units (unitless / em / rem / %), never pinned in px (a fixed line-box a
  user stylesheet can't scale past). A px-pinned body line-height or letter-spacing fails.
- **Minimum font size** — **SC 1.4.4** spirit / readability. Body ≥ ~16px (recommended;
  warn below) and a **hard floor** ~12px (error below). Plus a **modular-scale** sanity
  check: the size ramp must be monotonic with step ratios in a sane band (no inversions,
  no exact duplicates, no absurd jumps).
- **Weight × size legibility** — **SC 1.4.3/1.4.8** spirit + APCA. Hairline weights (≤200)
  at small sizes render as low-contrast strokes → error. Each style also carries a
  `requiredApcaLc` (from the palette gate's size/weight→Lc mapping) as a **cross-link**:
  thin/small text needs a *higher* Lc wherever it is coloured, which the palette gate enforces.

**Scope:** checks the authored values and their units. It cannot verify the rendered
line-box, the actual font file's hinting, or "no loss of content" — those are runtime.

## 4. Target size — interactive control tokens (`target-size-gate.mjs`)

The consumer **declares** which tokens are interactive-target dimensions (it is design
intent, not auto-detectable):

- **≥ 24×24px** — **SC 2.5.8** (AA). `min(width,height) < 24px` → error.
- **≥ 44×44px** — **SC 2.5.5** (AAA). Reported as **status** only (AAA, not a hard fail).
- **Exceptions** (2.5.8: `inline` / `essential` / `user-agent` / `spacing`) — a target may
  be marked exempt with a `reason`; it is recorded (not failed) and the reason surfaced
  so the claim stays auditable.

**Scope:** guards the *token* floor. Only the rendered DOM proves the actual bounding box
and the spacing-offset exception, so a token-clean result is necessary, not sufficient.
A design system with **no** target tokens reports `coverage: "none"` (a vacuous pass with
a gap note) — the honest answer is "not assertable from tokens; declare your control sizes".

## 5. Opacity contrast — the cross-cutting guard (`opacity-contrast-gate.mjs`)

The member that catches the bug class per-token contrast checks miss: a colour that
clears AA at full strength but is **applied at reduced opacity** (`opacity:.6`,
`color-mix(… N%, transparent)`, an `--alpha` token, `#rrggbbaa`) so the **effective,
composited** colour drops below contrast. For each declared "opacity-on-foreground"
usage it composites fg over bg at the stated alpha (Porter-Duff source-over, opaque
backdrop) and requires the **effective** contrast to clear the floor (4.5 text / 3
large/ui — **SC 1.4.3 / 1.4.11**), reporting both the nominal and effective ratio so
the drop is visible.

**Scope:** assumes the *declared* backdrop is the real one (the true backdrop is a
DOM/stacking fact). A translucent layer over an unknown/photographic background can't be
guaranteed statically — such usages are flagged `unknownBackdrop` for manual review
rather than passed.

## 6. Likeness & hygiene — distinctness (`likeness-gate.mjs`)

Two perceptual-distance checks on the colour tokens, both built on CIEDE2000:

- **Near-duplicate tokens** (hygiene, **warning**): any two distinct token *names* within
  ΔE < ~2 (below the ~2.3 just-noticeable-difference) are perceptually identical —
  redundant, a consolidate candidate, and a drift hazard (two names that silently mean
  the same colour diverge later). Reported as a warning (escalatable to error).
- **Confusable categoricals** (**error**): colours the consumer declares must stay distinct
  (status, chart series, map keys) are checked for collapse (ΔE below a floor) under
  normal vision **and** every CVD type — a categorical pair that collapses (especially
  only under a CVD) fails the design's own distinctness contract. Supports **SC 1.4.1**.

**Scope:** "redundant" is a claim about the *values*; whether a near-duplicate is
*intentional* (a 1-step hover state) is intent the gate can't read — hence warning, with
the ΔE surfaced for a human to decide.

---

## Wiring it (one config)

```jsonc
// token-a11y.json — every member optional; only declared members run.
{
  "tokens": "brand/tokens/tokens.css",
  "pairing":   { "tokens": "brand/tokens/tokens.css",
                 "css": ["brand/css/base.css", "brand/resume/resume.css"],
                 "declared": "pairings.json", "gate": false },
  "palette":   "pairings.json",
  "typography":{ "tokens": "brand/tokens/tokens.json", "body": ["body"] },
  "targetSize":{ "tokens": { "control-min": "44px" },
                 "targets": [{ "name": "button", "size": "{control-min}" }] },
  "opacity":   { "usages": [{ "fg": "ink", "bg": "paper", "opacity": 0.6, "kind": "text" }] },
  "likeness":  { "categorical": [{ "name": "status",
                 "members": ["grade-enforced", "grade-partial", "grade-aspirational"] }] }
}
```

```bash
ck-token-a11y token-a11y.json          # fails closed if any member fails
# or a single member:
ck-typography-gate brand/tokens/tokens.json typo.config.json
ck-opacity-contrast-gate brand/tokens/tokens.css opacity.usages.json
ck-pairing-extractor brand/tokens/tokens.css brand/css/*.css   # prints the matrix
```

CI wires `ck-token-a11y` as a build gate; the JSON reports (`$*_REPORT`) feed a future
lone `token-a11y.*` conformance criterion, exactly as the palette gate's
`palette:{cvdSafe,apcaBaseline,nonTextContrast}` envelope already does.

## Claiming conformance (honest language)

> **"Design tokens meet the Token Accessibility standard (conformance-kit)."** The token
> set is verified to *permit* accessible use: declared colour pairs clear WCAG 2.2
> contrast under normal and CVD vision, type tokens permit 1.4.12 spacing and clear the
> size floors, interactive-target tokens clear 2.5.8, translucent foregrounds keep
> effective contrast, and categorical colours stay distinct. **This is a token-source
> claim, not a site claim** — rendered-page conformance is established separately by the
> page-level gates and a manual WCAG 2.2 AA audit.
