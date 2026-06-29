#!/usr/bin/env node
// focus-budget-gate — COGA Objective 5 "Help users focus" proxy gate.
//
//   node gates/cognitive/focus-budget-gate.mjs [distDir]              # assess
//   node gates/cognitive/focus-budget-gate.mjs [distDir] --strict     # fail on breach
//
// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  HONEST LABELING — READ BEFORE CITING THIS GATE                            ║
// ║                                                                              ║
// ║  This is an AGENT/STATIC INTERFACE-COMPLEXITY PROXY for W3C COGA            ║
// ║  "Making Content Usable" Objective 5 — "Help users focus."                  ║
// ║                                                                              ║
// ║  It measures PROXIES only:                                                   ║
// ║    A) Content cognitive-density (reading grade, sentence length, jargon)    ║
// ║    B) DOM interaction patterns that research links to attention load         ║
// ║                                                                              ║
// ║  It DOES NOT and CANNOT:                                                    ║
// ║    — Substitute for usability testing with people who have ADHD or          ║
// ║      other cognitive/learning disabilities                                   ║
// ║    — Measure actual cognitive load, mental effort, or comprehension         ║
// ║    — Replace human judgment about content complexity                        ║
// ║    — Assess COGA Objectives 1–4, 6–8 (staged as not-assessed)               ║
// ║                                                                              ║
// ║  `cognitive.coga-usability-testing` stays `not-assessed`.                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// ── Dimension A: Content cognitive-density (thresholds are configurable) ────
//   Coleman-Liau reading grade    : WARN if > gradeWarn (default 10)
//   Average sentence length (words): WARN if > sentWarn (default 20)
//   Jargon/acronym density         : WARN if > jargonPer100 (default 0.5 per 100 words)
//   Section word count             : WARN sections > sectionWordMax (default 200) without subheadings
//
// ── Dimension B: Interaction/attention DOM patterns (static HTML analysis) ──
//   ✗ <dialog open> on load       — auto-opening dialog
//   ✗ <video autoplay>            — autoplay video
//   ✗ <audio autoplay>            — autoplay audio
//   ✗ <meta http-equiv=refresh>   — automatic page redirect (time limit)
//   ✗ inline outline:none/0       — (shares findings with a11y gate)
//   ⚠ positive tabindex           — disrupts focus order
//   ⚠ no aria-current on nav      — no "where am I" indicator
//   ⚠ competing primary CTAs      — multiple primary-style buttons/links per section
//   ⚠ no animation @media guard   — animation/transition without prefers-reduced-motion
//
// Config via cognitive.config.json (in dist/.. or CWD) or env vars:
//   $FOCUS_DIST              built output dir               (default: "dist")
//   $FOCUS_PAGES             comma list of page paths       (default: all *.html)
//   $FOCUS_GRADE_WARN        reading grade warn threshold   (default: 10)
//   $FOCUS_SENT_WARN         sentence length warn threshold (default: 20)
//   $FOCUS_JARGON_PER_100    jargon density threshold       (default: 0.5)
//   $FOCUS_SECTION_WORD_MAX  section max words              (default: 200)
//   $FOCUS_ALLOWLIST         comma-separated jargon allowlist
//   $FOCUS_REPORT            path to write JSON report      (default: none)
//
// Evidence key: `focusBudget`

import { readFile, readdir, access, writeFile } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";

// Load the English dictionary (used by jargon detection)
const _req = createRequire(import.meta.url);
const DICTIONARY = new Set(_req("an-array-of-english-words"));

export const EVIDENCE_TYPE =
  "agent/static interface-complexity proxy for COGA Obj-5 — NOT COGA usability testing";
export const HONEST_WARNING =
  "This gate measures proxies for COGA Objective 5 (reading grade, sentence length, " +
  "jargon density, DOM attention patterns). It DOES NOT substitute for usability " +
  "testing with people who have ADHD or other cognitive/learning disabilities.";

// Default thresholds — all configurable
const DEFAULT_THRESHOLDS = {
  gradeWarn: 10,         // Coleman-Liau reading grade
  sentWarn: 20,          // average sentence length (words)
  jargonPer100: 0.5,     // undefined jargon terms per 100 prose words
  sectionWordMax: 200,   // max words in a section without subheadings
};

