// gates/conformance/conformance.mjs
//
// Zero-dependency Node port of lone's conformance AGGREGATOR
// (`jsr:@bounded-systems/lone@^0.4`, `src/standard/conformance.ts`). Folds (a)
// lone's static DOM findings and (b) supplied external evidence into a single typed
// report. The contract that matters: the strong COMPACT_CLAIM is emitted ONLY when
// every gating (tier-1 `required`) criterion is `met`. Anything less yields an
// honest partial summary that names what is clean, what is unmet, and what was never
// assessed. Absent external evidence → `not-assessed`, never silently `met`.
//
// See ./web-build.mjs for why the model is mirrored in Node rather than imported.

import {
  COMPACT_CLAIM,
  CRITERIA,
  CWV_THRESHOLDS,
  parseExternalEvidence,
  STANDARD_NAME,
  STANDARD_VERSION,
} from "./web-build.mjs";

/**
 * Whether a criterion gates the headline COMPACT_CLAIM. Only the tier-1 required
 * criteria do — tier-2/tier-3/cognitive criteria are reported and summarised but
 * NEVER widen the compact claim. Criteria with no explicit `tier` are tier-1.
 */
function gatesCompactClaim(c) {
  return c.required && (c.tier ?? 1) === 1;
}

/** Whether lone could not even read the subtree. */
const INVALID_SUBJECT_CODE = "LONE_ENGINE_INVALID_SUBJECT";

const met = (detail) => ({ status: "met", detail });
const unmet = (detail) => ({ status: "unmet", detail });
const notAssessed = (detail) => ({ status: "not-assessed", detail });

/** The OpenSSF Scorecard score at/above which `integrity.scorecard` is `met`. */
const SCORECARD_THRESHOLD = 7.0;

