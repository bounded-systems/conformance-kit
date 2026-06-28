// gates/conformance/web-build.mjs
//
// A zero-dependency Node port of lone's web-build conformance STANDARD
// (`jsr:@bounded-systems/lone@^0.4`, `src/standard/web_build.ts`). It is the typed
// data the aggregator in `./conformance.mjs` folds evidence into: the criteria, the
// strong COMPACT_CLAIM, the standard name/version, the Core Web Vitals thresholds,
// and a hand-rolled validator for the external-evidence envelope.
//
// Why a port and not an import: lone is a Deno/JSR package (its DOM blessing runs in
// the `gates/semantic/` Deno gate). The conformance MODEL, by contrast, is a pure
// data function with no DOM — so it is mirrored here as plain Node, zero-dep, so a
// consumer's hermetic, offline `node build.mjs` can compute the report without
// pulling Deno/zod/JSR into the pure build. Kept byte-faithful to lone's criteria,
// claim string, tiers, and evidence shapes; pinned to STANDARD_VERSION below. lone
// remains the source of truth — when it bumps the standard, re-port this file.
//
// The whole point is OVERCLAIM-AVOIDANCE: the strong compact claim is emitted only
// when every gating (tier-1 `required`) criterion has passing evidence. Absent
// external evidence is reported as `not-assessed`, never silently treated as met.

/** Core Web Vitals thresholds (good, at p75). */
export const CWV_THRESHOLDS = {
  lcpMs: 2500,
  inpMs: 200,
  cls: 0.1,
  percentile: 75,
};

/**
 * The strong compact claim. Emitted by `conformance()` ONLY when every gating
 * criterion is `met`. Never assemble this string by hand.
 */
export const COMPACT_CLAIM =
  "Conforms to WCAG 2.2 AA, HTML and WAI-ARIA author requirements, " +
  "OWASP ASVS 5.0 Level 2, passes Core Web Vitals at p75, and targets " +
  "Baseline Widely Available.";

export const STANDARD_NAME = "Bounded Systems Web-Build Conformance Standard";
export const STANDARD_VERSION = "1.0.0";

/**
 * The criteria, as typed data. Ordered by area for stable reporting. Mirrors
 * lone's `CRITERIA`. `evidence: "lone"` criteria are checked statically from a DOM
 * subtree (the absence of error-severity findings under `loneCodes`); everything
 * else is external evidence, supplied + threshold-checked, never fabricated.
 *
 * Only tier-1 `required` criteria gate the COMPACT_CLAIM; tier-2/tier-3/cognitive
 * criteria are reported + summarised per-area but never widen the headline claim.
 */
