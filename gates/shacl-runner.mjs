#!/usr/bin/env node
// SHACL runner — turns a site's emitted JSON-LD into an ENFORCEABLE contract.
//
//   node gates/shacl-runner.mjs <shapes.ttl> <htmlDir>
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
// Site-agnostic injection:
//   argv[2]         path to the SHACL shapes Turtle file (required).
//   argv[3]         directory of built HTML to scan recursively (required).
//   $SHACL_CONTEXT  optional path to a JSON-LD context document to use instead of
//                   the built-in offline schema.org context (for non-schema.org
//                   vocabularies). The gate NEVER fetches a context over the network.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import jsonld from "jsonld";
import { Parser as N3Parser } from "n3";
import rdf from "@zazuko/env-node"; // RDF/JS env with .dataset() + clownface (required by rdf-validate-shacl)
import SHACLValidator from "rdf-validate-shacl";

const shapesPath = process.argv[2];
const htmlDir = process.argv[3];
if (!shapesPath || !htmlDir) {
  console.error("usage: shacl-runner <shapes.ttl> <htmlDir>");
  process.exit(2);
}
const SHAPES = resolve(shapesPath);
const DIST = resolve(htmlDir);

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

async function main() {
  if (!existsSync(SHAPES)) { console.error(`✗ shacl-runner: shapes file not found — ${SHAPES}`); process.exit(2); }
  if (!existsSync(DIST)) { console.error(`✗ shacl-runner: html dir not found — ${DIST}`); process.exit(2); }

  const shapesTtl = await readFile(SHAPES, "utf8");
  const shapes = await turtleToDataset(shapesTtl);
  const validator = new SHACLValidator(shapes, { factory: rdf });

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

    const report = validator.validate(data);
    if (report.conforms) {
      console.log(`  ${rel}: ${blocks.length} block(s) — conforms: true`);
    } else {
      failed = true;
      console.log(`  ${rel}: ${blocks.length} block(s) — conforms: FALSE`);
      for (const r of report.results) {
        const path = r.path?.value ?? "(node)";
        const focus = r.focusNode?.value ?? "(?)";
        const shape = r.sourceShape?.value ?? "";
        const msg = r.message?.map((m) => m.value).join("; ") || r.sourceConstraintComponent?.value || "violation";
        console.log(`      ✗ ${focus}  [${path}]  ${msg}  <${shape}>`);
      }
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
