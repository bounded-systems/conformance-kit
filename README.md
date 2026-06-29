# @bounded-systems/conformance-kit

A standalone, **site-agnostic web-conformance toolkit**: build-integrity tooling,
fail-closed conformance gates, and provenance generators — extracted from
`bdelanghe/site` and `bounded-systems/site` and **generalized** so a site vendors
**one kit** instead of duplicating scripts.

Every site value (paths, thresholds, site URL, account/repo id, issuer/DID, SHACL
shapes, the markdown renderer, the prose corpus, the build itself) is an **INPUT**,
injected by the consumer via CLI args, env vars, or a passed config. Nothing here
hardcodes `robertdelanghe.dev`, `bounded.tools`, an account, or an email.

```
integrity/    verify-site · verify (sigstore) · gen-sitemanifest · gen-provenance · structure-audit · http-probe
gates/        sbom (gen + completeness) · shacl-runner · seo-gate · axe-gate (axe-core a11y) · vuln-gate (npm audit) · html-validator-gate (vnu) · baseline-gate (web-features) · jargon-gate (plain-language) · readability-gate · commonmark-runner · semantic (lone)
gates/        Token Accessibility suite (static token-level a11y → TOKEN-A11Y.md): palette · pairing-extractor · typography · target-size · opacity-contrast · likeness · token-a11y (unified runner)
gates/conformance/  conformance-report — lone's conformance() projection (Node port of jsr:@bounded-systems/lone@0.4) + a generic HTML renderer
generators/   gen-cid (IPFS UnixFS) · gen-identity (did:web + VC) · gen-snapshots (reader/markdown) · gen-print-snapshots (PDF) · openapi (static-API helper core)
emitters/     reprDigest (RFC 9530) · securityTxt (RFC 9116) · webManifest · markdown-sibling headers
lib/          schema-validate (zero-dep JSON Schema) · config (env/arg helpers)
fixtures/ test/  isolated verification of the generic logic
```

Design rules: zero-dep where the source was zero-dep; pure/offline gates read only
the built output; deterministic generators are a function of their inputs (no wall
clock); fail-closed (`exit 1`) on any violation.

## Install / vendor

Three consumption models:

1. **Vendor (recommended, matches the existing `vendor/integrity/` pattern).** Copy
   the kit at a pinned commit into `vendor/conformance-kit/`, write a hash-pin
   manifest (see [`vendor.example.json`](./vendor.example.json) — mirrors
   `bdelanghe/site` `vendor/integrity/provenance.json`: `source`, `commit`,
   `fetched`, `files{path: sha256}`), and verify against it before every use. The
   site then `import`s / invokes the vendored copies. The kit's own
   [`provenance.json`](./provenance.json) records which source repo + commit each
   tool was generalized from.
2. **npm dep.** `npm i @bounded-systems/conformance-kit` and use the `ck-*` bins
   (see `package.json`) or `import` the library modules.
3. **Nix flake (reproducible, runtime-bundled).** `nix run
   github:bounded-systems/conformance-kit#ck-axe-gate -- dist`, or add the flake to
   a `home-manager` / `nix profile`. Each `ck-*` bin is a hermetic, pinned closure;
   the gates that shell out get their runtime bundled in — `ck-html-validator-gate`
   carries a JRE for vnu, `ck-vuln-gate` carries npm — so no JRE/Node on `$PATH` is
   needed. (`ck-axe-gate` still needs a browser the consumer supplies via
   `$AXE_RUNNER`: `tezcatl` or Playwright.)

Runtime deps are declared in `package.json` (only the gates that need them pull
them: `linkedom`/`@mozilla/readability` for structure-audit; `jsonld`/`n3`/
`@zazuko/env-node`/`rdf-validate-shacl` for the SHACL runner; `sigstore` for the
in-process verifier). The Deno semantic runner pins its imports in
`gates/semantic/deno.json`.

## Tools — what each does + **how a site consumes it** (the input it must supply)

### integrity/