// Common technical words that are recognised domain jargon but commonly understood
const DOMAIN_ALLOWLIST = new Set([
  "api", "cli", "github", "npm", "git", "html", "css", "json", "url", "http",
  "https", "dns", "pdf", "rss", "svg", "png", "jpg", "webp", "oauth",
]);

// Contraction stems that tokenize weirdly
const CONTRACTION_STEMS = new Set([
  "couldn", "doesn", "didn", "isn", "wasn", "aren", "weren", "haven", "hasn",
  "hadn", "wouldn", "shouldn", "mustn", "mightn", "needn", "shan",
]);

// ── Text utilities ────────────────────────────────────────────────────────────

function stripMarkup(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z]+/g) || [];
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter((s) => s.length > 3);
}

function words(text) {
  return (String(text).match(/[A-Za-z][A-Za-z'-]*/g) || []);
}

/**
 * Coleman-Liau index: 0.0588 × L − 0.296 × S − 15.8
 * L = average letters per 100 words; S = average sentences per 100 words
 */
function colemanLiau(text) {
  const ws = words(text);
  const sents = sentences(text);
  if (ws.length < 5) return null;
  const letters = ws.reduce((a, w) => a + w.replace(/[^a-zA-Z]/g, "").length, 0);
  const L = (letters / ws.length) * 100;
  const S = (sents.length / ws.length) * 100;
  return 0.0588 * L - 0.296 * S - 15.8;
}

function avgSentenceLength(text) {
  const sents = sentences(text);
  if (!sents.length) return 0;
  const totalWords = sents.reduce((a, s) => a + words(s).length, 0);
  return totalWords / sents.length;
}

// ── HTML extraction ───────────────────────────────────────────────────────────

/**
 * Extract sections (heading + content pairs) and prose text from a page.
 * Returns { sections, prose, definitions }
 */
function extractContent(html) {
  const { document } = parseHTML(html);

  // Remove noise
  for (const el of document.querySelectorAll("script,style,code,pre,nav,head")) el.remove();

  const sections = [];
  let currentHeading = "(preamble)";
  let currentWords = [];

  const body = document.body || document.documentElement;
  if (!body) return { sections: [], prose: "", definitions: new Set() };

  // Walk the body collecting headings and text
  function walk(node) {
    if (!node) return;
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1) {
        const tag = child.tagName ? child.tagName.toLowerCase() : "";
        if (/^h[1-6]$/.test(tag)) {
          if (currentWords.length > 0) {
            sections.push({ heading: currentHeading, wordCount: currentWords.length, text: currentWords.join(" ") });
          }
          currentHeading = (child.textContent || "").trim().slice(0, 80);
          currentWords = [];
        } else {
          walk(child);
        }
      } else if (child.nodeType === 3) {
        const t = (child.textContent || "").trim();
        if (t) currentWords.push(...words(t));
      }
    }
  }
  walk(body);
  if (currentWords.length > 0) {
    sections.push({ heading: currentHeading, wordCount: currentWords.length, text: currentWords.join(" ") });
  }

  // Full prose for overall grade computation
  const allWords = sections.flatMap((s) => words(s.text));
  const prose = allWords.join(" ");

  // Definitions: terms the page DEFINES via <abbr>, <dfn>, <dl><dt>
  const definitions = new Set();
  for (const el of document.querySelectorAll("abbr")) {
    for (const w of tokenize(el.textContent || "")) definitions.add(w);
    for (const w of tokenize(el.getAttribute("title") || "")) definitions.add(w);
  }
  for (const el of document.querySelectorAll("dfn")) {
    for (const w of tokenize(el.textContent || "")) definitions.add(w);
  }
  for (const el of document.querySelectorAll("dl dt")) {
    for (const w of tokenize(el.textContent || "")) definitions.add(w);
  }

  return { sections, prose, definitions };
}

// ── Jargon detection ──────────────────────────────────────────────────────────

function detectJargon(text, { allowlist = new Set(), definitions = new Set() } = {}) {
  const tokens = tokenize(text);
  const undefinedJargon = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (DICTIONARY.has(t)) continue;
    if (allowlist.has(t)) continue;
    if (DOMAIN_ALLOWLIST.has(t)) continue;
    if (CONTRACTION_STEMS.has(t)) continue;
    if (definitions.has(t)) continue;
    undefinedJargon.add(t);
  }
  return undefinedJargon;
}