// Per-criterion evaluator for external evidence. Returns `not-assessed` when the
// relevant evidence field is absent; otherwise checks shape/thresholds.
const EXTERNAL_EVALUATORS = {
  "html.validator-clean": (e) => {
    const v = e.htmlValidator;
    if (!v) return notAssessed("no Nu HTML Checker report supplied");
    return v.errors === 0 ? met("0 validator errors") : unmet(`${v.errors} validator error(s)`);
  },
  "a11y.axe-serious-critical": (e) => {
    const v = e.axe;
    if (!v) return notAssessed("no axe-core scan supplied");
    const bad = v.serious + v.critical;
    return bad === 0
      ? met("0 serious/critical violations")
      : unmet(`${v.critical} critical, ${v.serious} serious violation(s)`);
  },
  "a11y.wcag22-aa-manual": (e) => {
    const v = e.manualA11y;
    if (!v) return notAssessed("no manual WCAG 2.2 AA audit supplied");
    const ok = v.wcag22AA && v.keyboardTested && v.screenReaderTested && v.completeFlows;
    if (!ok) {
      const gaps = [];
      if (!v.wcag22AA) gaps.push("AA not attested");
      if (!v.keyboardTested) gaps.push("keyboard not tested");
      if (!v.screenReaderTested) gaps.push("screen reader not tested");
      if (!v.completeFlows) gaps.push("flows incomplete");
      return unmet(gaps.join(", "));
    }
    // Attested clean — but a self-attested manual audit never gates the claim.
    if (!v.verifiedBy) {
      return notAssessed("manual AA audit self-attested; independent verification required (set manualA11y.verifiedBy)");
    }
    return met(`manual AA audit attested across complete flows, verified by ${v.verifiedBy}`);
  },
  "a11y.wcag22-aaa-selected": (e) => {
    const v = e.wcag22AAA;
    if (!v) return notAssessed("no AAA attestation supplied (optional)");
    return v.met
      ? met(`selected AAA met (${v.criteria.length} criteria)`)
      : unmet("selected AAA not met");
  },
  "design.palette-contrast": (e) => {
    const v = e.palette;
    if (!v) return notAssessed("no palette-token report supplied");
    const gaps = [];
    if (!v.cvdSafe) gaps.push("CVD-unsafe pairings");
    if (!v.apcaBaseline) gaps.push("below APCA baseline");
    if (!v.nonTextContrast) gaps.push("non-text contrast fails");
    return gaps.length === 0
      ? met("color tokens CVD-safe, APCA baseline, non-text contrast ok")
      : unmet(gaps.join(", "));
  },
  "design.typography": (e) => {
    const v = e.typography;
    if (!v) return notAssessed("no typography-token report supplied");
    const gaps = [];
    if (!v.bodyLineHeight) gaps.push("body line-height < 1.5");
    if (!v.textSpacingAchievable) gaps.push("text spacing not achievable");
    if (!v.minFontSize) gaps.push("font below minimum");
    if (!v.weightLegibility) gaps.push("thin weight illegible at size");
    return gaps.length === 0
      ? met("type tokens meet line-height, spacing, size, and weight bars")
      : unmet(gaps.join(", "));
  },
  "design.target-size": (e) => {
    const v = e.targetSize;
    if (!v) return notAssessed("no target-size report supplied");
    return v.minSizeAA
      ? met("interactive tokens meet SC 2.5.8 AA target size")
      : unmet("interactive tokens below SC 2.5.8 AA target size");
  },
  "design.opacity-contrast": (e) => {
    const v = e.opacityContrast;
    if (!v) return notAssessed("no opacity-contrast report supplied");
    return v.effectiveContrast
      ? met("effective contrast holds with token opacity composited")
      : unmet("effective contrast fails once token opacity is composited");
  },
  "design.token-likeness": (e) => {
    const v = e.tokenLikeness;
    if (!v) return notAssessed("no token-likeness report supplied");
    const gaps = [];
    if (!v.distinctCategoricals) gaps.push("categorical tokens not distinct");
    if (!v.noRedundantTokens) gaps.push("redundant near-duplicate tokens");
    return gaps.length === 0
      ? met("categorical tokens distinct; no redundant tokens")
      : unmet(gaps.join(", "));
  },
  "security.asvs": (e) => {
    const v = e.asvs;
    if (!v || v.achievedLevel == null) return notAssessed("no OWASP ASVS attestation supplied");
    if (v.achievedLevel < v.targetLevel) return unmet(`ASVS Level ${v.achievedLevel} below target L${v.targetLevel}`);
    // Level reached — but a self-graded ASVS attestation never gates the claim.
    if (!v.verifiedBy) {
      return notAssessed(`ASVS L${v.achievedLevel} self-attested; independent verification required (set asvs.verifiedBy)`);
    }
    return met(`ASVS ${v.version} Level ${v.achievedLevel} (target L${v.targetLevel}), verified by ${v.verifiedBy}`);
  },
  "security.no-critical-vulns": (e) => {
    const v = e.vulns;
    if (!v) return notAssessed("no vulnerability report supplied");
    return v.knownCriticalOrHighVulns === 0
      ? met("0 known critical/high vulns")
      : unmet(`${v.knownCriticalOrHighVulns} known critical/high vuln(s)`);
  },
  "security.hsts-preload": (e) => {
    const v = e.hstsPreload;
    if (!v) return notAssessed("no HSTS preload status supplied");
    return v.preloaded
      ? met("origin is on the HSTS preload list")
      : unmet("origin is not on the HSTS preload list");
  },
  "performance.core-web-vitals": (e) => {
    const samples = e.coreWebVitals;
    if (!samples || samples.length === 0) {
      return notAssessed("no Core Web Vitals field data supplied");
    }
    const factors = new Set(samples.map((s) => s.formFactor));
    const missing = ["mobile", "desktop"].filter((f) => !factors.has(f));
    if (missing.length > 0) return unmet(`missing ${missing.join(" + ")} field data`);
    const failures = [];
    for (const s of samples) {
      if (s.percentile < CWV_THRESHOLDS.percentile) failures.push(`${s.formFactor} below p${CWV_THRESHOLDS.percentile}`);
      if (s.lcpMs > CWV_THRESHOLDS.lcpMs) failures.push(`${s.formFactor} LCP ${s.lcpMs}ms`);
      if (s.inpMs > CWV_THRESHOLDS.inpMs) failures.push(`${s.formFactor} INP ${s.inpMs}ms`);
      if (s.cls > CWV_THRESHOLDS.cls) failures.push(`${s.formFactor} CLS ${s.cls}`);
    }
    return failures.length === 0
      ? met("LCP/INP/CLS within thresholds at p75, mobile + desktop")
      : unmet(failures.join("; "));
  },
  "compatibility.baseline": (e) => {
    const v = e.baseline;
    if (!v) return notAssessed("no Baseline result supplied");
    if (v.status === "widely") return met("Baseline Widely Available");
    return v.fallbackTested
      ? met(`Baseline ${v.status}, with a tested fallback`)
      : unmet(`Baseline ${v.status} and no tested fallback`);
  },
  "reliability.runtime": (e) => {
    const v = e.reliability;
    if (!v) return notAssessed("no runtime reliability report supplied");
    const gaps = [];
    if (v.uncaughtErrors !== 0) gaps.push(`${v.uncaughtErrors} uncaught error(s)`);
    if (v.brokenInternalLinks !== 0) gaps.push(`${v.brokenInternalLinks} broken link(s)`);
    if (!v.e2eCriticalJourneys) gaps.push("critical journeys not e2e-covered");
    return gaps.length === 0
      ? met("no runtime errors, no broken links, critical journeys e2e-covered")
      : unmet(gaps.join(", "));
  },

  // ── Tier-2 ────────────────────────────────────────────────────────────────
  "semantic.jsonld-shacl": (e) => {
    const v = e.jsonLdShacl;
    if (!v) return notAssessed("no JSON-LD/SHACL report supplied");
    return v.conforms && v.blocks === 0
      ? met("JSON-LD 1.1 conforms to SHACL shapes (0 violating blocks)")
      : unmet(v.conforms ? `${v.blocks} SHACL-violating block(s)` : `SHACL does not conform (${v.blocks} block(s))`);
  },
  "seo.technical": (e) => {
    const v = e.seoTechnical;
    if (!v) return notAssessed("no technical-SEO report supplied");
    const gaps = [];
    if (!v.canonicalOk) gaps.push("canonical issues");
    if (!v.titlesUnique) gaps.push("non-unique titles");
    if (!v.robotsRfc9309Ok) gaps.push("robots.txt not RFC 9309-valid");
    if (!v.sitemapResolves) gaps.push("sitemap does not resolve");
    if (v.brokenInternalLinks !== 0) gaps.push(`${v.brokenInternalLinks} broken internal link(s)`);
    return gaps.length === 0
      ? met("canonical/titles/robots/sitemap clean, 0 broken internal links")
      : unmet(gaps.join(", "));
  },
  "semantic.commonmark": (e) => {
    const v = e.commonMark;
    if (!v) return notAssessed("no CommonMark report supplied");
    return v.conforms ? met("Markdown conforms to CommonMark") : unmet("Markdown does not conform to CommonMark");
  },
  "semantic.ai-readability": (e) => {
    const v = e.aiReadability;
    if (!v) return notAssessed("no AI-readability report supplied (optional)");
    const gaps = [];
    if (!v.llmsTxtPresent) gaps.push("llms.txt missing");
    if (!v.linksResolve) gaps.push("llms.txt links do not resolve");
    if (!v.markdownSiblings) gaps.push("no Markdown siblings");
    return gaps.length === 0
      ? met("llms.txt present, links resolve, Markdown siblings exposed")
      : unmet(gaps.join(", "));
  },
  "semantic.openapi": (e) => {
    const v = e.openApi;
    if (!v) return notAssessed("no OpenAPI report supplied (only applies if an API is published)");
    const gaps = [];
    if (!v.openapiValid) gaps.push("OpenAPI document invalid");
    if (!v.responsesMatchSchemas) gaps.push("responses diverge from schemas");
    return gaps.length === 0
      ? met("OpenAPI 3.2 valid; responses match JSON Schema 2020-12")
      : unmet(gaps.join(", "));
  },
  "semantic.feeds": (e) => {
    const v = e.feeds;
    if (!v) return notAssessed("no feed report supplied (optional)");
    return v.atomValid ? met("Atom feed valid (RFC 4287)") : unmet("Atom feed invalid");
  },

  // ── Tier-3 ──────────────────────────────────────────────────────────────────
  "integrity.slsa-provenance": (e) => {
    const v = e.slsaProvenance;
    if (!v) return notAssessed("no SLSA/in-toto provenance supplied");
    const gaps = [];
    if (!v.present) gaps.push("not present");
    if (!v.signed) gaps.push("not signed");
    if (!v.verified) gaps.push("not verified");
    return gaps.length === 0
      ? met("SLSA/in-toto provenance present, signed, and verified")
      : unmet(gaps.join(", "));
  },
  "integrity.slsa-level": (e) => {
    const v = e.slsaLevel;
    if (!v) return notAssessed("no SLSA build level supplied");
    return v.level >= v.target
      ? met(`SLSA build Level ${v.level} (target L${v.target})`)
      : unmet(`SLSA build Level ${v.level} below target L${v.target}`);
  },
  "integrity.scorecard": (e) => {
    const v = e.scorecard;
    if (!v) return notAssessed("no OpenSSF Scorecard result supplied");
    return v.score >= SCORECARD_THRESHOLD
      ? met(`OpenSSF Scorecard ${v.score.toFixed(1)} (≥ ${SCORECARD_THRESHOLD})`)
      : unmet(`OpenSSF Scorecard ${v.score.toFixed(1)} below ${SCORECARD_THRESHOLD}`);
  },
  "integrity.reproducible-build": (e) => {
    const v = e.reproducibleBuild;
    if (!v) return notAssessed("no reproducible-build report supplied");
    return v.reproducible ? met("build is byte-reproducible") : unmet("build is not reproducible");
  },
  "integrity.sbom": (e) => {
    const v = e.sbom;
    if (!v) return notAssessed("no SPDX SBOM supplied");
    const gaps = [];
    if (!v.present) gaps.push("not present");
    if (!v.valid) gaps.push("not valid");
    if (!v.complete) gaps.push("incomplete");
    if (!v.signed) gaps.push("not signed");
    return gaps.length === 0
      ? met("SPDX SBOM present, valid, complete, and signed")
      : unmet(gaps.join(", "));
  },
  "integrity.content-digests": (e) => {
    const v = e.contentDigests;
    if (!v) return notAssessed("no content-digest report supplied (optional)");
    return v.reprDigestHeaders ? met("Repr-Digest headers present (RFC 9530)") : unmet("no Repr-Digest headers");
  },
  "integrity.signed-release-manifest": (e) => {
    const v = e.signedReleaseManifest;
    if (!v) return notAssessed("no release-manifest report supplied");
    const gaps = [];
    if (!v.present) gaps.push("not present");
    if (!v.signed) gaps.push("not signed");
    return gaps.length === 0 ? met("release manifest present and signed") : unmet(gaps.join(", "));
  },
  "integrity.ipfs-cid": (e) => {
    const v = e.ipfsCid;
    if (!v) return notAssessed("no IPFS CID report supplied (optional)");
    return v.cidRecorded ? met("IPFS CID recorded") : unmet("no IPFS CID recorded");
  },
  "integrity.http-rfc9110": (e) => {
    const v = e.httpRfc9110;
    if (!v) return notAssessed("no RFC 9110 HTTP report supplied (optional)");
    return v.conforms ? met("HTTP semantics conform to RFC 9110") : unmet("HTTP semantics do not conform to RFC 9110");
  },

  // ── Cognitive ─────────────────────────────────────────────────────────────
  // Agent/static heuristic accessibility review (tier-2; non-gating)
  // HONEST FRAMING: agent/static heuristic review — NOT AT-user testing.
  "a11y.agent-heuristic-review": (e) => {
    const v = e.agentHeuristic;
    if (!v) return notAssessed("no agent heuristic review supplied (run a11y-heuristic-gate)");
    const gaps = [];
    if (!v.landmarksPresent) gaps.push("required ARIA landmarks missing");
    if (!v.interactiveNamesClean) gaps.push("interactive elements without accessible names");
    if (!v.headingHierarchyClean) gaps.push("heading hierarchy issues");
    if (!v.imagesAltClean) gaps.push("images without alt attributes");
    if (!v.focusRingClean) gaps.push("inline focus ring removal detected");
    if (v.errors > 0) gaps.push(`${v.errors} heuristic error(s)`);
    if (gaps.length === 0) {
      const axeNote = v.axeCorroboration
        ? `; axe: ${v.axeCorroboration.critical} critical, ${v.axeCorroboration.serious} serious`
        : "";
      return met(
        `agent heuristic pass clean — ${v.pages} page(s), ${v.warnings} warning(s)${axeNote}. ` +
        "AGENT/STATIC HEURISTIC — NOT AT-user testing; a11y.wcag22-aa-manual stays not-assessed.",
      );
    }
    return unmet(
      `${gaps.join(", ")} (${v.pages} page(s), ${v.errors} error(s), ${v.warnings} warning(s)). ` +
      "AGENT/STATIC HEURISTIC — fix machine-detectable issues then re-run.",
    );
  },
  // COGA Obj-5 focus budget (cognitive tier; non-gating)
  // HONEST FRAMING: agent/static interface-complexity proxy — NOT COGA usability testing.
  "cognitive.focus-budget": (e) => {
    const v = e.focusBudget;
    if (!v) return notAssessed("no focus budget report supplied (run focus-budget-gate)");
    const gaps = [];
    if (!v.contentDensity.thresholdsMet) {
      const breaches = v.contentDensity.breaches || [];
      gaps.push(...breaches.map((b) => `${b} threshold exceeded`));
    }
    if (!v.interactionPatterns.patternsMet) {
      const patterns = [];
      if (v.interactionPatterns.autoDialogOnLoad) patterns.push("auto-opening dialog");
      if (v.interactionPatterns.autoplayMedia) patterns.push("autoplay media");
      if (v.interactionPatterns.timeLimits) patterns.push("time limit (meta refresh)");
      if (v.interactionPatterns.focusRingRemoved) patterns.push("focus ring removed");
      gaps.push(...patterns);
    }
    const proxyNote =
      "AGENT/STATIC PROXY for COGA Obj-5 — NOT COGA usability testing with cognitive disabilities.";
    if (gaps.length === 0) {
      return met(`focus budget met — all content density thresholds and interaction patterns clean. ${proxyNote}`);
    }
    // `not-yet-met` is semantically distinct from `unmet` — it signals that
    // thresholds are exceeded and CAN be fixed, but editorial decisions remain
    // the maintainer's call. The conformance model maps it to "unmet" for counting;
    // the detail string preserves the honest framing.
    return unmet(
      `not-yet-met: ${gaps.join(", ")}. ${proxyNote} ` +
        "Do NOT mass-rewrite content — editorial is the maintainer's call; gate reports honestly.",
    );
  },
  "cognitive.coga-usability-testing": (e) => {
    const v = e.cogaUsability;
    if (!v) return notAssessed("no COGA usability testing supplied (optional)");
    const gaps = [];
    if (!v.conducted) gaps.push("not conducted");
    if (!v.withCognitiveDisabilities) gaps.push("not tested with people with cognitive disabilities");
    if (!v.criticalTasksPassed) gaps.push("critical tasks failed");
    return gaps.length === 0
      ? met("COGA usability testing conducted; critical tasks passed")
      : unmet(gaps.join(", "));
  },
};