| Tool | Invoke | Consumer supplies |
|---|---|---|
| `gen-sitemanifest.mjs` | `DIST=dist node …/gen-sitemanifest.mjs` | `$DIST` (build dir). Optional `$MANIFEST_EXCLUDE` (extra platform control files). Emits `$DIST/site.sha256`. |
| `gen-provenance.mjs` | run at deploy after signing | GitHub Actions env (`GITHUB_*`), `$OCI_REF`/`$OCI_DIGEST`, optional `$PROVENANCE_DOC_URL`, `$DIST`. The emitted `builder.repository` becomes the identity the verifiers enforce. |
| `verify-site.mjs` | `node …/verify-site.mjs <https://site \| ./dist>` | A deployed site (or local dir) carrying `provenance.json` + `site.sha256` + its `.sigstore.json` bundle. Identity is read from `provenance.builder.repository` — nothing hardcoded. Shells to `cosign` if present, else SKIPs with a recipe. |
| `verify/verify.mjs` | `node …/verify/verify.mjs <url\|dir>` | Same inputs; verifies the Sigstore **bundle** in-process (offline) via `sigstore-js`. |
| `structure-audit/audit.mjs` | `node …/audit.mjs <distDir> [--check]` | `<distDir>`. Optional `$STRUCTURE_ARTICLE_PREFIX` (default `blog/`), `$STRUCTURE_ERROR_PAGE` (default `404.html`), `$STRUCTURE_AUDIT_SIDECARS` (deploy-time live paths, e.g. `/resume.pdf`), `$STRUCTURE_BASELINE` (where the committed `structure.json` lives — keep it in the **consumer**, not the vendored kit). |
| `http-probe.mjs` | `node …/http-probe.mjs <https://site> [config.json]` | A live URL **and** a probe config: `$PROBE_CONFIG`/2nd arg JSON `{htmlRoutes,typed,missing}`, or `$PROBE_HTML_ROUTES`+`$PROBE_MISSING`. Routes are NOT hardcoded. |

### gates/