export const CRITERIA = [
  // ── HTML — HTML Living Standard ──────────────────────────────────────────
  {
    id: "html.dom-author-requirements",
    area: "html",
    label: "HTML author requirements",
    standard: "HTML Living Standard",
    target: "DOM subtree meets HTML author requirements (valid semantics & structure).",
    level: "author conformance",
    evidence: "lone",
    required: true,
    loneCodes: ["LONE_SEMANTIC_"],
  },
  {
    id: "html.validator-clean",
    area: "html",
    label: "Nu HTML Checker errors",
    standard: "Nu Html Checker",
    target: "Zero HTML validator (Nu) errors over the rendered page.",
    level: "zero errors",
    evidence: "external",
    required: true,
  },

  // ── Accessibility — WCAG 2.2 / WAI-ARIA 1.2 / axe ────────────────────────
  {
    id: "a11y.aria-author",
    area: "accessibility",
    label: "WAI-ARIA author requirements",
    standard: "WAI-ARIA 1.2",
    target: "Valid roles/states/properties/relationships; prefer native HTML semantics.",
    level: "author conformance",
    evidence: "lone",
    required: true,
    loneCodes: ["LONE_ARIA_"],
  },
  {
    id: "a11y.wcag22-aa-auto",
    area: "accessibility",
    label: "WCAG 2.2 AA (automated subset)",
    standard: "WCAG 2.2",
    target: "Automatable WCAG 2.2 AA checks pass (names, text alternatives, contrast, keyboard, SR content).",
    level: "AA (automated subset)",
    evidence: "lone",
    required: true,
    loneCodes: [
      "LONE_NAME_",
      "LONE_TEXT_",
      "LONE_SR_",
      "LONE_KEYBOARD_",
      "LONE_COLOR_",
      "LONE_READER_",
    ],
  },
  {
    id: "a11y.axe-serious-critical",
    area: "accessibility",
    label: "axe serious/critical violations",
    standard: "axe-core",
    target: "Zero serious/critical accessibility violations on the rendered page.",
    level: "serious/critical",
    evidence: "external",
    required: true,
  },
  {
    id: "a11y.wcag22-aa-manual",
    area: "accessibility",
    label: "WCAG 2.2 AA (manual audit)",
    standard: "WCAG 2.2",
    target: "Complete-flow manual audit incl. keyboard + screen-reader testing of critical flows.",
    level: "AA (manual)",
    evidence: "external",
    required: true,
  },
  {
    id: "a11y.wcag22-aaa-selected",
    area: "accessibility",
    label: "WCAG 2.2 AAA (selected)",
    standard: "WCAG 2.2",
    target: "Selected AAA success criteria met.",
    level: "AAA (selected)",
    evidence: "external",
    required: false,
  },

  // ── Security — OWASP ASVS 5.0.0 ──────────────────────────────────────────
  {
    id: "security.asvs",
    area: "security",
    label: "OWASP ASVS Level 2",
    standard: "OWASP ASVS 5.0.0",
    target: "Verified to Level 2 (Level 3 for highly sensitive applications).",
    level: "L2",
    evidence: "external",
    required: true,
  },
  {
    id: "security.no-critical-vulns",
    area: "security",
    label: "known critical/high vulns",
    standard: "OWASP ASVS 5.0.0",
    target: "Zero known critical/high exploitable vulnerabilities.",
    level: "zero critical/high",
    evidence: "external",
    required: true,
  },

  // ── Performance — Core Web Vitals ────────────────────────────────────────
  {
    id: "performance.core-web-vitals",
    area: "performance",
    label: "Core Web Vitals (p75)",
    standard: "Core Web Vitals",
    target: "LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75 on mobile AND desktop (field data).",
    level: "p75 mobile + desktop",
    evidence: "external",
    required: true,
  },

  // ── Compatibility — Baseline ─────────────────────────────────────────────
  {
    id: "compatibility.baseline",
    area: "compatibility",
    label: "Baseline Widely Available",
    standard: "Baseline",
    target: "Baseline Widely Available (interoperable ≥30 months), or a tested fallback for newer features.",
    level: "Widely Available",
    evidence: "external",
    required: true,
  },

  // ── Reliability — runtime ────────────────────────────────────────────────
  {
    id: "reliability.runtime",
    area: "reliability",
    label: "runtime reliability",
    standard: "Bounded Systems reliability bar",
    target: "No uncaught browser errors; no broken internal links; critical journeys covered by e2e tests.",
    level: "—",
    evidence: "external",
    required: true,
  },

  // ══ TIER 2 — machine-readable structured content + technical SEO ═══════════
  {
    id: "semantic.jsonld-shacl",
    area: "semantic",
    label: "JSON-LD 1.1 + SHACL conformance",
    standard: "JSON-LD 1.1 / SHACL",
    target: "Structured data parses as JSON-LD 1.1 and conforms to its SHACL shapes (zero violating blocks).",
    level: "conforms",
    evidence: "external",
    required: true,
    tier: 2,
  },
  {
    id: "seo.technical",
    area: "seo",
    label: "Technical SEO",
    standard: "Search-engine technical guidelines / RFC 9309",
    target: "Canonical URLs correct, titles unique, robots.txt RFC 9309-valid, sitemap resolves, zero broken internal links.",
    level: "clean",
    evidence: "external",
    required: true,
    tier: 2,
  },
  {
    id: "semantic.commonmark",
    area: "semantic",
    label: "CommonMark conformance",
    standard: "CommonMark",
    target: "Authored Markdown parses cleanly under the CommonMark spec.",
    level: "conforms",
    evidence: "external",
    required: true,
    tier: 2,
  },
  {
    id: "semantic.ai-readability",
    area: "semantic",
    label: "AI-readability",
    standard: "llms.txt convention",
    target: "llms.txt present, its links resolve, and HTML pages expose Markdown siblings for machine consumption.",
    level: "recommended",
    evidence: "external",
    required: false,
    tier: 2,
  },
  {
    id: "semantic.openapi",
    area: "semantic",
    label: "OpenAPI 3.2 + JSON Schema 2020-12",
    standard: "OpenAPI 3.2 / JSON Schema 2020-12",
    target: "Published OpenAPI document is valid and responses match their declared JSON Schemas. Only applies if an API is published.",
    level: "conditional",
    evidence: "external",
    required: false,
    tier: 2,
  },
  {
    id: "semantic.feeds",
    area: "semantic",
    label: "Atom feed (RFC 4287)",
    standard: "RFC 4287",
    target: "Published feed is a valid Atom 1.0 document.",
    level: "recommended",
    evidence: "external",
    required: false,
    tier: 2,
  },

  // ══ TIER 3 — integrity / provenance / reproducibility ══════════════════════
  {
    id: "integrity.slsa-provenance",
    area: "integrity",
    label: "SLSA provenance + in-toto",
    standard: "SLSA / in-toto",
    target: "Build emits in-toto/SLSA provenance that is present, signed, and verifies against the artifact.",
    level: "present + signed + verified",
    evidence: "external",
    required: true,
    tier: 3,
  },
  {
    id: "integrity.reproducible-build",
    area: "integrity",
    label: "Reproducible build",
    standard: "Reproducible Builds",
    target: "Re-running the build from source yields byte-identical artifacts.",
    level: "reproducible",
    evidence: "external",
    required: true,
    tier: 3,
  },
  {
    id: "integrity.sbom",
    area: "integrity",
    label: "SPDX SBOM",
    standard: "SPDX",
    target: "An SPDX SBOM is present, valid, complete (covers all components), and signed.",
    level: "present + valid + complete + signed",
    evidence: "external",
    required: true,
    tier: 3,
  },
  {
    id: "integrity.content-digests",
    area: "integrity",
    label: "Content digests (RFC 9530)",
    standard: "RFC 9530",
    target: "Responses carry Repr-Digest (RFC 9530) representation digests.",
    level: "recommended",
    evidence: "external",
    required: false,
    tier: 3,
  },
  {
    id: "integrity.signed-release-manifest",
    area: "integrity",
    label: "Signed release manifest",
    standard: "Bounded Systems release bar",
    target: "Each release ships a manifest of artifact digests that is present and signed.",
    level: "present + signed",
    evidence: "external",
    required: true,
    tier: 3,
  },
  {
    id: "integrity.ipfs-cid",
    area: "integrity",
    label: "IPFS CID recorded",
    standard: "IPFS / CIDv1",
    target: "The release records a content-addressed IPFS CID for the artifact.",
    level: "recommended",
    evidence: "external",
    required: false,
    tier: 3,
  },
  {
    id: "integrity.http-rfc9110",
    area: "integrity",
    label: "HTTP correctness (RFC 9110)",
    standard: "RFC 9110",
    target: "Responses are semantically correct per RFC 9110 HTTP semantics.",
    level: "recommended",
    evidence: "external",
    required: false,
    tier: 3,
  },

  // ══ COGNITIVE ACCESSIBILITY — W3C COGA ═════════════════════════════════════
  // HONEST LABELING: an INTERFACE-COMPLEXITY BUDGET (W3C COGA-derived), explicitly
  // NOT a "cognitive-load measurement". Reported + summarised but non-gating.
  {
    id: "cognitive.complexity-budget",
    area: "cognitive",
    label: "Interface-complexity budget (W3C COGA-derived)",
    standard: "W3C COGA (derived)",
    target:
      "Rendered DOM stays within an interface-complexity budget: choice density, " +
      "primary-action count, heading depth, clear link purpose, interruptions, " +
      "form/memory burden, motion, progressive disclosure. " +
      "This is an interface-complexity budget, NOT a cognitive-load measurement.",
    level: "budget (recommended)",
    evidence: "lone",
    required: false,
    tier: "cognitive",
    loneCodes: ["LONE_COGA_"],
  },
  {
    id: "cognitive.coga-usability-testing",
    area: "cognitive",
    label: "COGA usability testing",
    standard: "W3C COGA",
    target: "Usability testing conducted with people with cognitive disabilities; critical tasks pass.",
    level: "manual (recommended)",
    evidence: "external",
    required: false,
    tier: "cognitive",
  },
];