/** Findings whose code starts with any of the criterion's prefixes. */
function matchFindings(findings, prefixes) {
  return findings.filter((f) => prefixes.some((p) => f.code.startsWith(p)));
}

function evaluateLone(c, findings, subjectInvalid) {
  if (subjectInvalid) {
    return { ...c, status: "not-assessed", detail: "subject is not a DOM element; lone could not assess it", findings: [] };
  }
  const matched = matchFindings(findings, c.loneCodes ?? []);
  const errors = matched.filter((f) => f.severity === "error");
  if (errors.length === 0) {
    const note = matched.length === 0 ? "no findings" : `${matched.length} non-error finding(s)`;
    return { ...c, status: "met", detail: `lone static checks clean (${note})`, findings: matched };
  }
  return { ...c, status: "unmet", detail: `${errors.length} error-severity finding(s)`, findings: matched };
}

/**
 * Aggregate lone findings + external evidence into a conformance report.
 *
 * @param {{ findings?: Array<{code:string, severity:string}> }} lone Output of
 *   lone's `validate()`/`BlessResult` (anything with `findings`).
 * @param {object} [evidence] Typed external evidence. Validated for shape (throws on
 *   a malformed envelope). Absent fields → `not-assessed`.
 * @returns {ConformanceReport}
 */