| Tool | Invoke | Consumer supplies |
|---|---|---|
| `sbom/gen-sbom.mjs` | `ROOT=. DIST=dist node …/gen-sbom.mjs` | `$ROOT` (lockfiles live here), `$SBOM_LOCKFILES` (comma list, default `package-lock.json`), `$SBOM_NAME`, `$SBOM_NAMESPACE_BASE`, `$SBOM_CREATORS`. Reads `flake.lock` if present. Emits `$DIST/sbom.spdx.json`. |
| `sbom/check-sbom.mjs` | `ROOT=. DIST=dist node …/check-sbom.mjs` | Same `$ROOT`/`$DIST`. Fails closed unless pinned-set ⊆ SBOM ⊆ pinned-set and (optionally) the in-toto attestation reconciles. |
| `shacl-runner.mjs` | `node …/shacl-runner.mjs <shapes.ttl> <htmlDir>` | **The SHACL shapes file stays in the site** (its structured-data contract) + the built-HTML dir. Optional `$SHACL_CONTEXT` (custom offline JSON-LD context; default schema.org). Fails unless every JSON-LD block `conforms: true`. |
| `seo-gate.mjs` | `node …/seo-gate.mjs [distDir]` | `$DIST`. Optional `$SEO_ERROR_PAGE`, `$SEO_DEPLOY_SIDECARS`. Enforces canonical/title/description uniqueness + self-consistency, robots.txt (RFC 9309), sitemap, internal links. |
| `axe-gate.mjs` | `node …/axe-gate.mjs [distDir]` | `$DIST`. Optional `$AXE_PAGES` (comma list, default: every `*.html` in dist), `$AXE_TAGS` (default `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa`), `$AXE_IMPACT_THRESHOLD` (`minor`/`moderate`/`serious`/`critical`, default `serious`), `$AXE_RUNNER` (`playwright` (CI, needs `playwright` + `@axe-core/playwright` + `npx playwright install chromium`) \| `tezcatl` (macOS WebKit, local)), `$AXE_REPORT` (write the JSON report). Serves dist over an ephemeral origin (so assets resolve), runs **axe-core** per page, and **fails closed** on any violation at/above the threshold. The emitted report's `axe: { serious, critical }` envelope is exactly what `conformance-report`'s `a11y.axe-serious-critical` criterion consumes — a clean run is what lets a site honestly assert it. |
| `vuln-gate.mjs` | `node …/vuln-gate.mjs [projectDir]` | `$VULN_ROOT` (lockfile lives here, default `.`). Optional `$VULN_OMIT_DEV` (`true`→production deps only, default `true`), `$VULN_THRESHOLD` (highest tolerated known critical/high, default `0`), `$VULN_REPORT` (write the JSON report). Runs **`npm audit`** and **fails closed** when the known critical/high count exceeds the threshold. The report's `vulns: { knownCriticalOrHighVulns }` envelope is what `conformance-report`'s `security.no-critical-vulns` criterion consumes. |
| `html-validator-gate.mjs` | `node …/html-validator-gate.mjs [distDir]` | `$HTML_DIST`. Optional `$HTML_PAGES` (comma list, default: every `*.html`), `$HTML_THRESHOLD` (default `0`), `$HTML_REPORT`. Runs **vnu** (the Nu Html Checker, a self-contained Java jar — needs a JRE) `--errors-only` over the built pages and **fails closed** above the threshold. The report's `htmlValidator: { errors }` envelope is what `conformance-report`'s `html.validator-clean` criterion consumes. |
| `baseline-gate.mjs` | `node …/baseline-gate.mjs [cssGlob]` | `$BASELINE_CSS` (default `dist/**/*.css`). Optional `$BASELINE_TARGET` (`widely`/`newly`, default `widely`), `$BASELINE_REPORT`. Maps the shipped CSS to **web-features Baseline** data (via `stylelint-plugin-use-baseline` — headless, no browser) and **fails closed** when the site-wide status is below target. A feature behind an `@supports` query is a tested fallback and doesn't count against it. The report's `baseline: { status, fallbackTested }` envelope is what `conformance-report`'s `compatibility.baseline` criterion consumes. |
| `palette-gate.mjs` | `node …/palette-gate.mjs <tokens.(json\|css)> <pairings.json>` | **Two inputs the consumer supplies**: a token map (a DTCG `tokens.json` — primitive→semantic aliases resolved — or a `tokens.css` of `--name: #hex` custom properties) and a `pairings.json` declaring the fg/bg pairs that actually co-occur (`{ "pairings":[{fg,bg,kind,size?,weight?,name?}], "categorical":[…], "thresholds":{…} }`; `kind` ∈ `text`\|`large-text`\|`ui`, `fg`/`bg` are token names or literal `#hex`). Runs **static colour-palette analysis** — zero-dep, every primitive computed by hand: (1) **CVD-safe contrast** — simulates each colour under deuteranopia/protanopia/tritanopia (**Machado-2009** matrices), recomputes the WCAG ratio per pair under each, and flags any pair dropping below AA, plus **categorical collapse** (CIEDE2000 ΔE below `$PALETTE_COLLAPSE_DELTAE`, default 10) post-transform; (2) **APCA** — implements **APCA-W3 ~0.1.9**, reports `Lc` per text pair against a font-size/weight-aware (or baseline `$PALETTE_MIN_LC_TEXT` 60 / `$PALETTE_MIN_LC_LARGE` 45) minimum, **alongside** the WCAG-2 ratio (complement, not replacement); (3) **non-text contrast** — `kind:'ui'` pairs require ≥3:1 (WCAG 2.2 **SC 1.4.11**). Thresholds are config-driven (`pairings.json` `thresholds` ⊕ `$PALETTE_MIN_RATIO_{TEXT,LARGE,UI}`) and it **fails closed** on any failure. `$PALETTE_REPORT` writes the per-pair JSON (WCAG ratio · APCA Lc · per-CVD ratios · pass/fail per check). The report's `palette: { cvdSafe, apcaBaseline, nonTextContrast }` envelope is what a future `palette.*` criterion consumes. |
| `jargon-gate.mjs` | `node …/jargon-gate.mjs [distDir] [--strict]` | `$JARGON_DIST`. Optional `$JARGON_ALLOWLIST` (comma list of accepted terms), `$JARGON_MIN_LENGTH` (default `3`), `$JARGON_THRESHOLD` (default `0`, for `--strict`), `$JARGON_REPORT`. Flags **undefined jargon** in the prose: words not in a 275k-word English dictionary (compounds/possessives atomized first) that the page does not **define** via `<abbr title>`, `<dfn>`, or a `<dl>` glossary — for W3C COGA / WCAG 3.1.3 Unusual Words and for AI readers. WARN-only by default; `--strict` fails closed. Report carries a `plainLanguage: { undefinedJargon, glossaryPresent }` envelope (for a future `cognitive.plain-language` criterion). |
| `typography-gate.mjs` | `node …/typography-gate.mjs <type-tokens.(json\|css)> [config.json]` | **Token Accessibility suite.** Type tokens (DTCG `$type:"typography"` recipes or `.bs-text-*` CSS) + a `config.json` declaring which styles are **body** (`{ "body":["body"], "thresholds":{…} }`). Static checks, each mapped to a SC: body **line-height ≥ 1.5** (1.4.12); **text-spacing achievability** — spacing/line-height in overridable relative units, never px-pinned (1.4.12); **min font-size** — body ≥ ~16px (warn) / ≥ ~12px hard floor (error) + modular-scale sanity (1.4.4); **weight×size legibility** — thin weight (≤200) at small size → error, plus a `requiredApcaLc` cross-link to the palette gate (1.4.3/1.4.8). Fails closed on any error; `$TYPO_REPORT` writes the JSON. |
| `target-size-gate.mjs` | `node …/target-size-gate.mjs <config.json>` | **Token Accessibility suite.** A `config.json` where the consumer **declares** which tokens are interactive targets (`{ "targets":[{name,width,height\|size,exception?,reason?}], "tokens":{…}, "thresholds":{minPx,aaaPx} }`). Enforces target **≥ 24×24px** (2.5.8 AA → error below) and reports **≥ 44×44px** (2.5.5 AAA) status; honours the 2.5.8 `inline`/`essential`/`user-agent`/`spacing` exceptions with an audit `reason`. No target tokens → `coverage:"none"` (vacuous pass + gap note). `$TARGET_REPORT` writes the JSON. |
| `opacity-contrast-gate.mjs` | `node …/opacity-contrast-gate.mjs <tokens.(json\|css)> <usages.json>` | **Token Accessibility suite — the cross-cutting guard.** Token map + a `usages.json` declaring "opacity applied to a foreground" usages (`{ "usages":[{fg,bg,opacity,kind,name?}], "opacityTokens":{…}, "thresholds":{…} }`; `opacity` is 0..1 or a `{token}` ref). Composites fg over bg (Porter-Duff source-over) at the stated alpha and requires the **effective** WCAG contrast ≥ floor (4.5 text / 3 large/ui — 1.4.3/1.4.11), reporting both nominal and effective ratio so the drop is visible. Translucent-over-unknown-backdrop usages are flagged for review, not passed. Catches the bounded.tools opacity regression class. `$OPACITY_REPORT` writes the JSON. |
| `likeness-gate.mjs` | `node …/likeness-gate.mjs <tokens.(json\|css)> [config.json]` | **Token Accessibility suite.** Two CIEDE2000 checks over the colour tokens: **near-duplicate** tokens (ΔE < ~2 ⇒ perceptually identical ⇒ consolidate candidate — warning, escalatable) and **confusable categoricals** (consumer-declared distinct sets that collapse under normal vision *or* deuteranopia/protanopia/tritanopia — error; supports 1.4.1). Config: `{ "categorical":[{name,members}], "ignore":[…], "thresholds":{dupDeltaE,collapseDeltaE,dupSeverity} }`. `$LIKENESS_REPORT` writes the JSON. |
| `pairing-extractor.mjs` | `node …/pairing-extractor.mjs <tokens.(json\|css)> <style1.css> [style2.css …]` | **Token Accessibility suite — coverage engine.** Derives the real fg×bg pairings from **actual stylesheet usage** (resolves `var(--token)`/literal colours; pairs by same-rule co-occurrence → ancestor-selector containment → root surface, tagged `rule`/`surface`/`root` confidence), **unions** any declared `$PAIRING_DECLARED` pairings in, scores every pair through the palette check, and emits a **pairing matrix** (WCAG · APCA Lc · per-CVD ratios) to `$PAIRING_MATRIX` (Markdown) / `$PAIRING_REPORT` (JSON). No DOM ⇒ a reviewed **superset** (over-generates safely); **report-only** unless `$PAIRING_GATE=1`. Removes the hand-maintained pairings list that let the opacity bug slip. |
| `token-a11y.mjs` | `node …/token-a11y.mjs <token-a11y.json>` | **Token Accessibility suite — unified runner** (`ck-token-a11y`). One `token-a11y.json` drives every member (palette · pairing · typography · targetSize · opacity · likeness) over one token map and **fails closed** if any fails. See [`TOKEN-A11Y.md`](./TOKEN-A11Y.md) for the standard. `$TOKEN_A11Y_REPORT` writes the aggregate JSON. |
| `readability-gate.mjs` | `node …/readability-gate.mjs <corpus.json> [--strict]` | **The corpus is an input** the site assembles from its copy: a JSON array of `{id,text}` or an `{id:text}` map. Optional `$READABILITY_THRESHOLDS`, `$READABILITY_MIN_WORDS`, `$READABILITY_KNOWN_ACRONYMS`. WARN-only unless `--strict`. |
| `ai-readability-gate.mjs` | `node …/ai-readability-gate.mjs [distDir]` | Re-proves lone's `semantic.ai-readability` at build time: emits `{llmsTxtPresent, linksResolve, markdownSiblings}` — checks `llms.txt` exists, its internal links resolve (and none hit `$AIR_PRIVATE` paths), and every content page has a Markdown sibling (`$AIR_SIBLING_SUFFIX`, default `.md`; `$AIR_SIBLING_IGNORE` defaults to `404`). Fail-closed (`$AIR_STRICT=0` to report only); `$AIR_REPORT` writes the evidence JSON. Static only — the `Accept: text/markdown` content-negotiation half is served-edge behaviour, probe it with `ck-http-probe`. |
| `commonmark-runner.mjs` | `node …/commonmark-runner.mjs <renderer.mjs> [fixtures.json]` | **The site's markdown renderer module** (export `renderMarkdown`, or set `$COMMONMARK_RENDER_EXPORT`). Default fixtures pin a safe CommonMark subset + 4 hostile-HTML escapes; a site with a different renderer supplies its own `fixtures.json`. |
| `semantic/gate.ts` | `deno run --allow-read --allow-net …/gate.ts` | Built HTML in `$SEMANTIC_DIR` (default `dist/blog`); `$SEMANTIC_SELECTOR` (subject node, default `article`). Imports `jsr:@bounded-systems/lone`; any error-severity finding fails CI. |
| `conformance-report.mjs` | `import { buildConformanceReport, renderConformanceReport } from "…/gates/conformance-report.mjs"` | **The site's evidence** — `loneFindings` (the semantic gate's DOM findings, or `null` when no DOM was blessed → those criteria report `not-assessed`) + an external-evidence envelope whose fields it gathers from its own gates (`jsonLdShacl`, `sbom`, `contentDigests`, `slsaProvenance`, …). `renderConformanceReport(report, { evidenceHref })` → a class-based HTML fragment; the consumer wraps it in its template and supplies per-criterion evidence URLs. Zero-dep; the conformance MODEL is a Node port of `jsr:@bounded-systems/lone@0.4`'s `conformance()` in `gates/conformance/`. |

