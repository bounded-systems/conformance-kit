#!/usr/bin/env node
// Typography gate — STATIC analysis over a site/brand's TYPE tokens (the
// font-size / line-height / weight / letter-&-word-&-paragraph-spacing recipes),
// member of the Token Accessibility suite. Like the palette gate it reasons about
// the TOKENS themselves — the values a design system ships — not a rendered page,
// so it answers a question axe cannot: "do these type tokens PERMIT accessible
// text, or do they bake in a barrier?"
//
// Four checks, each mapped to a WCAG success criterion:
//
//   1. BODY LINE-HEIGHT ≥ 1.5  (WCAG 2.2 SC 1.4.12 Text Spacing)
//      Body/paragraph styles must author a line-height of at least 1.5× the font
//      size. 1.4.12 is written as a USER-OVERRIDE criterion (no loss of content
//      when the reader sets line-height to 1.5) — a static token check approximates
//      the spirit by requiring the shipped body token not undercut that floor, and
//      by requiring it be expressed in an OVERRIDABLE unit (see check 2).
//
//   2. TEXT-SPACING ACHIEVABILITY  (WCAG 2.2 SC 1.4.12)
//      The criterion guarantees the reader can set letter-spacing ≥ 0.12em, word-
//      spacing ≥ 0.16em, paragraph-spacing ≥ 2em and line-height ≥ 1.5 with no loss
//      of content. From tokens alone we cannot prove "no loss of content", but we
//      CAN prove the tokens don't PRECLUDE those overrides: spacing/line-height must
//      be expressed in RELATIVE, overridable units (unitless / em / rem / %), never
//      pinned in px (which a user stylesheet without !important cannot scale past a
//      fixed line-box). A px-pinned line-height or letter-spacing on body is flagged.
//
//   3. MINIMUM FONT SIZE  (WCAG 1.4.4 Resize Text — supporting; readability)
//      Body text should be ≥ ~16px (recommended) and MUST clear a hard floor of
//      ~12px. Below the floor → error; between floor and recommended → warning. Plus
//      a modular-scale sanity check: the size ramp should be monotonic and each step
//      within a sane ratio band (no inversions, no absurd jumps, no exact dups).
//
//   4. WEIGHT × SIZE LEGIBILITY  (APCA cross-check; WCAG 1.4.3/1.4.6 spirit)
//      Hairline/thin weights (≤ 200) at small sizes render as low-contrast strokes.
//      Flag thin weight below a size threshold. AND cross-link the palette gate:
//      report the APCA Lc a style of this size/weight will REQUIRE wherever it is
//      coloured (thin + small ⇒ higher Lc), via palette-gate's `apcaMinLc`.
//
// Zero-dependency. Colour-science / APCA primitives are imported from the sibling
// palette gate (no duplication). The pure functions are exported for unit testing;
// the CLI is a thin wrapper that FAILS CLOSED (exit 1) on any error-severity finding.
//
//   node gates/typography-gate.mjs <type-tokens.(json|css)> [config.json]
//
// INPUTS the consumer supplies (nothing about any one brand is hard-coded):
//   argv[2] / $TYPO_TOKENS   a DTCG `tokens.json` (its `$type:"typography"` recipes,
//                            with `{size.*}` aliases resolved) OR a `tokens.css`
//                            (`.bs-text-*{ font-size; line-height; … }` recipe classes).
//   argv[3] / $TYPO_CONFIG   a `config.json` declaring which styles are BODY text
//                            (`{ "body":["body"], "thresholds":{…}, "styles":[…] }`).
//                            Only the consumer knows which token is the body recipe;
//                            line-height & min-size rules apply to those. `styles[]`
//                            can inline extra styles (for a CSS-less consumer) or
//                            override parsed ones.
//   $TYPO_REPORT             path to write the machine-readable JSON report.
//
// Thresholds are config-driven (`config.json` `thresholds` ⊕ env) and fail closed:
//   $TYPO_MIN_BODY_LINE_HEIGHT (default 1.5)  SC 1.4.12 body line-height floor
//   $TYPO_REC_BODY_PX          (default 16)   recommended body min (warn below)
//   $TYPO_MIN_BODY_PX          (default 12)   hard body min (error below)
//   $TYPO_MIN_LETTER_EM        (default 0.12) 1.4.12 letter-spacing override target
//   $TYPO_MIN_WORD_EM          (default 0.16) 1.4.12 word-spacing override target
//   $TYPO_MIN_PARA_EM          (default 2)    1.4.12 paragraph-spacing override target
//   $TYPO_THIN_WEIGHT          (default 200)  weight ≤ this is "thin/hairline"
//   $TYPO_THIN_MIN_PX          (default 24)   thin weight below this px → error
//   $TYPO_SCALE_MIN_RATIO      (default 1.05) min step ratio in the size ramp
//   $TYPO_SCALE_MAX_RATIO      (default 2.4)  max step ratio in the size ramp
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { apcaMinLc } from "./palette-gate.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Value parsing — dimensions, line-heights, spacings (pure)
//    Refs: CSS Values & Units (px/em/rem/%); a `rem`/`em` is resolved against the
//    document/element font size (we assume a 16px root, the browser default).
// ─────────────────────────────────────────────────────────────────────────────

