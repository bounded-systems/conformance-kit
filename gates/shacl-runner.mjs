#!/usr/bin/env node
// SHACL runner — turns a site's emitted JSON-LD into an ENFORCEABLE contract.
//
//   node gates/shacl-runner.mjs <shapes.ttl> <htmlDir>       # built HTML (default)
//   node gates/shacl-runner.mjs <shapes.ttl> --turtle <file> # an RDF dataset
//   node gates/shacl-runner.mjs <shapes.ttl> --jsonld <file> # a JSON-LD document
//
// Schema.org alone is flexible guidance. Schema.org + SHACL is an enforceable
// contract: this runner extracts every JSON-LD block from the BUILT HTML under
// <htmlDir>, expands it to RDF, and validates it against the SHACL <shapes.ttl>. It
// FAILS (exit 1) unless the SHACL report says conforms: true — printing every
// violation.
//
// The shapes file is an INPUT and stays in the consuming site (each site's
// structured data differs); only the runner is shared. What it does NOT check
// (separate / manual): that the structured data matches the VISIBLE page content,
// and search-engine rich-result eligibility. SHACL is the enforceable STRUCTURAL
// contract.
//
// NOT EVERY ARTIFACT IS A WEBSITE
// ------------------------------
// The HTML path above assumes the thing under validation is a built site. A
// consumer whose artifact is a dataset — a database mirror, an export, a
// manifest — has no HTML, and emitting throwaway pages purely to carry JSON-LD
// past this front door would be fabricating an artifact to satisfy a signature.
// So `--turtle` / `--jsonld` take the dataset directly. Everything downstream is
// identical: same shapes, same validator, same report, same exit codes. Only
// where the quads come from differs.
//
// Site-agnostic injection:
//   argv[2]         path to the SHACL shapes Turtle file (required).
//   argv[3]         directory of built HTML to scan recursively, OR one of the
//                   dataset flags below (required).
//   --turtle <file> validate this Turtle file instead of scanning HTML.
//   --jsonld <file> validate this JSON-LD document instead of scanning HTML.
//   $SHACL_CONTEXT  optional path to a JSON-LD context document to use instead of
//                   the built-in offline schema.org context (for non-schema.org
//                   vocabularies). The gate NEVER fetches a context over the network.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import jsonld from "jsonld";
import { Parser as N3Parser } from "n3";
import rdf from "@zazuko/env-node"; // RDF/JS env with .dataset() + clownface
import { Validator as SHACLValidator } from "shacl-engine";
// SHACL-SPARQL support is OPT-IN and silently absent without these two options —
// see the constructor below. Importing them here so the coupling is visible.
import { targetResolvers, validations } from "shacl-engine/sparql.js";

const USAGE = "usage: shacl-runner <shapes.ttl> ( <htmlDir> | --turtle <file> | --jsonld <file> )";

const shapesPath = process.argv[2];
const target = process.argv[3];
if (!shapesPath || !target) {
  console.error(USAGE);
  process.exit(2);
}

// Exactly one input mode. A flag with no path is a usage error rather than a
// silent fallback to HTML scanning — a gate that quietly validates something
// other than what you named is worse than one that refuses.
const DATASET_FLAGS = { "--turtle": "turtle", "--jsonld": "jsonld" };
const mode = DATASET_FLAGS[target] ?? "html";
const inputPath = mode === "html" ? target : process.argv[4];
if (mode !== "html" && !inputPath) {
  console.error(`shacl-runner: ${target} needs a file path\n${USAGE}`);
  process.exit(2);
}
const SHAPES = resolve(shapesPath);
const DIST = resolve(inputPath);

// --- offline JSON-LD context ----------------------------------------------------
// Sites commonly emit `"@context": "https://schema.org"`. Expanding that normally
// dereferences the remote context over the network — non-deterministic and
// unavailable in hermetic CI. We serve a tiny local context instead: @vocab maps
// every type/property name to a stable https://schema.org/ IRI; a few URL-valued
// properties coerce to IRIs. A consumer with a different vocabulary points
// $SHACL_CONTEXT at its own context document.
const DEFAULT_SCHEMA_CONTEXT = {
  "@context": {
    "@vocab": "https://schema.org/",
    url: { "@type": "@id" },
    sameAs: { "@type": "@id" },
    mainEntityOfPage: { "@type": "@id" },
  },
};
const SCHEMA_IRIS = new Set([
  "https://schema.org", "https://schema.org/",
  "http://schema.org", "http://schema.org/",
]);
const localContext = process.env.SHACL_CONTEXT
  ? JSON.parse(await readFile(resolve(process.env.SHACL_CONTEXT), "utf8"))
  : DEFAULT_SCHEMA_CONTEXT;
const documentLoader = async (urlArg) => {
  if (SCHEMA_IRIS.has(urlArg) || process.env.SHACL_CONTEXT) {
    return { contextUrl: null, documentUrl: urlArg, document: localContext };
  }
  throw new Error(`shacl-runner: refusing network fetch for context <${urlArg}> (offline gate)`);
};

// --- extract JSON-LD blocks from built HTML -------------------------------------
const LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
function extractJsonLd(html) {
  const out = [];
  let m;
  while ((m = LD_RE.exec(html)) !== null) {
    // Many builders escape "<" as "<" before embedding; undo so JSON.parse sees valid text.
    const raw = m[1].replace(/\\u003c/g, "<").trim();
    if (raw) out.push(raw);
  }
  return out;
}