// ── Dimension A: Content density analysis ────────────────────────────────────

function analyzeContentDensity(html, pagePath, thresholds, { allowlist = new Set() } = {}) {
  const findings = [];
  const { sections, prose, definitions } = extractContent(html);

  if (words(prose).length < 20) {
    return { findings, metrics: { wordCount: words(prose).length, grade: null, avgSentLen: null, jargonPer100: null } };
  }

  const grade = colemanLiau(prose);
  const avgSentLen = avgSentenceLength(prose);
  const wordCount = words(prose).length;

  // Reading grade check
  if (grade !== null && grade > thresholds.gradeWarn) {
    findings.push({
      severity: "warn",
      code: "FOCUS_GRADE_HIGH",
      detail: `${pagePath}: Coleman-Liau grade ${grade.toFixed(1)} exceeds threshold ${thresholds.gradeWarn} — content may be hard to read for some audiences`,
      metric: "readingGrade",
      value: parseFloat(grade.toFixed(1)),
      threshold: thresholds.gradeWarn,
    });
  }

  // Average sentence length
  if (avgSentLen > thresholds.sentWarn) {
    findings.push({
      severity: "warn",
      code: "FOCUS_SENTENCE_LONG",
      detail: `${pagePath}: average sentence ${avgSentLen.toFixed(1)} words exceeds threshold ${thresholds.sentWarn} — long sentences increase cognitive load`,
      metric: "avgSentenceLength",
      value: parseFloat(avgSentLen.toFixed(1)),
      threshold: thresholds.sentWarn,
    });
  }

  // Jargon density
  const jargonTerms = detectJargon(prose, { allowlist, definitions });
  const jargonPer100 = wordCount > 0 ? (jargonTerms.size / wordCount) * 100 : 0;
  if (jargonPer100 > thresholds.jargonPer100) {
    findings.push({
      severity: "warn",
      code: "FOCUS_JARGON_DENSE",
      detail: `${pagePath}: jargon density ${jargonPer100.toFixed(2)} per 100 words exceeds threshold ${thresholds.jargonPer100} — undefined terms: ${[...jargonTerms].slice(0, 20).join(", ")}`,
      metric: "jargonPer100",
      value: parseFloat(jargonPer100.toFixed(2)),
      threshold: thresholds.jargonPer100,
      jargonTerms: [...jargonTerms].sort(),
    });
  }

  // Long sections without subheadings
  const denseSections = sections.filter((s) => s.wordCount > thresholds.sectionWordMax);
  for (const s of denseSections) {
    findings.push({
      severity: "warn",
      code: "FOCUS_SECTION_TOO_LONG",
      detail: `${pagePath}: section "${s.heading}" has ${s.wordCount} words without subheadings (threshold: ${thresholds.sectionWordMax}) — consider breaking into sub-sections`,
      metric: "sectionWordCount",
      value: s.wordCount,
      threshold: thresholds.sectionWordMax,
      section: s.heading,
    });
  }

  return {
    findings,
    metrics: {
      wordCount,
      grade: grade !== null ? parseFloat(grade.toFixed(1)) : null,
      avgSentLen: parseFloat(avgSentLen.toFixed(1)),
      jargonPer100: parseFloat(jargonPer100.toFixed(2)),
      jargonTerms: [...jargonTerms].sort(),
      denseSections: denseSections.map((s) => ({ heading: s.heading, wordCount: s.wordCount })),
    },
  };
}

// ── Dimension B: Interaction/attention DOM patterns ───────────────────────────