The conformance projection makes overclaim impossible by construction: the strong
compact claim (`COMPACT_CLAIM`) is emitted **only** when every tier-1 `required`
criterion has passing evidence; unsupplied criteria (manual WCAG audit, OWASP ASVS,
field Core Web Vitals, Baseline) are `not-assessed`, never `met` — so automation can
never print "WCAG 2.2 AA" or "ASVS conformant" on its own. tier-2/tier-3/cognitive
criteria are reported + summarised per area but never widen the headline claim.

### generators/

| Tool | Invoke | Consumer supplies |
|---|---|---|
| `gen-cid.mjs` | `DIST=dist node …/gen-cid.mjs` | `$DIST`. Walks the `site.sha256` file set (or `dist`), computes the IPFS UnixFS dir CIDv1 with no daemon, records it into `$DIST/provenance.json`. |
| `gen-identity.mjs` | `IDENTITY_DOMAIN=… IDENTITY_REPO=owner/repo node …/gen-identity.mjs` | `$IDENTITY_DOMAIN`, `$IDENTITY_REPO` (cert-identity regexp), `$IDENTITY_SUBJECT` (the credentialSubject JSON, default `$DIST/resume.json`), optional `$IDENTITY_SUBJECT_SCHEMA`, `$IDENTITY_VC_NAME/DESCRIPTION`, `$IDENTITY_VALID_FROM_PATH`. Emits `did.json` + a W3C VC 2.0. |
| `gen-snapshots.mjs` | `node …/gen-snapshots.mjs [distDir]` | `$SNAPSHOT_DIST` (default `dist`). Optional `$SNAPSHOT_PAGES`, `$SNAPSHOT_BASE_URL` (recorded as `source` in the front-matter), `$SNAPSHOT_SUFFIX` (default `.reader`). For every built page, runs **@mozilla/readability** (the Firefox/Safari Reader engine, via `linkedom` — headless, no browser) and writes a clean reader **`<page>.reader.html`** + an analysis-friendly **`<page>.reader.md`** (YAML front-matter + Markdown via `turndown`). The Markdown is the durable, diffable twin of the page — far easier to run NLP/LLM analysis over than scraping live HTML — and doubles as the AI-readable Markdown sibling. (The printed/PDF view needs a print-CSS renderer and is a separate generator.) |
| `gen-print-snapshots.mjs` | `node …/gen-print-snapshots.mjs [distDir]` | `$PRINT_DIST` (default `dist`). Optional `$PRINT_PAGES`, `$PRINT_RENDERER` (default `tezcatl`, or a `"cmd {url} {out}"` template), `$PRINT_WAIT` (default `600`), `$PRINT_SUFFIX` (default `.print`). The print/PDF twin of `gen-snapshots`: serves `dist` over an ephemeral origin (so assets resolve) and renders each page's `@media print` view to **`<page>.print.pdf`** via **tezcatl** (macOS-native WebKit — no Chromium). A LOCAL / macOS-deploy artifact: on a host without the renderer (e.g. a Linux CI runner) it **SKIPS** with a note. |
| `openapi.mjs` | `import { sortKeys, writeApiFile, embedSchema, jsonResponse, validateOpenapi }` | The **generic core** of a static-API generator. The per-endpoint projection of a site's contracts (profile/posts/corpus/VC, etc.) stays in the site's build; this module provides deterministic JSON output, schema embedding, and OpenAPI 3.1/3.2 well-formedness validation. Pair with `lib/schema-validate.mjs` to self-check emitted docs. |

