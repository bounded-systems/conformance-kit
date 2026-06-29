#!/usr/bin/env node
// Pairing extractor — the COVERAGE engine of the Token Accessibility suite. The
// contrast / CVD / APCA checks in the palette gate are only as complete as their
// pairings list, and a HAND-MAINTAINED pairings.json misses combos — that's exactly
// how the bounded.tools opacity-contrast regression slipped through. This tool
// DERIVES the real foreground×background pairings from ACTUAL stylesheet usage, so
// coverage is complete without hand-declaring every pair, then feeds them to the
// palette gate and emits a human-readable PAIRING MATRIX (every fg×bg combo actually
// used → WCAG ratio · APCA Lc · per-CVD ratios) so a reviewer can SEE what co-occurs
// and that it's all clean.
//
// HOW (zero-dep, bounded, documented heuristic — no DOM, so no full cascade):
//   1. Parse the stylesheet(s) into rules: selector-list → { color, background,
//      border-color, outline-color, fill, stroke }, resolving `var(--token)` and
//      literal colours against the token map.
//   2. A rule that sets BOTH a foreground (color/fill/stroke/border) and a
//      background → a DEFINITE co-occurrence (confidence "rule").
//   3. A rule that sets only a foreground is paired with a background by STRUCTURAL
//      containment: the nearest ancestor selector (by selector-string prefix, e.g.
//      `.card` is an ancestor of `.card .title`) that declares a background; else
//      the ROOT surface (`:root`/`html`/`body` background) (confidence "surface").
//   4. `border-color`/`outline-color` foregrounds are `kind:"ui"`; everything else
//      defaults to `kind:"text"` (a consumer override map can re-tag).
//   5. Dedup by (fgHex,bgHex,kind). DECLARED pairings (an optional supplement) are
//      UNIONED in, so you get extracted ∪ declared.
//
// HONEST SCOPE: containment-by-selector-prefix is a heuristic, not a real cascade —
// it can pair a fg with a backdrop it never actually renders on (false positive,
// SAFE: an extra clean pair) or, for deeply dynamic DOMs, miss a backdrop (covered
// by also pairing against the root surface). Treat the matrix as "every combo the
// stylesheet PLAUSIBLY puts together", reviewed by a human — superset coverage beats
// a hand-list that silently omits the dangerous pair.
//
// Zero-dependency; colour-science + evaluation imported from the palette gate.
//
//   node gates/pairing-extractor.mjs <tokens.(json|css)> <style1.css> [style2.css …]
//
// INPUTS / ENV:
//   $PAIRING_DECLARED   optional pairings.json to UNION in (declared ∪ extracted).
//   --allowlist | $PAIRING_ALLOWLIST=1   CLOSED-WORLD: `declared` is the opt-in
//                       allowlist — every extracted pairing must be declared (else an
//                       `undeclared` violation) and every declared pairing must pass.
//   $PAIRING_MATRIX     write the Markdown matrix here (else stdout).
//   $PAIRING_REPORT     write the full JSON report here.
//   $PAIRING_GATE       "1" → also run the palette gate over the union and exit 1 on
//                       any failing pair (default: report-only, exit 0).
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tokensFromCSS, loadTokens, resolveColor, evaluatePair, evaluatePalette, CVD_TYPES, parseHex, toHex } from "./palette-gate.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Minimal CSS rule parser (zero-dep) — selectors → colour-bearing declarations
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_PROPS = {
  color: "fg", fill: "fg", stroke: "fg",
  "border-color": "ui", "border-top-color": "ui", "border-bottom-color": "ui",
  "border-left-color": "ui", "border-right-color": "ui", "outline-color": "ui",
  "background-color": "bg", background: "bg",
};

