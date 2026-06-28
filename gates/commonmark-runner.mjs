#!/usr/bin/env node
// CommonMark assertion runner — pins a site's markdown renderer so its
// markdown→HTML behaviour can't silently drift, and proves it never emits unsafe
// raw HTML.
//
//   node gates/commonmark-runner.mjs <renderer.mjs> [fixtures.json]
//
// The RENDERER IS AN INPUT: a site supplies the module exporting its markdown→HTML
// function (the export name defaults to `renderMarkdown`, override with
// $COMMONMARK_RENDER_EXPORT). The runner does two things:
//   1. CONFORMANCE — for the constructs the renderer supports, assert it produces
//      the expected HTML. Drift from these snapshots fails the build.
//   2. SAFETY — feed it hostile raw HTML and assert every tag is ESCAPED, never
//      passed through (the safe deviation from CommonMark, which passes HTML blocks).
//
// The fixtures default to a small, safe CommonMark SUBSET (headings, emphasis, code
// spans, links, tight bullet lists, HTML-escaping; hr as HTML5 void <hr>;
// single-block blockquote without inner <p>). A site whose renderer differs supplies
// its own fixtures JSON: { "conformance": {md: html}, "subset": {md: html},
// "hostile": [md], "allowedTags": [tag], "dangerous": "regex-source" }.
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const rendererPath = process.argv[2] || process.env.COMMONMARK_RENDERER;
const fixturesPath = process.argv[3] || process.env.COMMONMARK_FIXTURES;
const exportName = process.env.COMMONMARK_RENDER_EXPORT || "renderMarkdown";
if (!rendererPath) { console.error("usage: commonmark-runner <renderer.mjs> [fixtures.json]"); process.exit(2); }

const abs = isAbsolute(rendererPath) ? rendererPath : resolve(rendererPath);
const mod = await import(pathToFileURL(abs).href);
const renderMarkdown = mod[exportName] || mod.default;
if (typeof renderMarkdown !== "function") {
  console.error(`✗ commonmark-runner: ${rendererPath} has no "${exportName}" (or default) function export`);
  process.exit(2);
}

// ---- default fixtures: a safe CommonMark subset ---------------------------------
const DEFAULTS = {
  conformance: {
    "## A heading": "<h2>A heading</h2>",
    "### Sub heading": "<h3>Sub heading</h3>",
    "This is *italic* and **bold** text.": "<p>This is <em>italic</em> and <strong>bold</strong> text.</p>",
    "Use the `build.mjs` file.": "<p>Use the <code>build.mjs</code> file.</p>",
    "See [the site](https://example.com).": '<p>See <a href="https://example.com">the site</a>.</p>',
    "- one\n- two\n- three": "<ul><li>one</li><li>two</li><li>three</li></ul>",
    "* a\n* b": "<ul><li>a</li><li>b</li></ul>",
    "Just a plain paragraph\nwith a soft break.": "<p>Just a plain paragraph with a soft break.</p>",
    "Tom & Jerry < > test.": "<p>Tom &amp; Jerry &lt; &gt; test.</p>",
  },
  subset: {
    "---": "<hr>",
    "> quoted line\n> second line": "<blockquote>quoted line second line</blockquote>",
  },
  hostile: [
    '<div onclick="x">hi</div> and <script>alert(1)</script>',
    "An <img src=x onerror=alert(1)> inline.",
    "<a href=javascript:alert(1)>x</a>",
    "<iframe src=//evil></iframe>",
  ],
  allowedTags: ["p", "h2", "h3", "ul", "li", "blockquote", "hr", "code", "a", "strong", "em"],
  dangerous: "\\b(onclick|onerror|onload)\\b|javascript:",
};

const fx = fixturesPath
  ? { ...DEFAULTS, ...JSON.parse(await readFile(resolve(fixturesPath), "utf8")) }
  : DEFAULTS;

const CONFORMANCE = fx.conformance;
const SUBSET = fx.subset || {};
const HOSTILE = fx.hostile || [];
const ALLOWED_TAGS = new Set(fx.allowedTags || []);
const DANGEROUS = new RegExp(fx.dangerous || DEFAULTS.dangerous, "i");

let fails = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); fails++; };

// ---- 1. CONFORMANCE snapshots: input → exact expected HTML ----------------------
for (const [md, want] of [...Object.entries(CONFORMANCE), ...Object.entries(SUBSET)]) {
  const got = renderMarkdown(md);
  if (got !== want) fail(`snapshot drift for ${JSON.stringify(md)}\n      want: ${want}\n      got:  ${got}`);
}

// ---- 2. SAFETY: raw HTML must be escaped, never passed through ------------------
for (const md of HOSTILE) {
  const out = renderMarkdown(md);
  for (const t of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b/g)) {
    if (!ALLOWED_TAGS.has(t[1].toLowerCase())) fail(`unsafe raw HTML leaked through renderer: <${t[1]}> from ${JSON.stringify(md)}`);
  }
  if (DANGEROUS.test(out) && !/&lt;/.test(out)) fail(`dangerous attribute/URL not neutralised: ${JSON.stringify(md)} → ${out}`);
}

console.log("");
if (fails) {
  console.error(`✗ commonmark-runner: ${fails} failure(s) — the renderer drifted or leaked raw HTML.`);
  process.exit(1);
}
console.log(`✓ commonmark-runner: pinned ${Object.keys(CONFORMANCE).length} CommonMark + ${Object.keys(SUBSET).length} subset construct(s); ${HOSTILE.length} hostile input(s) fully escaped.`);
