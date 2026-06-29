#!/usr/bin/env node
// Palette gate — STATIC colour-palette analysis over a site/brand's design tokens.
// Three high-value checks that a per-page a11y scan (axe) cannot do, because they
// reason about the PALETTE itself — the colour math, not the rendered DOM:
//
//   1. CVD-SAFE CONTRAST — simulate every used colour under deuteranopia /
//      protanopia / tritanopia (Machado-2009 matrices), recompute WCAG contrast
//      for each declared pair under each CVD type, and FAIL any pair that drops
//      below AA for someone with that colour-vision deficiency. Also flag
//      CATEGORICAL colours that COLLAPSE (become indistinguishable, CIEDE2000 ΔE
//      below a threshold) once a CVD transform is applied.
//   2. APCA — the perceptual contrast metric (APCA-W3 ~0.1.9) the next WCAG (WCAG 3
//      / "Silver") is built around. Compute Lc per text pair, check against a
//      font-size/weight-aware minimum (or the documented baseline floor), and
//      report BOTH the APCA Lc AND the WCAG-2 ratio — complement, not replacement.
//   3. NON-TEXT CONTRAST (WCAG 2.2 SC 1.4.11) — UI pairs (borders, focus rings,
//      icon glyphs, control boundaries) require ≥ 3:1 against what they sit on.
//
// Zero-dependency: every colour-science primitive (sRGB→linear, relative
// luminance, WCAG ratio, CIE Lab, CIEDE2000, APCA-W3, the CVD matrices) is
// computed here by hand and CITED in-line, exactly like the kit's other gates.
//
//   node gates/palette-gate.mjs [tokens] [pairings]    # build gate (exit 1 on any failure)
//
// INPUTS the consumer supplies (nothing about any one brand is hard-coded):
//   argv[2] / $PALETTE_TOKENS    a token map: a DTCG `tokens.json` (primitive →
//                                semantic aliases resolved) OR a `tokens.css`
//                                (`--name: #hex;` custom properties).
//   argv[3] / $PALETTE_PAIRINGS  a `pairings.json` the consumer authors, declaring
//                                the fg/bg pairs that actually CO-OCCUR in the UI:
//                                  { "thresholds": { … optional overrides … },
//                                    "pairings": [ { "fg","bg","kind","size?","weight?","name?" } ],
//                                    "categorical": [ "tokenA","tokenB", … ] }
//                                `kind` ∈ text | large-text | ui. `fg`/`bg` are a
//                                token name (resolved from the map) or a literal #hex.
//                                `categorical` = colours that must stay mutually
//                                distinguishable (chart series, status colours, …).
//   $PALETTE_REPORT              path to write the machine-readable JSON report.
//
// Thresholds are config-driven (pairings.json `thresholds` ⊕ env) and FAIL CLOSED:
//   $PALETTE_MIN_RATIO_TEXT  (default 4.5)   WCAG AA, normal text   (SC 1.4.3)
//   $PALETTE_MIN_RATIO_LARGE (default 3.0)   WCAG AA, large text    (SC 1.4.3)
//   $PALETTE_MIN_RATIO_UI    (default 3.0)   non-text contrast      (SC 1.4.11)
//   $PALETTE_MIN_LC_TEXT     (default 60)    APCA baseline, body
//   $PALETTE_MIN_LC_LARGE    (default 45)    APCA baseline, large/headline
//   $PALETTE_COLLAPSE_DELTAE (default 10)    min CIEDE2000 ΔE between categorical
//                                            colours after a CVD transform
//
// The pure functions are exported for unit testing; the CLI is a thin wrapper.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 1. sRGB ↔ linear, relative luminance, WCAG-2 contrast ratio
//    Refs: WCAG 2.2 — "relative luminance" + "contrast ratio" definitions
//      https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
//      https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
//    IEC 61966-2-1:1999 (sRGB) transfer function.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a #rgb / #rrggbb (or bare-hex) string → [r,g,b] in 0..255. */
export function parseHex(s) {
  let h = String(s).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex colour: "${s}"`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** [r,g,b] 0..255 → "#rrggbb" (clamped + rounded). */
export function toHex(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/** sRGB channel 0..255 → linear-light 0..1. WCAG/IEC 61966-2-1 transfer fn. */
export function srgbToLinear(c) {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** linear-light 0..1 → sRGB channel 0..255 (inverse transfer fn). */
export function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
}

/** WCAG relative luminance of an sRGB [r,g,b]. L = 0.2126R+0.7152G+0.0722B (linear). */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG-2 contrast ratio of two sRGB colours: (L_light+0.05)/(L_dark+0.05), 1..21. */
export function wcagContrast(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CIE Lab + CIEDE2000 colour difference
//    Refs: sRGB→XYZ (D65) matrix, IEC 61966-2-1 / Bruce Lindbloom.
//      CIEDE2000: Sharma, Wu, Dalal (2005), "The CIEDE2000 Color-Difference
//      Formula: Implementation Notes, Supplementary Test Data, and Mathematical
//      Observations", Color Res. Appl. 30(1). http://www.ece.rochester.edu/~gsharma/ciede2000/
// ─────────────────────────────────────────────────────────────────────────────

/** sRGB [r,g,b] 0..255 → CIE L*a*b* (D65 reference white). */
export function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  // linear sRGB → XYZ (D65), IEC 61966-2-1 / sRGB→XYZ matrix.
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  // D65 reference white.
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const e = 216 / 24389, k = 24389 / 27; // CIE standard ε, κ
  const f = (t) => (t > e ? Math.cbrt(t) : (k * t + 16) / 116);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 ΔE between two CIE Lab colours (Sharma et al. 2005 reference impl). */
export function ciede2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b, ap) => {
    if (b === 0 && ap === 0) return 0;
    let h = Math.atan2(b, ap) * deg;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.20 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt(
    Math.pow(dLp / (kL * SL), 2) +
      Math.pow(dCp / (kC * SC), 2) +
      Math.pow(dHp / (kH * SH), 2) +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. APCA-W3 (Accessible Perceptual Contrast Algorithm), constants ~0.1.9 / 0.98G-4g.
//    Ref: Andrew Somers (Myndex), APCA-W3 / SAPC — https://github.com/Myndex/apca-w3
//    and https://github.com/Myndex/SAPC-APCA . Output `Lc` is a polarity-signed
//    "lightness contrast" roughly in [-108, 106]; conformance uses |Lc|.
//    APCA is a CANDIDATE method (WCAG 3 / "Silver"), reported ALONGSIDE — not in
//    place of — the WCAG-2 ratio.
// ─────────────────────────────────────────────────────────────────────────────

const SA98G = {
  mainTRC: 2.4,
  sRco: 0.2126729, sGco: 0.7151522, sBco: 0.0721750,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414,
  scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWoffset: 0.027, loWoBoffset: 0.027,
  deltaYmin: 0.0005, loClip: 0.1,
};

/** sRGB [r,g,b] 0..255 → APCA screen luminance Ys (simple power-curve, not WCAG luminance). */
export function apcaY(rgb) {
  const s = SA98G;
  return (
    s.sRco * Math.pow(rgb[0] / 255, s.mainTRC) +
    s.sGco * Math.pow(rgb[1] / 255, s.mainTRC) +
    s.sBco * Math.pow(rgb[2] / 255, s.mainTRC)
  );
}

/** APCA-W3 contrast Lc for text-luminance over background-luminance. */
export function apcaContrastY(txtY, bgY) {
  const s = SA98G;
  if (Math.min(txtY, bgY) < 0) return 0.0;
  // Soft-clamp near-black (low-luminance offset).
  if (txtY < s.blkThrs) txtY += Math.pow(s.blkThrs - txtY, s.blkClmp);
  if (bgY < s.blkThrs) bgY += Math.pow(s.blkThrs - bgY, s.blkClmp);
  if (Math.abs(bgY - txtY) < s.deltaYmin) return 0.0;
  let out;
  if (bgY > txtY) {
    // normal polarity: dark text on light bg
    const SAPC = (Math.pow(bgY, s.normBG) - Math.pow(txtY, s.normTXT)) * s.scaleBoW;
    out = SAPC < s.loClip ? 0.0 : SAPC - s.loBoWoffset;
  } else {
    // reverse polarity: light text on dark bg
    const SAPC = (Math.pow(bgY, s.revBG) - Math.pow(txtY, s.revTXT)) * s.scaleWoB;
    out = SAPC > -s.loClip ? 0.0 : SAPC + s.loWoBoffset;
  }
  return out * 100;
}

/** APCA Lc for a text fg over a bg, both sRGB [r,g,b]. Signed (polarity-aware). */
export function apcaContrast(fg, bg) {
  return apcaContrastY(apcaY(fg), apcaY(bg));
}

/**
 * Minimum |Lc| a text pair must clear. If size (px) / weight are given, use a
 * conservative font-aware tier derived from the APCA readability guidance ("Bronze"
 * use-case levels: Lc 90 ideal body, 75 min body column, 60 large/content, 45
 * large+bold/headline, 30 spot). Otherwise fall back to the baseline floor by kind.
 * Cited: APCA "Font Size & Weight" guidance, https://git.myndex.com/ (use-cases).
 * This is intentionally conservative (rounds UP a requirement, never down); a
 * consumer can override exactly via a per-pairing `minLc`.
 */
export function apcaMinLc({ kind, sizePx, weight, baseText = 60, baseLarge = 45 }) {
  if (sizePx != null) {
    const w = weight ?? 400;
    if (sizePx >= 36 || (sizePx >= 24 && w >= 700)) return baseLarge;       // big display
    if (sizePx >= 24 || (sizePx >= 18.5 && w >= 600)) return baseText;       // large text
    if (sizePx >= 18) return 75;                                             // body
    if (sizePx >= 16) return 90;                                             // small body
    return 100;                                                             // < 16px: max
  }
  return kind === "large-text" ? baseLarge : baseText;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Colour-vision-deficiency simulation — Machado 2009, severity 1.0 (dichromacy).
//    Ref: G. M. Machado, M. M. Oliveira, L. A. F. Fernandes (2009), "A
//    Physiologically-based Model for Simulation of Color Vision Deficiency",
//    IEEE Trans. Vis. Comput. Graph. 15(6). Matrices operate on LINEAR-light sRGB.
//    http://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
// ─────────────────────────────────────────────────────────────────────────────

export const CVD_MATRICES = {
  // protanopia (severity 1.0)
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  // deuteranopia (severity 1.0)
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  // tritanopia (severity 1.0)
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

export const CVD_TYPES = Object.keys(CVD_MATRICES);

/** Simulate how an sRGB [r,g,b] colour appears to someone with the given CVD type. */
export function simulateCVD(rgb, type) {
  const M = CVD_MATRICES[type];
  if (!M) throw new Error(`unknown CVD type: ${type}`);
  const lin = rgb.map(srgbToLinear); // Machado matrices act on linear light
  const out = M.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return out.map((c) => Math.round(linearToSrgb(Math.max(0, Math.min(1, c)))));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Threshold model + per-pair evaluation (pure)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS = {
  minRatioText: 4.5,   // WCAG 2.2 SC 1.4.3 (AA, normal text)
  minRatioLarge: 3.0,  // WCAG 2.2 SC 1.4.3 (AA, large text)
  minRatioUi: 3.0,     // WCAG 2.2 SC 1.4.11 (non-text contrast)
  minLcText: 60,       // APCA baseline floor, body
  minLcLarge: 45,      // APCA baseline floor, large
  collapseDeltaE: 10,  // categorical CIEDE2000 collapse floor
};

/** The WCAG-AA ratio floor for a pairing kind. */
export function ratioFloor(kind, t) {
  if (kind === "ui") return t.minRatioUi;
  if (kind === "large-text") return t.minRatioLarge;
  return t.minRatioText; // text (default)
}

/**
 * Evaluate ONE resolved pairing (fg/bg already hex) against all three checks.
 * Pure: (pairing, thresholds) → per-pair report. `kind` drives which checks apply:
 *   text / large-text → WCAG AA ratio, APCA Lc, and CVD-safe AA under every CVD.
 *   ui                → WCAG 1.4.11 (≥3:1), and CVD-safe ≥3:1 under every CVD.
 */
export function evaluatePair(pairing, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const kind = pairing.kind || "text";
  const fgRgb = parseHex(pairing.fgHex), bgRgb = parseHex(pairing.bgHex);
  const floor = ratioFloor(kind, t);

  const ratio = wcagContrast(fgRgb, bgRgb);
  const wcagPass = ratio + 1e-9 >= floor;

  // CVD-safe contrast: recompute the WCAG ratio with BOTH colours simulated.
  const cvd = { normalRatio: round2(ratio) };
  let cvdPass = true;
  for (const type of CVD_TYPES) {
    const r = wcagContrast(simulateCVD(fgRgb, type), simulateCVD(bgRgb, type));
    const pass = r + 1e-9 >= floor;
    cvd[type] = { ratio: round2(r), floor, pass };
    if (!pass) cvdPass = false;
  }
  cvd.pass = cvdPass;

  const checks = {};
  const isText = kind === "text" || kind === "large-text";

  checks.wcagAA = wcagPass;

  let apca = null;
  if (isText) {
    const Lc = apcaContrast(fgRgb, bgRgb);
    const minLc = pairing.minLc ?? apcaMinLc({
      kind, sizePx: pairing.size, weight: pairing.weight,
      baseText: t.minLcText, baseLarge: t.minLcLarge,
    });
    const apcaPass = Math.abs(Lc) + 1e-9 >= minLc;
    apca = { Lc: round1(Lc), absLc: round1(Math.abs(Lc)), min: minLc, pass: apcaPass };
    checks.apca = apcaPass;
  } else {
    checks.apca = null;
  }

  checks.nonText = kind === "ui" ? wcagPass : null;
  checks.cvdSafe = cvdPass;

  const passed =
    checks.wcagAA &&
    (checks.apca !== false) &&
    (checks.nonText !== false) &&
    cvdPass;

  return {
    name: pairing.name || `${pairing.fg} on ${pairing.bg}`,
    fg: { ref: pairing.fg, hex: toHex(fgRgb) },
    bg: { ref: pairing.bg, hex: toHex(bgRgb) },
    kind,
    size: pairing.size ?? null,
    weight: pairing.weight ?? null,
    wcag: { ratio: round2(ratio), min: floor, pass: wcagPass },
    apca,
    cvd,
    checks,
    passed,
  };
}

/**
 * Detect CATEGORICAL collapse: every unordered pair of categorical colours must
 * stay ≥ collapseDeltaE apart (CIEDE2000) under NORMAL vision AND under every CVD
 * transform. A pair that collapses post-transform is reported. Pure.
 */
export function evaluateCategorical(colors, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const collapses = [];
  const list = colors.map((c) => ({ ref: c.ref, rgb: parseHex(c.hex), hex: toHex(parseHex(c.hex)) }));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      const conditions = { normal: ciede2000(rgbToLab(A.rgb), rgbToLab(B.rgb)) };
      for (const type of CVD_TYPES) {
        conditions[type] = ciede2000(rgbToLab(simulateCVD(A.rgb, type)), rgbToLab(simulateCVD(B.rgb, type)));
      }
      for (const [cond, dE] of Object.entries(conditions)) {
        if (dE + 1e-9 < t.collapseDeltaE) {
          collapses.push({
            a: A.ref, b: B.ref, aHex: A.hex, bHex: B.hex,
            condition: cond, deltaE: round2(dE), min: t.collapseDeltaE,
          });
        }
      }
    }
  }
  return { threshold: t.collapseDeltaE, count: collapses.length, collapses };
}

/** Whole-palette evaluation: pairs + categorical collapse → fail-closed report. Pure. */
export function evaluatePalette({ pairings = [], categorical = [], thresholds = DEFAULT_THRESHOLDS } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const pairs = pairings.map((p) => evaluatePair(p, t));
  const cat = evaluateCategorical(categorical, t);

  const summary = {
    pairs: pairs.length,
    failingPairs: pairs.filter((p) => !p.passed).length,
    wcagFailures: pairs.filter((p) => !p.checks.wcagAA).length,
    cvdFailures: pairs.filter((p) => !p.cvd.pass).length,
    apcaFailures: pairs.filter((p) => p.checks.apca === false).length,
    nonTextFailures: pairs.filter((p) => p.checks.nonText === false).length,
    categoricalCollapses: cat.count,
  };
  const passed = summary.failingPairs === 0 && cat.count === 0;

  return {
    passed,
    thresholds: t,
    summary,
    pairs,
    categorical: cat,
    // Envelope a future lone `palette.cvd-safe` / `palette.apca` criterion can consume.
    palette: {
      cvdSafe: summary.cvdFailures === 0 && cat.count === 0,
      apcaBaseline: summary.apcaFailures === 0,
      nonTextContrast: summary.nonTextFailures === 0,
    },
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Token / pairing loading (impure; deterministic, no network/browser)
// ─────────────────────────────────────────────────────────────────────────────

/** Flatten a DTCG-ish tokens.json (primitive → semantic aliases) to { dotted.name → #hex }. */
export function tokensFromDTCG(json) {
  const flat = {}; // dotted path → raw $value (may be an alias or hex)
  const walk = (node, path) => {
    if (node && typeof node === "object") {
      if (typeof node.$value === "string" && (node.$type === "color" || /^#|^\{/.test(node.$value))) {
        flat[path.join(".")] = node.$value;
      }
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("$")) continue;
        walk(v, [...path, k]);
      }
    }
  };
  walk(json, []);
  const resolve1 = (v, seen = new Set()) => {
    const m = /^\{(.+)\}$/.exec(String(v).trim());
    if (!m) return v;
    if (seen.has(m[1])) throw new Error(`alias cycle at {${m[1]}}`);
    if (!(m[1] in flat)) throw new Error(`unresolved alias {${m[1]}}`);
    return resolve1(flat[m[1]], new Set([...seen, m[1]]));
  };
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    let resolved;
    try { resolved = resolve1(v); } catch { continue; }
    if (/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(String(resolved).replace(/^#/, "#"))) {
      out[k] = String(resolved).startsWith("#") ? resolved : "#" + resolved;
    }
  }
  return out;
}

/** Parse a tokens.css for `--name: #hex;` custom properties → { name(no --) → #hex }. */
export function tokensFromCSS(css) {
  const out = {};
  const re = /--([a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m;
  while ((m = re.exec(css))) out[m[1]] = m[2];
  return out;
}

/** Load a token map from a .json (DTCG) or .css path. */
export async function loadTokens(path) {
  const raw = await readFile(path, "utf8");
  if (path.endsWith(".json")) return tokensFromDTCG(JSON.parse(raw));
  if (path.endsWith(".css")) return tokensFromCSS(raw);
  // Best-effort: try JSON, else CSS.
  try { return tokensFromDTCG(JSON.parse(raw)); } catch { return tokensFromCSS(raw); }
}

/**
 * Resolve a colour REFERENCE (a token name or a literal #hex) against the map.
 * Tolerant of the brand's short names: tries the exact key, then common prefixes
 * (`bs-color-`, `bs-grade-`, `color.`, `bs-`), then a case-insensitive match.
 */
export function resolveColor(map, ref) {
  const r = String(ref).trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(r)) return r;
  if (r in map) return map[r];
  for (const p of ["bs-color-", "bs-grade-", "color.", "primitive.", "bs-"]) {
    if (p + r in map) return map[p + r];
  }
  const lc = r.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lc || k.toLowerCase().endsWith("-" + lc) || k.toLowerCase().endsWith("." + lc)) return v;
  }
  throw new Error(`unresolved colour reference: "${ref}"`);
}