const ROOT_PX = 16; // CSS initial root font-size (browser default).

/** A length string → { px, unit, value } or null. Supports px / rem / em / pt / %. */
export function parseLength(value, contextPx = ROOT_PX) {
  if (value == null) return null;
  if (typeof value === "number") return { px: value, unit: "px", value };
  const m = /^(-?[0-9]*\.?[0-9]+)\s*(px|rem|em|pt|%)?$/.exec(String(value).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] || "px";
  let px;
  if (unit === "px") px = n;
  else if (unit === "rem") px = n * ROOT_PX;
  else if (unit === "em") px = n * contextPx;
  else if (unit === "pt") px = (n * 96) / 72;
  else if (unit === "%") px = (n / 100) * contextPx;
  else px = n;
  return { px, unit, value: n };
}

/** A line-height (unitless | px | em | rem | %) → its RATIO to the font size. */
export function parseLineHeight(value, fontSizePx) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^-?[0-9]*\.?[0-9]+$/.test(s)) return { ratio: parseFloat(s), unit: "unitless", overridable: true };
  const len = parseLength(s, fontSizePx);
  if (!len) return null;
  const overridable = len.unit !== "px" && len.unit !== "pt"; // px/pt pin a fixed box
  return { ratio: fontSizePx ? len.px / fontSizePx : null, unit: len.unit, overridable };
}