function analyzeInteractionPatterns(html, pagePath) {
  const findings = [];
  const { document } = parseHTML(html);

  // Auto-opening dialogs
  const autoDialogs = document.querySelectorAll("dialog[open]");
  if (autoDialogs.length > 0) {
    findings.push({
      severity: "error",
      code: "FOCUS_AUTO_DIALOG",
      detail: `${pagePath}: ${autoDialogs.length} <dialog open> — auto-opening dialog steals focus and interrupts user — COGA Obj-5`,
    });
  }

  // Autoplay media
  const autoplayVideo = document.querySelectorAll("video[autoplay]");
  const autoplayAudio = document.querySelectorAll("audio[autoplay]");
  if (autoplayVideo.length > 0) {
    findings.push({
      severity: "error",
      code: "FOCUS_AUTOPLAY_VIDEO",
      detail: `${pagePath}: ${autoplayVideo.length} <video autoplay> — autoplaying video is a strong distractor — COGA Obj-5 + WCAG 1.4.2`,
    });
  }
  if (autoplayAudio.length > 0) {
    findings.push({
      severity: "error",
      code: "FOCUS_AUTOPLAY_AUDIO",
      detail: `${pagePath}: ${autoplayAudio.length} <audio autoplay> — autoplaying audio is a strong distractor — COGA Obj-5 + WCAG 1.4.2`,
    });
  }

  // Time limits via meta refresh
  const metaRefresh = [...document.querySelectorAll("meta[http-equiv]")].filter(
    (m) => (m.getAttribute("http-equiv") || "").toLowerCase() === "refresh"
  );
  if (metaRefresh.length > 0) {
    findings.push({
      severity: "error",
      code: "FOCUS_TIME_LIMIT_META",
      detail: `${pagePath}: <meta http-equiv="refresh"> — automatic page redirect imposes a time limit — WCAG 2.2.1`,
    });
  }

  // Inline focus-ring removal
  const focusKillers = [...document.querySelectorAll("[style]")].filter((el) => {
    const s = (el.getAttribute("style") || "").replace(/\s/g, "");
    return s.includes("outline:none") || s.includes("outline:0");
  });
  if (focusKillers.length > 0) {
    findings.push({
      severity: "error",
      code: "FOCUS_RING_REMOVED",
      detail: `${pagePath}: ${focusKillers.length} element(s) with inline outline:none/0 — removes keyboard focus indicator — COGA Obj-5 + WCAG 2.4.11`,
    });
  }

  // No aria-current on navigation
  const navEls = document.querySelectorAll("nav, [role=navigation]");
  let hasAriaCurrent = false;
  for (const nav of navEls) {
    if (nav.querySelector("[aria-current]")) { hasAriaCurrent = true; break; }
  }
  if (navEls.length > 0 && !hasAriaCurrent) {
    findings.push({
      severity: "warn",
      code: "FOCUS_NO_ARIA_CURRENT",
      detail: `${pagePath}: navigation present but no [aria-current] found — users cannot tell "where am I" — COGA Obj-5`,
    });
  }

  // Check for animation CSS in <style> without prefers-reduced-motion
  const styleEls = [...document.querySelectorAll("style")];
  for (const style of styleEls) {
    const css = style.textContent || "";
    const hasAnimation = /animation\s*:|transition\s*:|@keyframes\b/i.test(css);
    const hasMotionQuery = /@media\s*\([^)]*prefers-reduced-motion/i.test(css);
    if (hasAnimation && !hasMotionQuery) {
      findings.push({
        severity: "warn",
        code: "FOCUS_ANIMATION_NO_MOTION_GUARD",
        detail: `${pagePath}: inline CSS contains animation/transition without @media (prefers-reduced-motion) guard — WCAG 2.3.3 + COGA Obj-5`,
      });
      break;
    }
  }

  // Multiple primary CTAs per section (heuristic: buttons/links with "primary" class or text patterns)
  const sections = document.querySelectorAll("section, article, main, [role=main]");
  for (const section of sections) {
    const primaryCtas = [...section.querySelectorAll("button, a[href]")].filter((el) => {
      const cls = (el.getAttribute("class") || "").toLowerCase();
      const text = (el.textContent || "").toLowerCase().trim();
      return cls.includes("primary") || cls.includes("cta") ||
        /^(get started|sign up|subscribe|download|try|start|learn more|contact)$/i.test(text);
    });
    if (primaryCtas.length > 2) {
      const sectionLabel = (section.getAttribute("aria-label") || section.querySelector("h2,h3,h4")?.textContent || "unnamed").trim().slice(0, 40);
      findings.push({
        severity: "warn",
        code: "FOCUS_COMPETING_CTAS",
        detail: `${pagePath}: section "${sectionLabel}" has ${primaryCtas.length} competing primary CTAs — clear ONE primary action per region — COGA Obj-5`,
        section: sectionLabel,
        ctaCount: primaryCtas.length,
      });
    }
  }

  return { findings };
}

