#!/usr/bin/env node
// CSS purity gate — "no inline values, always tokens." A static, declaration-aware
// scanner (no browser) that fails closed when a stylesheet hard-codes a design value
// that should come from the token system. It generalises colour-purity to DIMENSIONS:
// spacing, sizing, gaps, radii, widths — the raw `320px` / `28px` / `48px` values that,
// uncoordinated, produce overflow and overlap. Force them through a coherent token
// scale (`var(--bs-space-*)`, `var(--bs-size-*)`…) and the composition becomes
// predictable + verifiable, instead of a render-time surprise.
//
//   node gates/css-purity-gate.mjs <a.css> [b.css …]
//
// Config (env):
//   $PURITY_PREFIX        token var() prefix that counts as "a token"  (default: --bs-)
//   $PURITY_DIMENSIONS=0  turn OFF the dimension check                 (default: on)
//   $PURITY_COLORS=1      ALSO forbid literal colours (hex/rgb/named)  (default: off)
//   $PURITY_DIM_PROPS     comma list of properties to enforce          (default: the set below)
//   $PURITY_ALLOW         extra comma raw values to permit (e.g. 1px)  (default: none beyond builtins)
//   $PURITY_HAIRLINE=1    permit a bare 1px (hairline borders)         (default: off)
//
// Builtin allowances (never flagged): 0 / 0px, percentages, fr, ch/ex (text measure),
// auto, fit-content, min/max-content, none, the global keywords, and any value wholly
// inside var()/env(). `calc(...)` passes iff every length inside is a token/allowance.

// ── Pure core (no fs; unit-testable) ─────────────────────────────────────────

/** The dimension properties whose values must be tokens (raw lengths forbidden). */
export const DEFAULT_DIM_PROPS = [
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-block", "margin-inline",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "padding-block", "padding-inline",
  "gap", "row-gap", "column-gap", "grid-gap",
  "top", "right", "bottom", "left", "inset",
  "border-radius", "border-width",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "outline-width", "outline-offset", "flex-basis",
  "grid-template-columns", "grid-template-rows", "grid-auto-columns", "grid-auto-rows",
  "font-size", "line-height", "letter-spacing", "word-spacing", "text-indent",
];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\s*\(/i;
const RAW_LEN = /(?<![\w.#-])\d*\.?\d+(px|rem|em|pt|cm|mm|in|pc|vw|vh|vmin|vmax|q)\b/gi;
const BUILTIN_ALLOW = new Set(["0", "auto", "none", "fit-content", "min-content", "max-content", "inherit", "initial", "unset", "revert"]);

/** Strip var(...)/env(...) refs and string/url() literals so only "bare" values remain. */
function stripTokensAndLiterals(value) {
  return value
    .replace(/\b(?:var|env)\(\s*--[\w-]+[^)]*\)/gi, " ") // token refs
    .replace(/url\([^)]*\)/gi, " ")
    .replace(/(["']).*?\1/g, " ");
}

/** A bare token like `100%`, `1fr`, `2ch`, `0` is allowed (not a hard length). */
function isAllowedBare(tok, allow) {
  if (!tok) return true;
  if (BUILTIN_ALLOW.has(tok)) return true;
  if (allow.has(tok)) return true;
  if (/^\d*\.?\d+(%|fr|ch|ex)$/.test(tok)) return true; // proportional / text-measure units
  if (/^0(px|rem|em|pt|vw|vh|vmin|vmax)?$/.test(tok)) return true; // zero in any unit
  return false;
}

/** Find raw lengths a dimension declaration uses outside the token system. */
export function rawLengthsIn(value, { allow = new Set() } = {}) {
  const bare = stripTokensAndLiterals(value);
  return [...bare.matchAll(RAW_LEN)].map((m) => m[0]).filter((len) => !isAllowedBare(len, allow));
}

/**
 * Scan CSS text → violations. Declaration-aware (a `:` whose value runs to `;`/`}` is a
 * declaration; a `:` running into `{` is a selector and skipped).
 */
export function checkCssPurity(css, {
  prefix = "--bs-", dimensions = true, colors = false,
  dimProps = DEFAULT_DIM_PROPS, allow = new Set(), vocab = null,
} = {}) {
  const props = new Set(dimProps);
  const out = [];
  const noComments = String(css).replace(/\/\*[\s\S]*?\*\//g, " ");
  let line = 1;
  // Walk declarations: split on { ; } so each segment is one selector/at-rule preamble
  // or one declaration. A segment with a `:` whose left side is a real property is a
  // declaration; selectors and at-rule preambles have no bare `property:` we enforce.
  for (const decl of noComments.split(/[{;}]/)) {
    const nl = (decl.match(/\n/g) || []).length;
    const colon = decl.indexOf(":");
    if (colon === -1) { line += nl; continue; } // selector / at-rule with no value
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!prop || !value) { line += nl; continue; }

    if (vocab) {
      for (const m of value.matchAll(new RegExp(`var\\(\\s*(${prefix.replace(/[-]/g, "\\$&")}[\\w-]+)`, "g")))
        if (!vocab.has(m[1])) out.push({ line, kind: "unknown-token", prop, detail: m[1] });
    }
    if (dimensions && props.has(prop)) {
      for (const raw of rawLengthsIn(value, { allow }))
        out.push({ line, kind: "raw-dimension", prop, detail: raw, value });
    }
    if (colors) {
      const stripped = value.replace(new RegExp(`var\\(\\s*${prefix.replace(/[-]/g, "\\$&")}[\\w-]+[^)]*\\)`, "gi"), " ")
        .replace(/url\([^)]*\)/gi, " ").replace(/(["']).*?\1/g, " ");
      const hex = stripped.match(HEX); if (hex) out.push({ line, kind: "literal-color", prop, detail: hex[0] });
      const fn = stripped.match(COLOR_FN); if (fn) out.push({ line, kind: "literal-color", prop, detail: fn[1] });
    }
    line += nl;
  }
  return { ok: out.length === 0, violations: out };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const { readFile } = await import("node:fs/promises");
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) { console.error("✗ css-purity-gate: usage: css-purity-gate.mjs <a.css> [b.css …]"); process.exit(2); }

  const allow = new Set((process.env.PURITY_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (process.env.PURITY_HAIRLINE === "1") allow.add("1px");
  const opts = {
    prefix: process.env.PURITY_PREFIX || "--bs-",
    dimensions: process.env.PURITY_DIMENSIONS !== "0",
    colors: process.env.PURITY_COLORS === "1",
    dimProps: process.env.PURITY_DIM_PROPS ? process.env.PURITY_DIM_PROPS.split(",").map((s) => s.trim()) : DEFAULT_DIM_PROPS,
    allow,
  };

  let total = 0;
  for (const f of files) {
    const { violations } = checkCssPurity(await readFile(f, "utf8"), opts);
    total += violations.length;
    for (const v of violations) console.error(`  ✗ ${f}:${v.line} ${v.prop}: ${v.detail}  (${v.kind})`);
  }
  if (total) { console.error(`✗ css-purity-gate: ${total} inline value(s) that must be tokens across ${files.length} file(s)`); process.exit(1); }
  console.log(`✓ css-purity-gate: ${files.length} file(s) — every enforced value is a token`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ css-purity-gate: error —", e.stack || e.message); process.exit(1); });
}