/** A letter/word/paragraph spacing → em relative to font size. */
export function parseSpacingEm(value, fontSizePx) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "normal" || s === "0") return { em: 0, unit: s === "0" ? "unitless" : "normal", overridable: true };
  const len = parseLength(s, fontSizePx);
  if (!len) return null;
  if (len.unit === "em") return { em: len.value, unit: "em", overridable: true };
  if (len.unit === "rem" || len.unit === "%") return { em: fontSizePx ? len.px / fontSizePx : null, unit: len.unit, overridable: true };
  // px/pt: a fixed spacing the reader's relative override can't supersede cleanly.
  return { em: fontSizePx ? len.px / fontSizePx : null, unit: len.unit, overridable: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Token loading — DTCG `$type:"typography"` recipes, or `tokens.css` classes
// ─────────────────────────────────────────────────────────────────────────────

/** Flatten DTCG `size`/`dimension` tokens → { "size.text-body": "15px", … } (aliases kept). */
function flattenDimensions(json) {
  const out = {};
  const walk = (node, path) => {
    if (node && typeof node === "object") {
      if (typeof node.$value === "string" && (node.$type === "dimension" || /px|rem|em|pt|%$/.test(node.$value))) {
        out[path.join(".")] = node.$value;
      }
      for (const [k, v] of Object.entries(node)) if (!k.startsWith("$")) walk(v, [...path, k]);
    }
  };
  walk(json, []);
  return out;
}

/** Resolve a `{dotted.alias}` (or literal) against a flat map. */
function resolveAlias(v, flat, seen = new Set()) {
  const m = /^\{(.+)\}$/.exec(String(v).trim());
  if (!m) return v;
  if (seen.has(m[1]) || !(m[1] in flat)) return v;
  return resolveAlias(flat[m[1]], flat, new Set([...seen, m[1]]));
}

/**
 * Parse a DTCG tokens.json into normalized type styles:
 *   { name → { fontSizePx, lineHeight{ratio,unit,overridable}, fontWeight,
 *              letterSpacing{em,unit,overridable}, wordSpacing?, paragraphSpacing?,
 *              fontFamily, raw } }
 * `$type:"typography"` recipes are read from any tier (brand uses a `text` tier).
 */
export function typesFromDTCG(json) {
  const dims = flattenDimensions(json);
  const styles = {};
  const walk = (node, path) => {
    if (node && typeof node === "object") {
      if (node.$type === "typography" && node.$value && typeof node.$value === "object") {
        styles[path.join(".")] = normalizeStyle(node.$value, dims);
      }
      for (const [k, v] of Object.entries(node)) if (!k.startsWith("$")) walk(v, [...path, k]);
    }
  };
  walk(json, []);
  return styles;
}

function normalizeStyle(v, dims = {}) {
  const fsRaw = resolveAlias(v.fontSize, dims);
  const fontSizePx = parseLength(fsRaw)?.px ?? null;
  return {
    fontSizePx,
    fontSizeRaw: fsRaw,
    lineHeight: v.lineHeight != null ? parseLineHeight(v.lineHeight, fontSizePx) : null,
    fontWeight: v.fontWeight != null ? Number(v.fontWeight) : null,
    letterSpacing: v.letterSpacing != null ? parseSpacingEm(v.letterSpacing, fontSizePx) : null,
    wordSpacing: v.wordSpacing != null ? parseSpacingEm(v.wordSpacing, fontSizePx) : null,
    paragraphSpacing: v.paragraphSpacing != null ? parseSpacingEm(v.paragraphSpacing, fontSizePx) : null,
    fontFamily: v.fontFamily ?? null,
    raw: v,
  };
}

/** Parse a tokens.css of `.name { font-size; line-height; font-weight; letter-spacing }` recipes. */
export function typesFromCSS(css) {
  const styles = {};
  const re = /\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const name = m[1], body = m[2];
    const decl = {};
    for (const d of body.split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      decl[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    if (!("font-size" in decl) && !("line-height" in decl)) continue;
    styles[name] = normalizeStyle({
      fontSize: decl["font-size"],
      lineHeight: decl["line-height"],
      fontWeight: decl["font-weight"],
      letterSpacing: decl["letter-spacing"],
      wordSpacing: decl["word-spacing"],
      fontFamily: decl["font-family"],
    });
  }
  return styles;
}

export async function loadTypeTokens(path) {
  const raw = await readFile(path, "utf8");
  if (path.endsWith(".json")) return typesFromDTCG(JSON.parse(raw));
  if (path.endsWith(".css")) return typesFromCSS(raw);
  try { return typesFromDTCG(JSON.parse(raw)); } catch { return typesFromCSS(raw); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Thresholds + per-style evaluation (pure)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS = {
  minBodyLineHeight: 1.5, // SC 1.4.12
  recBodyPx: 16,          // recommended body min (warn below)
  minBodyPx: 12,          // hard body min (error below)
  minLetterEm: 0.12,      // SC 1.4.12 target
  minWordEm: 0.16,        // SC 1.4.12 target
  minParaEm: 2,           // SC 1.4.12 target
  thinWeight: 200,        // ≤ this is hairline/thin
  thinMinPx: 24,          // thin weight below this px → error
  scaleMinRatio: 1.05,    // size-ramp step floor
  scaleMaxRatio: 2.4,     // size-ramp step ceiling
};

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/** Evaluate ONE type style. `isBody` drives which checks are hard. Pure. */
export function evaluateStyle(name, style, isBody, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const findings = [];
  const add = (severity, sc, msg, data) => findings.push({ severity, sc, msg, ...data });
  const px = style.fontSizePx;

  // 1. Body line-height ≥ 1.5 (SC 1.4.12).
  if (isBody && style.lineHeight) {
    if (style.lineHeight.ratio != null && style.lineHeight.ratio + 1e-9 < t.minBodyLineHeight) {
      add("error", "1.4.12", `body line-height ${round2(style.lineHeight.ratio)} < ${t.minBodyLineHeight}`, { lineHeight: round2(style.lineHeight.ratio) });
    }
  }

  // 2. Text-spacing achievability — relative, overridable units (SC 1.4.12).
  if (style.lineHeight && style.lineHeight.overridable === false) {
    add(isBody ? "error" : "warn", "1.4.12", `line-height pinned in ${style.lineHeight.unit} (not user-overridable)`, { unit: style.lineHeight.unit });
  }
  for (const [prop, sp] of [["letterSpacing", style.letterSpacing], ["wordSpacing", style.wordSpacing], ["paragraphSpacing", style.paragraphSpacing]]) {
    if (sp && sp.overridable === false) {
      add(isBody ? "error" : "warn", "1.4.12", `${prop} pinned in ${sp.unit} (not user-overridable, can clip 1.4.12 spacing)`, { prop, unit: sp.unit });
    }
  }

  // 3. Minimum font size (body) — hard floor + recommended (SC 1.4.4 / readability).
  if (isBody && px != null) {
    if (px + 1e-9 < t.minBodyPx) add("error", "1.4.4", `body font-size ${px}px < hard floor ${t.minBodyPx}px`, { px });
    else if (px + 1e-9 < t.recBodyPx) add("warn", "1.4.4", `body font-size ${px}px < recommended ${t.recBodyPx}px`, { px });
  }

  // 4. Weight × size legibility + APCA cross-check (SC 1.4.3/1.4.6 spirit; APCA).
  if (px != null && style.fontWeight != null && style.fontWeight <= t.thinWeight && px < t.thinMinPx) {
    add("error", "1.4.8", `thin weight ${style.fontWeight} at ${px}px (< ${t.thinMinPx}px) — hairline strokes lose legibility`, { weight: style.fontWeight, px });
  }
  const requiredLc = px != null ? apcaMinLc({ sizePx: px, weight: style.fontWeight ?? 400 }) : null;

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    name,
    isBody,
    fontSizePx: px,
    fontWeight: style.fontWeight ?? null,
    lineHeight: style.lineHeight ? round2(style.lineHeight.ratio) : null,
    letterSpacingEm: style.letterSpacing ? round2(style.letterSpacing.em) : null,
    requiredApcaLc: requiredLc, // cross-link: wherever this style is coloured, palette gate must clear this Lc
    findings,
    passed: errors === 0,
  };
}

/** Modular-scale sanity over the distinct font sizes used. Pure. */
export function evaluateScale(sizesPx, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const sizes = [...new Set(sizesPx.filter((n) => typeof n === "number"))].sort((a, b) => a - b);
  const findings = [];
  for (let i = 1; i < sizes.length; i++) {
    const ratio = sizes[i] / sizes[i - 1];
    if (ratio + 1e-9 < t.scaleMinRatio) findings.push({ severity: "warn", msg: `near-duplicate scale step ${sizes[i - 1]}px→${sizes[i]}px (ratio ${round2(ratio)} < ${t.scaleMinRatio})`, from: sizes[i - 1], to: sizes[i], ratio: round2(ratio) });
    else if (ratio - 1e-9 > t.scaleMaxRatio) findings.push({ severity: "warn", msg: `large scale jump ${sizes[i - 1]}px→${sizes[i]}px (ratio ${round2(ratio)} > ${t.scaleMaxRatio})`, from: sizes[i - 1], to: sizes[i], ratio: round2(ratio) });
  }
  return { sizes, steps: Math.max(0, sizes.length - 1), findings };
}

/** Whole-typography evaluation → fail-closed report. Pure. */
export function evaluateTypography({ styles = {}, body = [], thresholds = DEFAULT_THRESHOLDS } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const bodySet = new Set(body);
  const results = Object.entries(styles).map(([name, s]) => evaluateStyle(name, s, bodySet.has(name) || bodySet.has(name.split(".").pop()), t));
  const scale = evaluateScale(Object.values(styles).map((s) => s.fontSizePx), t);

  const allFindings = [...results.flatMap((r) => r.findings.map((f) => ({ style: r.name, ...f }))), ...scale.findings.map((f) => ({ style: "<scale>", ...f }))];
  const errors = allFindings.filter((f) => f.severity === "error");
  const warns = allFindings.filter((f) => f.severity === "warn");

  return {
    passed: errors.length === 0,
    thresholds: t,
    summary: {
      styles: results.length,
      bodyStyles: results.filter((r) => r.isBody).length,
      errors: errors.length,
      warnings: warns.length,
    },
    styles: results,
    scale,
    findings: allFindings,
    // Envelope a future lone `typography.*` criterion can consume.
    typography: {
      bodyLineHeight: !errors.some((f) => f.sc === "1.4.12" && /line-height/.test(f.msg)),
      textSpacingAchievable: !errors.some((f) => f.sc === "1.4.12" && /pinned/.test(f.msg)),
      minFontSize: !errors.some((f) => f.sc === "1.4.4"),
      weightLegibility: !errors.some((f) => f.sc === "1.4.8"),
    },
  };
}

/** Full run: load tokens + config → evaluate. Exposed for tests. */
export async function runTypographyGate({ tokens, config = {}, thresholds = {} }) {
  const parsed = typeof tokens === "string" ? await loadTypeTokens(tokens) : tokens;
  const cfg = typeof config === "string" ? JSON.parse(await readFile(config, "utf8")) : config;
  const styles = { ...parsed };
  for (const s of cfg.styles || []) styles[s.name] = normalizeStyle(s);
  return evaluateTypography({
    styles,
    body: cfg.body || [],
    thresholds: { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}), ...thresholds },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CLI
// ─────────────────────────────────────────────────────────────────────────────

function envThresholds() {
  const t = {};
  const num = (e) => (process.env[e] != null ? Number(process.env[e]) : undefined);
  const set = (k, e) => { const v = num(e); if (v != null && !Number.isNaN(v)) t[k] = v; };
  set("minBodyLineHeight", "TYPO_MIN_BODY_LINE_HEIGHT");
  set("recBodyPx", "TYPO_REC_BODY_PX");
  set("minBodyPx", "TYPO_MIN_BODY_PX");
  set("minLetterEm", "TYPO_MIN_LETTER_EM");
  set("minWordEm", "TYPO_MIN_WORD_EM");
  set("minParaEm", "TYPO_MIN_PARA_EM");
  set("thinWeight", "TYPO_THIN_WEIGHT");
  set("thinMinPx", "TYPO_THIN_MIN_PX");
  set("scaleMinRatio", "TYPO_SCALE_MIN_RATIO");
  set("scaleMaxRatio", "TYPO_SCALE_MAX_RATIO");
  return t;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tokens = argv[0] || process.env.TYPO_TOKENS;
  const config = argv[1] || process.env.TYPO_CONFIG;
  if (!tokens) {
    console.error("✗ typography-gate: usage: typography-gate.mjs <type-tokens.(json|css)> [config.json]");
    console.error("  (or set $TYPO_TOKENS and $TYPO_CONFIG)");
    process.exit(2);
  }
  const cfg = config ? JSON.parse(await readFile(config, "utf8")) : {};
  const report = await runTypographyGate({ tokens, config: cfg, thresholds: envThresholds() });
  if (process.env.TYPO_REPORT) await writeFile(resolve(process.env.TYPO_REPORT), JSON.stringify(report, null, 2) + "\n");

  const s = report.summary;
  const line = `typography-gate: ${s.styles} style(s) (${s.bodyStyles} body) — ${s.errors} error(s), ${s.warnings} warning(s)`;
  const fmt = (f) => `  · [${f.severity}] ${f.style}${f.sc ? ` (SC ${f.sc})` : ""}: ${f.msg}`;
  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const f of report.findings) console.error(fmt(f));
    process.exit(1);
  }
  console.log(`✓ ${line}`);
  for (const f of report.findings) console.log(fmt(f)); // warnings only when passing
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ typography-gate: error —", e.stack || e.message); process.exit(1); });
}