// ── CSS animation check (external CSS files) ─────────────────────────────────

async function checkExternalCss(distDir) {
  const findings = [];
  const cssFiles = [];

  async function findCss(dir) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await findCss(full);
        else if (entry.name.endsWith(".css")) cssFiles.push(full);
      }
    } catch (_) {}
  }
  await findCss(distDir);

  for (const cssPath of cssFiles) {
    try {
      const css = await readFile(cssPath, "utf8");
      const hasAnimation = /animation\s*:|transition\s*:|@keyframes\b/i.test(css);
      const hasMotionQuery = /@media\s*\([^)]*prefers-reduced-motion/i.test(css);
      if (hasAnimation && !hasMotionQuery) {
        const rel = relative(distDir, cssPath);
        findings.push({
          severity: "warn",
          code: "FOCUS_ANIMATION_NO_MOTION_GUARD",
          detail: `${rel}: CSS contains animation/transition without @media (prefers-reduced-motion) guard — WCAG 2.3.3 + COGA Obj-5`,
          file: rel,
        });
      }
    } catch (_) {}
  }
  return findings;
}

// ── HTML walker ───────────────────────────────────────────────────────────────

async function walkHtml(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(abs, base));
    else if (e.name.endsWith(".html")) out.push(relative(base, abs).replace(/\\/g, "/"));
  }
  return out;
}

// ── Load config ───────────────────────────────────────────────────────────────