/** Resolve a pairings.json spec (token names → hex) against a token map. */
export function resolvePairings(spec, map) {
  const pairings = (spec.pairings || []).map((p) => ({
    ...p,
    fgHex: resolveColor(map, p.fg),
    bgHex: resolveColor(map, p.bg),
  }));
  const categorical = (spec.categorical || []).map((ref) => ({ ref, hex: resolveColor(map, ref) }));
  return { pairings, categorical, thresholds: spec.thresholds || {} };
}

/** Full run: load tokens + pairings → resolve → evaluate. Exposed for tests. */
export async function runPaletteGate({ tokens, pairings, thresholds = {} }) {
  const map = typeof tokens === "string" ? await loadTokens(tokens) : tokens;
  const spec = typeof pairings === "string" ? JSON.parse(await readFile(pairings, "utf8")) : pairings;
  const resolved = resolvePairings(spec, map);
  return evaluatePalette({
    pairings: resolved.pairings,
    categorical: resolved.categorical,
    thresholds: { ...DEFAULT_THRESHOLDS, ...resolved.thresholds, ...thresholds },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. CLI
// ─────────────────────────────────────────────────────────────────────────────

function envThresholds() {
  const t = {};
  const num = (e) => (process.env[e] != null ? Number(process.env[e]) : undefined);
  const set = (k, e) => { const v = num(e); if (v != null && !Number.isNaN(v)) t[k] = v; };
  set("minRatioText", "PALETTE_MIN_RATIO_TEXT");
  set("minRatioLarge", "PALETTE_MIN_RATIO_LARGE");
  set("minRatioUi", "PALETTE_MIN_RATIO_UI");
  set("minLcText", "PALETTE_MIN_LC_TEXT");
  set("minLcLarge", "PALETTE_MIN_LC_LARGE");
  set("collapseDeltaE", "PALETTE_COLLAPSE_DELTAE");
  return t;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tokens = argv[0] || process.env.PALETTE_TOKENS;
  const pairings = argv[1] || process.env.PALETTE_PAIRINGS;
  if (!tokens || !pairings) {
    console.error("✗ palette-gate: usage: palette-gate.mjs <tokens.(json|css)> <pairings.json>");
    console.error("  (or set $PALETTE_TOKENS and $PALETTE_PAIRINGS)");
    process.exit(2);
  }

  const report = await runPaletteGate({ tokens, pairings, thresholds: envThresholds() });
  if (process.env.PALETTE_REPORT) {
    await writeFile(resolve(process.env.PALETTE_REPORT), JSON.stringify(report, null, 2) + "\n");
  }

  const s = report.summary;
  const line =
    `palette-gate: ${s.pairs} pair(s) — ${s.failingPairs} failing ` +
    `(WCAG ${s.wcagFailures}, CVD ${s.cvdFailures}, APCA ${s.apcaFailures}, non-text ${s.nonTextFailures}) · ` +
    `${s.categoricalCollapses} categorical collapse(s)`;

  const detail = (p) => {
    const bits = [`WCAG ${p.wcag.ratio}:1 (min ${p.wcag.min})`];
    if (p.apca) bits.push(`APCA |Lc| ${p.apca.absLc} (min ${p.apca.min})`);
    const cvdBad = CVD_TYPES.filter((c) => !p.cvd[c].pass).map((c) => `${c} ${p.cvd[c].ratio}:1`);
    if (cvdBad.length) bits.push(`CVD-fail: ${cvdBad.join(", ")}`);
    return `  · ${p.name} [${p.kind}] ${p.fg.hex}/${p.bg.hex} — ${bits.join("; ")}`;
  };

  if (!report.passed) {
    console.error(`✗ ${line}`);
    for (const p of report.pairs) if (!p.passed) console.error(detail(p));
    for (const c of report.categorical.collapses) {
      console.error(`  · collapse: ${c.a} vs ${c.b} (${c.aHex}/${c.bHex}) under ${c.condition} — ΔE ${c.deltaE} < ${c.min}`);
    }
    process.exit(1);
  }
  console.log(`✓ ${line}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ palette-gate: error —", e.stack || e.message); process.exit(1); });
}