async function listHtmlFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await listHtmlFiles(abs));
    else if (e.name.endsWith(".html")) out.push(abs);
  }
  return out.sort();
}

// --- jsonld → rdf-ext dataset ---------------------------------------------------
async function jsonLdToDataset(doc) {
  const nquads = await jsonld.toRDF(doc, { format: "application/n-quads", documentLoader });
  const quads = new N3Parser({ format: "application/n-quads" }).parse(nquads);
  return rdf.dataset(quads);
}
async function turtleToDataset(ttl) {
  const quads = new N3Parser({ format: "text/turtle" }).parse(ttl);
  return rdf.dataset(quads);
}

/**
 * Render a result's property path.
 *
 * shacl-engine reports a path as an array of segments carrying `predicates`,
 * where rdf-validate-shacl reported a single term. Both are handled so the
 * printed line is unchanged by the engine swap — consumers read these logs.
 */
function pathLabel(path) {
  if (!path) return "(node)";
  if (path.value) return path.value;
  if (Array.isArray(path)) {
    const segs = path.map((s) => (s.predicates ?? []).map((t) => t.value).join("|")).filter(Boolean);
    if (segs.length) return segs.join("/");
  }
  return "(node)";
}

/** Print one violation per line, identically for whichever input produced it. */
function printViolations(report) {
  for (const r of report.results) {
    const focus = r.focusNode?.value ?? "(?)";
    const shape = r.shape?.ptr?.value ?? r.sourceShape?.value ?? "";
    const component = r.constraintComponent?.value ?? r.sourceConstraintComponent?.value;
    const msg = r.message?.map((m) => m.value).join("; ") || component || "violation";
    console.log(`      ✗ ${focus}  [${pathLabel(r.path)}]  ${msg}  <${shape}>`);
  }
}

/**
 * Validate a dataset given directly, rather than scraped out of built HTML.
 *
 * Same shapes, same validator, same exit codes — the only difference from the
 * HTML path is where the quads came from.
 */
async function validateDataset(validator) {
  const raw = await readFile(DIST, "utf8");
  const data = mode === "turtle" ? await turtleToDataset(raw) : await jsonLdToDataset(JSON.parse(raw));

  const report = await validator.validate({ dataset: data });
  const rel = inputPath;
  if (report.conforms) {
    console.log(`  ${rel}: ${data.size} quad(s) — conforms: true`);
    console.log("");
    console.log(`✓ shacl-runner: conforms: true — ${data.size} quad(s) satisfy the SHACL contract`);
    return;
  }
  console.log(`  ${rel}: ${data.size} quad(s) — conforms: FALSE`);
  printViolations(report);
  console.log("");
  console.error(`✗ shacl-runner: dataset does NOT conform to ${shapesPath}`);
  process.exit(1);
}

async function main() {
  if (!existsSync(SHAPES)) { console.error(`✗ shacl-runner: shapes file not found — ${SHAPES}`); process.exit(2); }
  if (!existsSync(DIST)) {
    const what = mode === "html" ? "html dir" : `${mode} file`;
    console.error(`✗ shacl-runner: ${what} not found — ${DIST}`);
    process.exit(2);
  }

  const shapesTtl = await readFile(SHAPES, "utf8");
  const shapes = await turtleToDataset(shapesTtl);
  // `targetResolvers` and `validations` enable SHACL-SPARQL. WITHOUT THEM the
  // engine does not warn and does not throw — it silently SKIPS every sh:sparql
  // shape and reports conforms: true. Measured on a graph whose only defect was
  // a dependency cycle: default config returned conforms:true, with the opt-in
  // it returned 4 results. fixtures/sparql.* + the required-to-fail test exist
  // to make dropping these two options impossible to do quietly.
  const validator = new SHACLValidator(shapes, { factory: rdf, targetResolvers, validations });

  if (mode !== "html") return validateDataset(validator);

  const files = await listHtmlFiles(DIST);
  let totalBlocks = 0;
  let failed = false;

  for (const file of files) {
    const rel = file.slice(DIST.length + 1);
    const blocks = extractJsonLd(await readFile(file, "utf8"));
    if (blocks.length === 0) {
      console.log(`  ${rel}: no JSON-LD (ok)`);
      continue;
    }
    totalBlocks += blocks.length;

    const data = rdf.dataset();
    for (const block of blocks) {
      const doc = JSON.parse(block);
      const ds = await jsonLdToDataset(doc);
      for (const q of ds) data.add(q);
    }

    const report = await validator.validate({ dataset: data });
    if (report.conforms) {
      console.log(`  ${rel}: ${blocks.length} block(s) — conforms: true`);
    } else {
      failed = true;
      console.log(`  ${rel}: ${blocks.length} block(s) — conforms: FALSE`);
      printViolations(report);
    }
  }

  console.log("");
  if (failed) {
    console.error(`✗ shacl-runner: JSON-LD does NOT conform to ${shapesPath}`);
    process.exit(1);
  }
  console.log(`✓ shacl-runner: conforms: true — ${totalBlocks} JSON-LD block(s) across ${files.length} page(s) satisfy the SHACL contract`);
}

main().catch((err) => {
  console.error("✗ shacl-runner: error —", err.message);
  process.exit(1);
});