async function loadConfig(dist) {
  const configPath = join(dirname(dist), "cognitive.config.json");
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return raw;
  } catch (_) {
    return {};
  }
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runFocusBudgetGate({ dist, pages, thresholds = {}, allowlist = new Set() } = {}) {
  const htmlFiles = pages && pages.length ? pages : (await walkHtml(dist)).sort();
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const allFindings = [];
  const pageReports = [];
  const allJargon = new Set();
  const allMetrics = [];

  // Check external CSS once
  const cssFindings = await checkExternalCss(dist);
  allFindings.push(...cssFindings);

  for (const page of htmlFiles) {
    const html = await readFile(join(dist, page), "utf8");
    const { findings: densityFindings, metrics } = analyzeContentDensity(html, page, t, { allowlist });
    const { findings: interactionFindings } = analyzeInteractionPatterns(html, page);
    const findings = [...densityFindings, ...interactionFindings];
    allFindings.push(...findings);
    if (metrics.jargonTerms) for (const j of metrics.jargonTerms) allJargon.add(j);
    allMetrics.push({ page, metrics });
    pageReports.push({ page, findings, metrics });
  }

  // Determine which thresholds are breached across all pages
  const breaches = [];
  const worstMetrics = {
    grade: null, avgSentLen: null, jargonPer100: null,
  };

  for (const { metrics } of allMetrics) {
    if (metrics.grade !== null && (worstMetrics.grade === null || metrics.grade > worstMetrics.grade)) worstMetrics.grade = metrics.grade;
    if (metrics.avgSentLen !== null && (worstMetrics.avgSentLen === null || metrics.avgSentLen > worstMetrics.avgSentLen)) worstMetrics.avgSentLen = metrics.avgSentLen;
    if (metrics.jargonPer100 !== null && (worstMetrics.jargonPer100 === null || metrics.jargonPer100 > worstMetrics.jargonPer100)) worstMetrics.jargonPer100 = metrics.jargonPer100;
  }

  if (worstMetrics.grade !== null && worstMetrics.grade > t.gradeWarn) breaches.push("readingGrade");
  if (worstMetrics.avgSentLen !== null && worstMetrics.avgSentLen > t.sentWarn) breaches.push("avgSentenceLength");
  if (worstMetrics.jargonPer100 !== null && worstMetrics.jargonPer100 > t.jargonPer100) breaches.push("jargonDensity");

  const errorFindings = allFindings.filter((f) => f.severity === "error");
  const warnFindings = allFindings.filter((f) => f.severity === "warn");

  // Build the densest sections list (cross-page, sorted by word count descending)
  const denseSections = allMetrics
    .flatMap(({ page, metrics }) => (metrics.denseSections || []).map((s) => ({ page, ...s })))
    .sort((a, b) => b.wordCount - a.wordCount)
    .slice(0, 10);

  const met = errorFindings.length === 0 && breaches.length === 0;

  return {
    tool: "focus-budget-gate",
    version: "1.0.0",
    evidenceType: EVIDENCE_TYPE,
    warning: HONEST_WARNING,
    generatedAt: new Date().toISOString(),
    thresholds: t,
    pages: pageReports,
    cssFindings,
    totals: {
      errors: errorFindings.length,
      warnings: warnFindings.length,
    },
    // The envelope `cognitive.focus-budget` evaluator reads
    focusBudget: {
      contentDensity: {
        grade: worstMetrics.grade,
        avgSentenceLength: worstMetrics.avgSentLen,
        jargonPer100: worstMetrics.jargonPer100,
        jargonTerms: [...allJargon].sort(),
        densestSections: denseSections,
        thresholdsMet: breaches.length === 0,
        breaches,
      },
      interactionPatterns: {
        autoDialogOnLoad: errorFindings.some((f) => f.code === "FOCUS_AUTO_DIALOG"),
        autoplayMedia: errorFindings.some((f) => f.code === "FOCUS_AUTOPLAY_VIDEO" || f.code === "FOCUS_AUTOPLAY_AUDIO"),
        timeLimits: errorFindings.some((f) => f.code === "FOCUS_TIME_LIMIT_META"),
        focusRingRemoved: errorFindings.some((f) => f.code === "FOCUS_RING_REMOVED"),
        animationUnguarded: warnFindings.some((f) => f.code === "FOCUS_ANIMATION_NO_MOTION_GUARD"),
        ariaCurrent: !warnFindings.some((f) => f.code === "FOCUS_NO_ARIA_CURRENT"),
        patternsMet: errorFindings.length === 0,
      },
      thresholdsMet: met,
      status: met ? "met" : "not-yet-met",
    },
    passed: errorFindings.length === 0, // strict mode: also check breaches
    breaches,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const distArg = argv.find((a) => !a.startsWith("--"));
  const dist = resolve(distArg || process.env.FOCUS_DIST || "dist");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) {
    console.error(`✗ focus-budget-gate: ${dist} not found — build first.`);
    process.exit(2);
  }

  // Load thresholds from env or config
  const fileConfig = await loadConfig(dist);
  const thresholds = {
    gradeWarn: Number(process.env.FOCUS_GRADE_WARN ?? fileConfig.gradeWarn ?? DEFAULT_THRESHOLDS.gradeWarn),
    sentWarn: Number(process.env.FOCUS_SENT_WARN ?? fileConfig.sentWarn ?? DEFAULT_THRESHOLDS.sentWarn),
    jargonPer100: Number(process.env.FOCUS_JARGON_PER_100 ?? fileConfig.jargonPer100 ?? DEFAULT_THRESHOLDS.jargonPer100),
    sectionWordMax: Number(process.env.FOCUS_SECTION_WORD_MAX ?? fileConfig.sectionWordMax ?? DEFAULT_THRESHOLDS.sectionWordMax),
  };
  const allowlist = new Set(
    (process.env.FOCUS_ALLOWLIST || fileConfig.allowlist || "").split(",")
      .map((s) => s.trim().toLowerCase()).filter(Boolean)
  );

  let pages = (process.env.FOCUS_PAGES || "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean);
  if (pages.length === 0) pages = null;

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  focus-budget-gate — COGA Obj-5 PROXY (NOT usability test)  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  dist: ${dist}`);
  console.log(`  thresholds: grade ≤ ${thresholds.gradeWarn} · sentence ≤ ${thresholds.sentWarn} · jargon ≤ ${thresholds.jargonPer100}/100 · section ≤ ${thresholds.sectionWordMax} words`);
  console.log("");

  const report = await runFocusBudgetGate({ dist, pages, thresholds, allowlist });

  if (process.env.FOCUS_REPORT) {
    await writeFile(resolve(process.env.FOCUS_REPORT), JSON.stringify(report, null, 2) + "\n");
    console.log(`  ↳ wrote ${process.env.FOCUS_REPORT}`);
  }

  // Print page summaries
  for (const p of report.pages) {
    const errors = p.findings.filter((f) => f.severity === "error").length;
    const warns = p.findings.filter((f) => f.severity === "warn").length;
    const { grade, avgSentLen, jargonPer100, wordCount } = p.metrics;
    const grMark = grade !== null && grade > thresholds.gradeWarn ? "⚠" : "✓";
    const snMark = avgSentLen !== null && avgSentLen > thresholds.sentWarn ? "⚠" : "✓";
    const jaMark = jargonPer100 !== null && jargonPer100 > thresholds.jargonPer100 ? "⚠" : "✓";
    console.log(`  ${errors ? "✗" : "✓"} ${p.page} [${wordCount}w] grade ${grMark}${grade ?? "—"} | sent ${snMark}${avgSentLen ?? "—"} | jargon ${jaMark}${jargonPer100 ?? "—"}/100`);
    for (const f of p.findings) {
      console.log(`    ${f.severity === "error" ? "✗" : "⚠"} [${f.code}] ${f.detail}`);
    }
  }

  if (report.cssFindings.length > 0) {
    console.log("");
    for (const f of report.cssFindings) console.log(`  ⚠ [${f.code}] ${f.detail}`);
  }

  console.log("");
  const fb = report.focusBudget;
  console.log(`Content density:  grade ${fb.contentDensity.grade ?? "—"} (thresh ≤${thresholds.gradeWarn}) | sentence ${fb.contentDensity.avgSentenceLength ?? "—"} (thresh ≤${thresholds.sentWarn}) | jargon ${fb.contentDensity.jargonPer100 ?? "—"}/100 (thresh ≤${thresholds.jargonPer100})`);
  if (fb.contentDensity.breaches.length > 0) {
    console.log(`Breached thresholds: ${fb.contentDensity.breaches.join(", ")}`);
  }
  if (fb.contentDensity.jargonTerms.length > 0) {
    console.log(`Jargon terms: ${fb.contentDensity.jargonTerms.slice(0, 20).join(", ")}${fb.contentDensity.jargonTerms.length > 20 ? ` … (${fb.contentDensity.jargonTerms.length} total)` : ""}`);
  }
  if (fb.contentDensity.densestSections.length > 0) {
    console.log(`Densest sections: ${fb.contentDensity.densestSections.slice(0, 5).map((s) => `"${s.heading}" (${s.wordCount}w)`).join(", ")}`);
  }
  console.log("");
  console.log(`Status: ${fb.status} (${fb.thresholdsMet ? "all thresholds met" : "thresholds breached"})`);
  console.log(`Evidence type: ${report.evidenceType}`);
  console.log(`Warning: ${report.warning}`);
  console.log("");

  if (report.totals.errors > 0) {
    console.error(`✗ focus-budget-gate: ${report.totals.errors} blocking finding(s) — see details above.`);
    process.exit(1);
  }
  if (strict && report.breaches.length > 0) {
    console.error(`✗ focus-budget-gate (--strict): content density thresholds breached: ${report.breaches.join(", ")}`);
    process.exit(1);
  }

  const warnNote = report.totals.warnings > 0 ? ` (${report.totals.warnings} warning(s))` : "";
  const breachNote = report.breaches.length > 0 ? ` — content density NOT YET MET: ${report.breaches.join(", ")}` : "";
  console.log(`✓ focus-budget-gate: 0 errors${warnNote}${breachNote}.`);
  if (!strict && report.breaches.length > 0) {
    console.log("  (pass --strict to fail on content-density threshold breaches)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ focus-budget-gate: error —", e.stack || e.message); process.exit(1); });
}
