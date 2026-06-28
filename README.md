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
gates/        sbom (gen + completeness) · shacl-runner · seo-gate · readability-gate · commonmark-runner · semantic (lone)
generators/   gen-cid (IPFS UnixFS) · gen-identity (did:web + VC) · openapi (static-API helper core)
emitters/     reprDigest (RFC 9530) · securityTxt (RFC 9116) · webManifest · markdown-sibling headers
lib/          schema-validate (zero-dep JSON Schema) · config (env/arg helpers)
fixtures/ test/  isolated verification of the generic logic
```

Design rules: zero-dep where the source was zero-dep; pure/offline gates read only
the built output; deterministic generators are a function of their inputs (no wall
clock); fail-closed (`exit 1`) on any violation.

## Install / vendor

Two consumption models:

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
| `readability-gate.mjs` | `node …/readability-gate.mjs <corpus.json> [--strict]` | **The corpus is an input** the site assembles from its copy: a JSON array of `{id,text}` or an `{id:text}` map. Optional `$READABILITY_THRESHOLDS`, `$READABILITY_MIN_WORDS`, `$READABILITY_KNOWN_ACRONYMS`. WARN-only unless `--strict`. |
| `commonmark-runner.mjs` | `node …/commonmark-runner.mjs <renderer.mjs> [fixtures.json]` | **The site's markdown renderer module** (export `renderMarkdown`, or set `$COMMONMARK_RENDER_EXPORT`). Default fixtures pin a safe CommonMark subset + 4 hostile-HTML escapes; a site with a different renderer supplies its own `fixtures.json`. |
| `semantic/gate.ts` | `deno run --allow-read --allow-net …/gate.ts` | Built HTML in `$SEMANTIC_DIR` (default `dist/blog`); `$SEMANTIC_SELECTOR` (subject node, default `article`). Imports `jsr:@bounded-systems/lone`; any error-severity finding fails CI. |

### generators/

| Tool | Invoke | Consumer supplies |
|---|---|---|
| `gen-cid.mjs` | `DIST=dist node …/gen-cid.mjs` | `$DIST`. Walks the `site.sha256` file set (or `dist`), computes the IPFS UnixFS dir CIDv1 with no daemon, records it into `$DIST/provenance.json`. |
| `gen-identity.mjs` | `IDENTITY_DOMAIN=… IDENTITY_REPO=owner/repo node …/gen-identity.mjs` | `$IDENTITY_DOMAIN`, `$IDENTITY_REPO` (cert-identity regexp), `$IDENTITY_SUBJECT` (the credentialSubject JSON, default `$DIST/resume.json`), optional `$IDENTITY_SUBJECT_SCHEMA`, `$IDENTITY_VC_NAME/DESCRIPTION`, `$IDENTITY_VALID_FROM_PATH`. Emits `did.json` + a W3C VC 2.0. |
| `openapi.mjs` | `import { sortKeys, writeApiFile, embedSchema, jsonResponse, validateOpenapi }` | The **generic core** of a static-API generator. The per-endpoint projection of a site's contracts (profile/posts/corpus/VC, etc.) stays in the site's build; this module provides deterministic JSON output, schema embedding, and OpenAPI 3.1/3.2 well-formedness validation. Pair with `lib/schema-validate.mjs` to self-check emitted docs. |

### emitters/

`import { reprDigest, securityTxt, securityTxtExpires, webManifest, markdownSiblingHeaders } from "…/emitters/index.mjs"` — pure helpers a site's own `build.mjs` calls to emit standards-compliant artifacts (RFC 9530 `Repr-Digest`, RFC 9116 `security.txt`, the W3C web app manifest, the `_headers` Content-Type rules for `.md` siblings). All values injected; the page **content** stays in the site.

## Test

```
npm install && npm test    # 11 cases against fixtures/, in isolation
```

The suite verifies the generic logic end-to-end: gen-sbom against a sample lockfile;
shacl-runner against sample shapes+HTML → `conforms: true`; structure-audit / seo /
readability / commonmark against sample inputs; gen-sitemanifest + gen-cid + verify-site
round-trip on a sample build; gen-identity; and the emitter/openapi/schema helpers.
(The Deno semantic runner is exercised by the consuming site, as it needs Deno + JSR.)

## Provenance / determinism

The gates are pure functions of the built output; the generators are deterministic
functions of their inputs (the SBOM creation date is derived from `flake.lock`, never
a wall clock; the CID re-derives from the served bytes with any IPFS implementation).
Site-specific artifacts — SHACL shapes, the prose corpus, the markdown renderer,
thresholds, copy, and `build.mjs` itself — are inputs, never part of the kit.