### emitters/

`import { reprDigest, securityTxt, securityTxtExpires, webManifest, markdownSiblingHeaders } from "…/emitters/index.mjs"` — pure helpers a site's own `build.mjs` calls to emit standards-compliant artifacts (RFC 9530 `Repr-Digest`, RFC 9116 `security.txt`, the W3C web app manifest, the `_headers` Content-Type rules for `.md` siblings). All values injected; the page **content** stays in the site.

## `@bounded-systems/verify` (vendored here; published elsewhere)

The in-process Sigstore verifier (`integrity/verify/verify.mjs`) is **vendored** in
this kit so sites can pull it into a hermetic build. It is no longer **published**
from here: the canonical home of the [`@bounded-systems/verify`](https://jsr.io/@bounded-systems/verify)
JSR package is now its own repo,
[`bounded-systems/verify`](https://github.com/bounded-systems/verify). That repo owns
the package manifest (`deno.json`) and the keyless-OIDC release workflow; cut releases
there. The copy here is kept byte-for-byte in sync with the published source.

Consumers run it straight from JSR:

```sh
deno run -A jsr:@bounded-systems/verify https://your-site
```

## Test

```
npm install && npm test    # cases against fixtures/, in isolation
```

The suite verifies the generic logic end-to-end: gen-sbom against a sample lockfile;
shacl-runner against sample shapes+HTML → `conforms: true`; structure-audit / seo /
readability / commonmark against sample inputs; gen-sitemanifest + gen-cid + verify-site
round-trip on a sample build; gen-identity; the emitter/openapi/schema helpers; the
conformance projection; and the **axe-gate** (its classification/threshold/report logic
deterministically, plus a real end-to-end pass on the known-bad + known-good
`fixtures/axe/` snippets when a browser engine — tezcatl or Playwright/Chromium — is on
PATH; skipped, like the cosign step, when none is). (The Deno semantic runner is
exercised by the consuming site, as it needs Deno + JSR.)

## Provenance / determinism

The gates are pure functions of the built output; the generators are deterministic
functions of their inputs (the SBOM creation date is derived from `flake.lock`, never
a wall clock; the CID re-derives from the served bytes with any IPFS implementation).
Site-specific artifacts — SHACL shapes, the prose corpus, the markdown renderer,
thresholds, copy, and `build.mjs` itself — are inputs, never part of the kit.