// ── External-evidence envelope validation (zero-dep, mirrors lone's Zod) ──────
// lone verifies the SHAPE and THRESHOLDS of supplied evidence and THROWS on a
// malformed envelope ("lone refuses to guess"); absent fields stay absent and are
// reported `not-assessed` by the aggregator. This is a hand-rolled equivalent of
// lone's `ExternalEvidence.parse()`: per-field type checks, defaults applied,
// unknown top-level keys stripped (as Zod `.object()` does), throw on type mismatch.

class EvidenceError extends Error {}
const fail = (path, msg) => {
  throw new EvidenceError(`external evidence: ${path} — ${msg}`);
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Field validator combinators. Each is (value, path) => parsedValue (throws on bad).
const vBool = (v, p) => (typeof v === "boolean" ? v : fail(p, "expected a boolean"));
const vStr = (v, p) => (typeof v === "string" ? v : fail(p, "expected a string"));
const vInt0 = (v, p) =>
  Number.isInteger(v) && v >= 0 ? v : fail(p, "expected an integer ≥ 0");
const vNum = (min, max) => (v, p) => {
  if (typeof v !== "number" || Number.isNaN(v)) fail(p, "expected a number");
  if (min != null && v < min) fail(p, `expected ≥ ${min}`);
  if (max != null && v > max) fail(p, `expected ≤ ${max}`);
  return v;
};
const vEnum = (...vals) => (v, p) =>
  vals.includes(v) ? v : fail(p, `expected one of ${vals.map((x) => JSON.stringify(x)).join(", ")}`);
const vArrayOf = (inner) => (v, p) => {
  if (!Array.isArray(v)) fail(p, "expected an array");
  return v.map((x, i) => inner(x, `${p}[${i}]`));
};
// A nested object schema.
const vObject = (shape) => (v, p) => parseShape(shape, v, p);

// Field descriptors: { val, optional?, default? }. `req(val)` required; `opt(val)`
// optional (absent → omitted); `def(val, d)` optional with a default.
const req = (val) => ({ val });
const opt = (val) => ({ val, optional: true });
const def = (val, d) => ({ val, default: d });

function parseShape(shape, input, path) {
  if (input === undefined || input === null) input = {};
  if (!isPlainObject(input)) fail(path, "expected an object");
  const out = {};
  for (const [key, spec] of Object.entries(shape)) {
    const here = path ? `${path}.${key}` : key;
    if (key in input && input[key] !== undefined) {
      out[key] = spec.val(input[key], here);
    } else if ("default" in spec) {
      out[key] = spec.default;
    } else if (!spec.optional) {
      fail(here, "is required");
    }
  }
  return out; // unknown keys stripped (as Zod .object() does)
}

const CWV_SAMPLE_SHAPE = {
  formFactor: req(vEnum("mobile", "desktop")),
  percentile: req(vNum(0, 100)),
  lcpMs: req(vNum(0)),
  inpMs: req(vNum(0)),
  cls: req(vNum(0)),
  source: def(vEnum("field", "lab"), "field"),
};

// The full external-evidence envelope. Every field optional; mirrors lone.
const ENVELOPE = {
  // tier-1
  htmlValidator: opt(vObject({ errors: req(vInt0), warnings: opt(vInt0) })),
  manualA11y: opt(vObject({
    wcag22AA: req(vBool),
    keyboardTested: req(vBool),
    screenReaderTested: req(vBool),
    completeFlows: req(vBool),
  })),
  wcag22AAA: opt(vObject({ criteria: def(vArrayOf(vStr), []), met: req(vBool) })),
  axe: opt(vObject({ serious: req(vInt0), critical: req(vInt0) })),
  security: opt(vObject({
    standard: def(vStr, "OWASP ASVS"),
    version: def(vStr, "5.0.0"),
    achievedLevel: req(vEnum(1, 2, 3)),
    targetLevel: def(vEnum(1, 2, 3), 2),
    knownCriticalOrHighVulns: req(vInt0),
    verifiedBy: opt(vStr),
  })),
  coreWebVitals: opt(vArrayOf(vObject(CWV_SAMPLE_SHAPE))),
  baseline: opt(vObject({
    status: req(vEnum("widely", "newly", "limited")),
    fallbackTested: def(vBool, false),
  })),
  reliability: opt(vObject({
    uncaughtErrors: req(vInt0),
    brokenInternalLinks: req(vInt0),
    e2eCriticalJourneys: req(vBool),
  })),
  // tier-2
  jsonLdShacl: opt(vObject({ conforms: req(vBool), blocks: req(vInt0) })),
  seoTechnical: opt(vObject({
    canonicalOk: req(vBool),
    titlesUnique: req(vBool),
    robotsRfc9309Ok: req(vBool),
    sitemapResolves: req(vBool),
    brokenInternalLinks: req(vInt0),
  })),
  commonMark: opt(vObject({ conforms: req(vBool) })),
  aiReadability: opt(vObject({
    llmsTxtPresent: req(vBool),
    linksResolve: req(vBool),
    markdownSiblings: req(vBool),
  })),
  openApi: opt(vObject({ openapiValid: req(vBool), responsesMatchSchemas: req(vBool) })),
  feeds: opt(vObject({ atomValid: req(vBool) })),
  // tier-3
  slsaProvenance: opt(vObject({ present: req(vBool), signed: req(vBool), verified: req(vBool) })),
  reproducibleBuild: opt(vObject({ reproducible: req(vBool) })),
  sbom: opt(vObject({ present: req(vBool), valid: req(vBool), complete: req(vBool), signed: req(vBool) })),
  contentDigests: opt(vObject({ reprDigestHeaders: req(vBool) })),
  signedReleaseManifest: opt(vObject({ present: req(vBool), signed: req(vBool) })),
  ipfsCid: opt(vObject({ cidRecorded: req(vBool) })),
  httpRfc9110: opt(vObject({ conforms: req(vBool) })),
  // cognitive
  cogaUsability: opt(vObject({
    conducted: req(vBool),
    withCognitiveDisabilities: req(vBool),
    criticalTasksPassed: req(vBool),
  })),
};

/**
 * Validate + normalise the external-evidence envelope. Throws an `Error` on a
 * malformed envelope (wrong types) — lone refuses to guess. Absent fields are
 * simply omitted (the aggregator reports them `not-assessed`).
 *
 * @param {object} [evidence]
 * @returns {object} the parsed envelope (defaults applied, unknown keys stripped)
 */
export function parseExternalEvidence(evidence) {
  return parseShape(ENVELOPE, evidence ?? {}, "");
}

export { EvidenceError };
