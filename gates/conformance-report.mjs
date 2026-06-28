// gates/conformance-report.mjs
//
// The generic conformance-projection helper. Two site-agnostic pieces:
//
//   buildConformanceReport({ loneFindings, evidence })
//       Gather the standard evidence — lone's DOM findings + an external-evidence
//       envelope whose fields are INJECTED by the consumer (SHACL conforms, SBOM
//       present/valid/complete/signed, Repr-Digest headers present, in-toto
//       attestation present/signed/verified, …) — call lone's `conformance()`
//       model, and return the typed report. Anything the consumer does NOT supply
//       (manual WCAG audit, axe scan, OWASP ASVS, field Core Web Vitals, Baseline,
//       …) is reported `not-assessed`, never silently `met` — so automation can
//       never print "WCAG 2.2 AA" or "ASVS conformant" on its own.
//
//   renderConformanceReport(report, { evidenceHref, headingLevel, idPrefix })
//       Render a report to semantic, class-based HTML (per-area summaries, each
//       criterion's status + an evidence link, the honest headline claim). NO
//       hardcoded site values, brand tokens, or inline styles — the consumer wraps
//       this fragment in its own template/stylesheet and supplies `evidenceHref`.
//
// Nothing here hardcodes a site URL, account, or brand. The conformance MODEL lives
// in ./conformance/ (a zero-dep Node port of lone@0.4); this file is the reusable
// glue + presenter on top of it.

import { conformance } from "./conformance/conformance.mjs";
import { COMPACT_CLAIM, CRITERIA, STANDARD_NAME, STANDARD_VERSION } from "./conformance/web-build.mjs";

export { conformance, COMPACT_CLAIM, CRITERIA, STANDARD_NAME, STANDARD_VERSION };

// lone's own sentinel for "could not read the subtree". Used when the consumer ran
// the report in a context where lone did NOT bless a DOM (e.g. a pure, headless
// build that has no document): the lone-measurable criteria come back `not-assessed`
// rather than being called `met` on an absence of findings (which would be overclaim).
const DOM_NOT_ASSESSED_FINDINGS = [{
  code: "LONE_ENGINE_INVALID_SUBJECT",
  severity: "error",
  path: "",
  message: "no DOM subject was blessed by lone in this build context",
}];

/**
 * Gather evidence + compute the conformance report.
 *
 * @param {object} [opts]
 * @param {Array<{code:string,severity:string}>|null} [opts.loneFindings] lone's DOM
 *   findings (from the semantic gate). Pass `null`/omit when no DOM was blessed in
 *   this context → the lone criteria report `not-assessed`. Pass `[]` only when lone
 *   actually ran and found nothing.
 * @param {object} [opts.evidence] The external-evidence envelope (lone's shape).
 *   Fields with value `undefined`/`null` are pruned so they read as `not-assessed`.
 * @returns {ConformanceReport}
 */
export function buildConformanceReport({ loneFindings = null, evidence = {} } = {}) {
  const findings = Array.isArray(loneFindings) ? loneFindings : DOM_NOT_ASSESSED_FINDINGS;
  // Prune absent fields so "not supplied" reads as not-assessed (lone's contract).
  const ev = {};
  for (const [k, v] of Object.entries(evidence ?? {})) {
    if (v !== undefined && v !== null) ev[k] = v;
  }
  return conformance({ findings }, ev);
}

// ── HTML renderer ────────────────────────────────────────────────────────────

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

const STATUS_LABEL = { met: "met", unmet: "unmet", "not-assessed": "not assessed" };

/**
 * Render a conformance report to a semantic HTML fragment (class-based, no inline
 * styles, no brand). The consumer styles `.ck-conformance`, `.ck-area`,
 * `.ck-criterion`, and the `.ck-status--{met,unmet,not-assessed}` modifiers, and
 * wraps the fragment in its own page template.
 *
 * @param {ConformanceReport} report
 * @param {object} [opts]
 * @param {(criterion:object)=>(string|undefined)} [opts.evidenceHref] Maps a
 *   criterion-result to the URL of its evidence; omit/return falsy → no link.
 * @param {number} [opts.headingLevel] Heading level for per-area titles (default 2).
 * @param {string} [opts.idPrefix] Prefix for per-criterion element ids (default "ck").
 * @returns {string} HTML fragment
 */
export function renderConformanceReport(report, opts = {}) {
  const { evidenceHref, headingLevel = 2, idPrefix = "ck" } = opts;
  const h = Math.min(Math.max(headingLevel | 0, 2), 6);
  const s = report.summary;

  const areaBlocks = report.areaSummaries.map((a) => {
    const inArea = report.results.filter((r) => r.area === a.area);
    const items = inArea.map((r) => renderCriterion(r, { evidenceHref, idPrefix })).join("\n");
    return `      <section class="ck-area" data-area="${esc(a.area)}">
        <h${h} class="ck-area__title">${esc(a.area)} <span class="ck-area__count">${a.met}/${a.total} met</span></h${h}>
        <p class="ck-area__summary">${esc(a.summary)}</p>
        <ul class="ck-criteria">
${items}
        </ul>
      </section>`;
  }).join("\n");

  return `<section class="ck-conformance" data-conformant="${report.conformant ? "true" : "false"}">
      <p class="ck-conformance__claim" data-conformant="${report.conformant ? "true" : "false"}">${esc(report.claim)}</p>
      <p class="ck-conformance__summary">${s.met}/${s.total} criteria met &middot; ${s.unmet} unmet &middot; ${s.notAssessed} not assessed &middot; <span class="ck-conformance__standard">${esc(report.standard)} v${esc(report.version)}</span></p>
      <div class="ck-conformance__areas">
${areaBlocks}
      </div>
    </section>`;
}

function renderCriterion(r, { evidenceHref, idPrefix }) {
  const href = typeof evidenceHref === "function" ? evidenceHref(r) : undefined;
  const evidenceLink = href
    ? ` <a class="ck-criterion__evidence" href="${esc(href)}">evidence &#8599;</a>`
    : "";
  const tier = r.tier ?? 1;
  return `          <li class="ck-criterion" id="${esc(idPrefix)}-${esc(r.id)}" data-status="${esc(r.status)}" data-area="${esc(r.area)}" data-tier="${esc(String(tier))}">
            <span class="ck-criterion__status ck-status--${esc(r.status)}">${esc(STATUS_LABEL[r.status] ?? r.status)}</span>
            <span class="ck-criterion__label">${esc(r.label)}</span>
            <span class="ck-criterion__standard">${esc(r.standard)} &middot; ${esc(r.level)}</span>
            <span class="ck-criterion__detail">${esc(r.detail)}</span>${evidenceLink}
          </li>`;
}