/** Strip comments + at-rule prelude noise, then yield { selectors:[], decls:{} } rules. */
export function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  // Flatten one level of @media/@supports by stripping the at-rule wrapper braces.
  const body = clean.replace(/@(media|supports|layer)[^{]*\{/g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const selectors = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (!selectors.length || selectors[0].startsWith("@")) continue;
    const decls = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    rules.push({ selectors, decls });
  }
  return rules;
}

/** Resolve a CSS colour VALUE (`var(--t)`, `#hex`, or a token name) to #hex, or null. */
export function resolveCssColor(value, map) {
  if (value == null) return null;
  let v = String(value).trim();
  const varm = /var\(\s*--([a-zA-Z0-9-]+)\s*(?:,[^)]*)?\)/.exec(v);
  if (varm) { try { return resolveColor(map, varm[1]); } catch { return null; } }
  const hex = /#[0-9a-fA-F]{3,8}/.exec(v);
  if (hex) { try { return resolveColor(map, hex[0].slice(0, 7)); } catch { return hex[0].slice(0, 7); } }
  // bare token name
  try { return resolveColor(map, v.split(/\s+/)[0]); } catch { return null; }
}

/** Find the token NAME whose value equals a hex (for readable matrix labels). */
function nameForHex(map, hex) {
  const h = hex.toLowerCase();
  for (const [k, v] of Object.entries(map)) { try { if (toHex(parseHex(v)).toLowerCase() === h) return k; } catch {} }
  return hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Extraction — rules → fg/bg pairings (pure)
// ─────────────────────────────────────────────────────────────────────────────

const ROOT_SELECTORS = new Set([":root", "html", "body", "*", ":where(html)"]);

/** Is `anc` a structural ancestor of `sel` (prefix-of-compound heuristic)? */
function isAncestorSelector(anc, sel) {
  if (anc === sel) return false;
  // descendant combinator: ".card" ancestor of ".card .title", ".card>.title", ".card.x"
  return sel.startsWith(anc + " ") || sel.startsWith(anc + ">") || sel.startsWith(anc + " >") || sel.startsWith(anc + ":");
}

/**
 * Derive pairings from parsed rules + token map. Returns
 * { pairings:[{fg,bg,fgHex,bgHex,kind,source,confidence}], surfaces, foregrounds }.
 * Pure.
 */
export function extractPairings(rules, map, opts = {}) {
  // Per simple-selector record fg(s) and bg.
  const flat = [];
  for (const r of rules) {
    let bg = null;
    const fgs = [];
    for (const [prop, role] of Object.entries(COLOR_PROPS)) {
      if (!(prop in r.decls)) continue;
      const hex = resolveCssColor(r.decls[prop], map);
      if (!hex) continue;
      if (role === "bg") bg = hex;
      else fgs.push({ hex, kind: role === "ui" ? "ui" : "text", prop });
    }
    if (bg == null && fgs.length === 0) continue;
    for (const sel of r.selectors) flat.push({ sel, bg, fgs });
  }

  // Root surface background(s).
  const rootBgs = flat.filter((f) => f.bg && ROOT_SELECTORS.has(f.sel.split(/[ >:]/)[0]) ).map((f) => f.bg);
  const defaultSurface = rootBgs[0] || opts.defaultBackground || null;

  // Background-declaring selectors (surfaces) for containment lookup.
  const surfaces = flat.filter((f) => f.bg).map((f) => ({ sel: f.sel, bg: f.bg }));

  const pairings = [];
  const seen = new Set();
  const emit = (fgHex, bgHex, kind, source, confidence) => {
    if (!fgHex || !bgHex || fgHex.toLowerCase() === bgHex.toLowerCase()) return;
    const key = `${fgHex.toLowerCase()}|${bgHex.toLowerCase()}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairings.push({
      fg: nameForHex(map, fgHex), bg: nameForHex(map, bgHex),
      fgHex, bgHex, kind, source, confidence,
    });
  };

  for (const f of flat) {
    for (const fg of f.fgs) {
      if (f.bg) { emit(fg.hex, f.bg, fg.kind, f.sel, "rule"); continue; }
      // containment: nearest ancestor surface
      const anc = surfaces.filter((s) => isAncestorSelector(s.sel, f.sel));
      if (anc.length) for (const a of anc) emit(fg.hex, a.bg, fg.kind, `${f.sel} ⊂ ${a.sel}`, "surface");
      else if (defaultSurface) emit(fg.hex, defaultSurface, fg.kind, `${f.sel} ⊂ :root`, "root");
    }
  }
  return { pairings, surfaces, defaultSurface };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Matrix — evaluate every extracted pair, render Markdown (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Evaluate each pairing through the palette gate's per-pair check → matrix rows. */
export function buildMatrix(pairings) {
  return pairings.map((p) => {
    const ev = evaluatePair({ ...p, fgHex: p.fgHex, bgHex: p.bgHex });
    return {
      fg: p.fg, bg: p.bg, fgHex: p.fgHex, bgHex: p.bgHex, kind: p.kind,
      confidence: p.confidence, source: p.source,
      wcag: ev.wcag.ratio, wcagPass: ev.checks.wcagAA,
      apca: ev.apca ? ev.apca.absLc : null,
      cvd: Object.fromEntries(CVD_TYPES.map((c) => [c, ev.cvd[c].ratio])),
      cvdPass: ev.cvd.pass,
      passed: ev.passed,
    };
  });
}

/** Render the matrix as a Markdown table. Pure. */
export function renderMatrixMarkdown(matrix) {
  const head = `| fg | bg | kind | WCAG | APCA Lc | ${CVD_TYPES.map((c) => c.slice(0, 4)).join(" | ")} | pass | conf |`;
  const sep = `|${"---|".repeat(6 + CVD_TYPES.length)}`;
  const rows = matrix.map((m) =>
    `| ${m.fg} | ${m.bg} | ${m.kind} | ${m.wcag}:1 | ${m.apca ?? "—"} | ${CVD_TYPES.map((c) => m.cvd[c]).join(" | ")} | ${m.passed ? "✓" : "✗"} | ${m.confidence} |`);
  return [`# Pairing matrix (${matrix.length} extracted fg×bg combos)`, "", head, sep, ...rows, ""].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Full run
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a declared spec's pairings to {fg,bg,fgHex,bgHex,kind,name,key}. */
function resolveDeclared(map, spec) {
  const out = [];
  for (const d of spec.pairings || []) {
    try {
      const fgHex = resolveColor(map, d.fg), bgHex = resolveColor(map, d.bg), kind = d.kind || "text";
      const key = `${toHex(parseHex(fgHex)).toLowerCase()}|${toHex(parseHex(bgHex)).toLowerCase()}|${kind}`;
      out.push({ fg: d.fg, bg: d.bg, fgHex, bgHex, kind, name: d.name, key, source: "declared", confidence: "declared" });
    } catch { /* unresolvable token → skip */ }
  }
  return out;
}
const pairKey = (p) => `${toHex(parseHex(p.fgHex)).toLowerCase()}|${toHex(parseHex(p.bgHex)).toLowerCase()}|${p.kind}`;

/**
 * Load tokens + stylesheets → extract ∪ declared → matrix + palette evaluation.
 *
 * `allowlist:true` switches to CLOSED-WORLD: the `declared` set is the opt-in
 * allowlist and the gate enforces BOTH directions —
 *   1. every DECLARED pairing must pass contrast, and
 *   2. every pairing the CSS actually produces must be DECLARED; any extracted
 *      pairing absent from the allowlist is an `undeclared` violation.
 * The palette envelope is evaluated over the declared (vetted) set, so surface
 * mis-extractions can't poison it — they surface as `undeclared` to either
 * declare (and pass) or fix in the CSS.
 */
export async function runPairingExtractor({ tokens, css = [], declared = null, defaultBackground = null, allowlist = false }) {
  const map = typeof tokens === "string" ? await loadTokens(tokens) : tokens;
  const cssTexts = await Promise.all((Array.isArray(css) ? css : [css]).map((c) => (c.includes("{") ? c : readFile(c, "utf8"))));
  const rules = cssTexts.flatMap((t) => parseRules(t));
  const ext = extractPairings(rules, map, { defaultBackground });

  if (allowlist) {
    const spec = declared
      ? (typeof declared === "string" ? JSON.parse(await readFile(declared, "utf8")) : declared)
      : { pairings: [] };
    const declaredPairs = resolveDeclared(map, spec);
    const allowed = new Set(declaredPairs.map((p) => p.key));
    const undeclared = ext.pairings.filter((p) => !allowed.has(pairKey(p)));
    const matrix = buildMatrix(declaredPairs);
    const palette = evaluatePalette({ pairings: declaredPairs.map((p) => ({ ...p })) });
    const failingDeclared = matrix.filter((m) => !m.passed);
    return {
      passed: palette.passed && undeclared.length === 0,
      mode: "allowlist",
      summary: {
        declared: declaredPairs.length,
        extracted: ext.pairings.length,
        undeclared: undeclared.length,
        failingDeclared: failingDeclared.length,
        surfaces: ext.surfaces.length,
        total: declaredPairs.length,
        failing: failingDeclared.length + undeclared.length,
      },
      undeclared,
      defaultSurface: ext.defaultSurface,
      pairings: declaredPairs,
      matrix,
      palette,
    };
  }

  // Union declared pairings (resolved) in.
  const extractedCount = ext.pairings.length;
  let union = ext.pairings;
  if (declared) {
    const spec = typeof declared === "string" ? JSON.parse(await readFile(declared, "utf8")) : declared;
    const seen = new Set(union.map((p) => `${p.fgHex.toLowerCase()}|${p.bgHex.toLowerCase()}|${p.kind}`));
    for (const d of spec.pairings || []) {
      try {
        const fgHex = resolveColor(map, d.fg), bgHex = resolveColor(map, d.bg), kind = d.kind || "text";
        const key = `${toHex(parseHex(fgHex)).toLowerCase()}|${toHex(parseHex(bgHex)).toLowerCase()}|${kind}`;
        if (!seen.has(key)) { seen.add(key); union.push({ fg: d.fg, bg: d.bg, fgHex, bgHex, kind, source: "declared", confidence: "declared" }); }
      } catch {}
    }
  }

  const matrix = buildMatrix(union);
  const palette = evaluatePalette({ pairings: union.map((p) => ({ ...p })) });
  return {
    passed: palette.passed,
    summary: {
      extracted: extractedCount,
      declaredAdded: union.length - extractedCount,
      total: union.length,
      failing: matrix.filter((m) => !m.passed).length,
      surfaces: ext.surfaces.length,
    },
    defaultSurface: ext.defaultSurface,
    pairings: union,
    matrix,
    palette,
  };
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tokens = argv[0] || process.env.PAIRING_TOKENS;
  const css = argv.slice(1);
  if (!tokens || css.length === 0) {
    console.error("✗ pairing-extractor: usage: pairing-extractor.mjs <tokens.(json|css)> <style1.css> [style2.css …]");
    process.exit(2);
  }
  const allowlist = process.argv.includes("--allowlist") || process.env.PAIRING_ALLOWLIST === "1";
  const report = await runPairingExtractor({ tokens, css, declared: process.env.PAIRING_DECLARED || null, allowlist });
  if (process.env.PAIRING_REPORT) await writeFile(resolve(process.env.PAIRING_REPORT), JSON.stringify(report, null, 2) + "\n");

  const md = renderMatrixMarkdown(report.matrix);
  if (process.env.PAIRING_MATRIX) await writeFile(resolve(process.env.PAIRING_MATRIX), md + "\n");
  else console.log(md);

  const s = report.summary;
  if (allowlist) {
    // Closed-world: fail on undeclared OR failing declared pairings.
    const line = `pairing-extractor [allowlist]: ${s.declared} declared, ${s.undeclared} undeclared, ${s.failingDeclared} failing declared`;
    if (!report.passed) {
      console.error(`✗ ${line}`);
      for (const u of report.undeclared) console.error(`  · UNDECLARED: ${u.fg}/${u.bg} [${u.kind}] — declare it or fix the CSS`);
      for (const m of report.matrix) if (!m.passed) console.error(`  · FAILS: ${m.fg}/${m.bg} [${m.kind}] WCAG ${m.wcag}:1`);
      process.exit(1);
    }
    console.error(`✓ ${line}`);
    return;
  }
  const line = `pairing-extractor: ${s.total} pair(s) (${s.extracted} extracted + ${s.declaredAdded} declared) — ${s.failing} failing`;
  if (process.env.PAIRING_GATE === "1" && !report.passed) {
    console.error(`✗ ${line}`);
    for (const m of report.matrix) if (!m.passed) console.error(`  · ${m.fg}/${m.bg} [${m.kind}] WCAG ${m.wcag}:1`);
    process.exit(1);
  }
  console.error(`✓ ${line}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ pairing-extractor: error —", e.stack || e.message); process.exit(1); });
}