export function conformance(lone, evidence) {
  const parsed = parseExternalEvidence(evidence ?? {});
  const findings = lone?.findings ?? [];
  const subjectInvalid = findings.some((f) => f.code === INVALID_SUBJECT_CODE);

  const results = CRITERIA.map((c) => {
    if (c.evidence === "lone") {
      if (c.pendingValidators) {
        return {
          ...c,
          status: "not-assessed",
          detail: `${c.label} is lone-measurable in principle, but its DOM validators are not yet implemented; reported but non-gating`,
          findings: [],
        };
      }
      return evaluateLone(c, findings, subjectInvalid);
    }
    const evaluator = EXTERNAL_EVALUATORS[c.id];
    const verdict = evaluator ? evaluator(parsed) : notAssessed("no evaluator registered");
    return { ...c, status: verdict.status, detail: verdict.detail };
  });

  const summary = {
    met: results.filter((r) => r.status === "met").length,
    unmet: results.filter((r) => r.status === "unmet").length,
    notAssessed: results.filter((r) => r.status === "not-assessed").length,
    total: results.length,
  };

  // The compact claim is gated on the TIER-1 required set ONLY.
  const gating = results.filter((r) => gatesCompactClaim(r));
  const conformant = gating.every((r) => r.status === "met");

  return {
    standard: STANDARD_NAME,
    version: STANDARD_VERSION,
    results,
    summary,
    areaSummaries: buildAreaSummaries(results),
    conformant,
    claim: conformant ? COMPACT_CLAIM : partialSummary(results),
  };
}

/** Roll up results per area into an honest, non-overclaiming one-liner each. */
function buildAreaSummaries(results) {
  const order = [];
  for (const r of results) if (!order.includes(r.area)) order.push(r.area);
  return order.map((area) => {
    const inArea = results.filter((r) => r.area === area);
    const met = inArea.filter((r) => r.status === "met").length;
    const unmet = inArea.filter((r) => r.status === "unmet").length;
    const notAssessed = inArea.filter((r) => r.status === "not-assessed").length;
    const total = inArea.length;
    const tail = [];
    if (unmet > 0) tail.push(`${unmet} unmet`);
    if (notAssessed > 0) tail.push(`${notAssessed} not assessed`);
    const suffix = tail.length > 0 ? ` (${tail.join(", ")})` : "";
    return { area, met, unmet, notAssessed, total, summary: `${area}: ${met}/${total} met${suffix}` };
  });
}

/** Build an honest partial summary naming what is clean, unmet, and unassessed. */
function partialSummary(results) {
  const parts = [];
  const loneResults = results.filter(
    (r) => r.evidence === "lone" && gatesCompactClaim(r) && !r.pendingValidators,
  );
  const loneNotAssessed = loneResults.some((r) => r.status === "not-assessed");
  const loneUnmet = loneResults.filter((r) => r.status === "unmet");
  if (loneNotAssessed) {
    parts.push("DOM not assessed (invalid subject)");
  } else if (loneUnmet.length === 0) {
    parts.push("automated DOM checks clean");
  } else {
    parts.push(`automated DOM checks found issues in ${loneUnmet.map((r) => r.label).join(", ")}`);
  }
  const gating = results.filter((r) => gatesCompactClaim(r) && r.evidence === "external");
  const unmet = gating.filter((r) => r.status === "unmet");
  const unassessed = gating.filter((r) => r.status === "not-assessed");
  for (const r of unmet) parts.push(`${r.label} unmet`);
  for (const r of unassessed) parts.push(`${r.label} not supplied`);
  return `Partial conformance: ${parts.join("; ")}.`;
}
