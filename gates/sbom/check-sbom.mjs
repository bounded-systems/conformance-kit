#!/usr/bin/env node
// check-sbom — the fail-closed completeness gate tying the SPDX SBOM to the
// flake.lock pinned set (+ an optional in-toto/SLSA statement). A violation refuses
// the build (process.exit(1)) rather than shipping an incomplete bill.
//
// It enforces three things over $DIST/sbom.spdx.json (+ flake.lock, + an optional
// $DIST/attestation.intoto.json), all decidable / order-free:
//   1. SPDX 2.3 well-formedness — the document + every package carry their required
//      fields (spdxVersion SPDX-2.3, SPDXID, dataLicense, namespace, creationInfo;
//      per package: name, SPDXID, downloadLocation).
//   2. Pinned-set ⊆ SBOM — every Nix flake input pinned in flake.lock appears as an
//      SPDX package at the SAME rev, and any package-reference (pkg:…) the
//      attestation enumerates as a resolvedDependency appears in the SBOM at the
//      SAME rev. (File-path materials are content inputs, not redistributable
//      packages, so they are intentionally out of SBOM scope.)
//   3. SBOM ⊆ pinned-set (vice-versa) — every Nix-sourced SPDX package (pkg:github)
//      traces back to a real flake.lock rev: no orphan Nix entries the build can't pin.
//
// Site-agnostic injection (all optional, neutral defaults):
//   $ROOT  repo root with flake.lock (default: cwd).
//   $DIST  dir holding the SBOM + optional attestation (default: $ROOT/dist).
//   $SBOM_OUT  SBOM filename under $DIST (default: "sbom.spdx.json").
import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

// $ROOT / $DIST may be absolute or relative-to-cwd (resolve handles both).
const root = resolve(process.cwd(), process.env.ROOT || ".");
const dist = process.env.DIST ? resolve(process.cwd(), process.env.DIST) : join(root, "dist");
const outName = process.env.SBOM_OUT || "sbom.spdx.json";

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

const errors = [];
const fail = (msg) => errors.push(msg);

const sbomPath = join(dist, outName);
const attPath = join(dist, "attestation.intoto.json");
if (!(await exists(sbomPath))) { console.error(`✗ check:sbom: ${outName} missing — run gen-sbom.mjs first`); process.exit(1); }

const sbom = await readJson(sbomPath);
const flakeLock = (await exists(join(root, "flake.lock"))) ? await readJson(join(root, "flake.lock")) : { nodes: {} };

// ---- 1. SPDX 2.3 well-formedness --------------------------------------------
if (sbom.spdxVersion !== "SPDX-2.3") fail(`spdxVersion is "${sbom.spdxVersion}", expected "SPDX-2.3"`);
if (sbom.SPDXID !== "SPDXRef-DOCUMENT") fail(`document SPDXID is "${sbom.SPDXID}", expected "SPDXRef-DOCUMENT"`);
if (!sbom.dataLicense) fail("document missing dataLicense");
if (!sbom.name) fail("document missing name");
if (!sbom.documentNamespace) fail("document missing documentNamespace");
if (!sbom.creationInfo?.created) fail("document missing creationInfo.created");
if (!Array.isArray(sbom.creationInfo?.creators) || sbom.creationInfo.creators.length === 0) fail("document missing creationInfo.creators");
if (!Array.isArray(sbom.packages) || sbom.packages.length === 0) fail("document has no packages");
const seenIds = new Set();
for (const p of sbom.packages || []) {
  const tag = p.name || p.SPDXID || "(unnamed)";
  if (!p.name) fail(`package ${tag} missing name`);
  if (!p.SPDXID) fail(`package ${tag} missing SPDXID`);
  if (!/^SPDXRef-[a-zA-Z0-9.-]+$/.test(p.SPDXID || "")) fail(`package ${tag} has malformed SPDXID "${p.SPDXID}"`);
  if (p.SPDXID && seenIds.has(p.SPDXID)) fail(`duplicate SPDXID ${p.SPDXID}`);
  seenIds.add(p.SPDXID);
  if (!p.downloadLocation) fail(`package ${tag} missing downloadLocation`);
}

// rev → package index (Nix packages record the locked commit as versionInfo)
const revToPkg = new Map();
const nixPkgs = [];
for (const p of sbom.packages || []) {
  const purl = (p.externalRefs || []).find((r) => r.referenceType === "purl")?.referenceLocator || "";
  if (purl.startsWith("pkg:github/")) {
    nixPkgs.push({ pkg: p, purl });
    if (p.versionInfo) revToPkg.set(p.versionInfo, p);
  }
}

// ---- 2. Pinned-set ⊆ SBOM ----------------------------------------------------
// 2a. every flake.lock input is in the SBOM at its locked rev
const flakeRevs = new Set();
for (const [nodeName, node] of Object.entries(flakeLock.nodes || {})) {
  if (nodeName === "root") continue;
  const rev = node.locked?.rev;
  if (!rev) continue;
  flakeRevs.add(rev);
  if (!revToPkg.has(rev)) fail(`flake.lock input "${nodeName}" (rev ${rev.slice(0, 12)}…) is not an SPDX package`);
}

// 2b. every package-reference material in the attestation is in the SBOM
if (await exists(attPath)) {
  const att = await readJson(attPath);
  const deps = att.predicate?.buildDefinition?.resolvedDependencies || [];
  for (const d of deps) {
    const isPkgRef = (typeof d.uri === "string" && d.uri.startsWith("pkg:")) || d.digest?.gitCommit;
    if (!isPkgRef) continue; // file-path / source materials are out of SBOM scope
    const rev = d.digest?.gitCommit;
    if (rev && !revToPkg.has(rev)) fail(`attestation material "${d.uri}" (gitCommit ${rev.slice(0, 12)}…) is not an SPDX package`);
    if (!rev) fail(`attestation package-ref "${d.uri}" has no gitCommit to reconcile against the SBOM`);
  }
} else {
  console.warn("… check:sbom: attestation.intoto.json not present — skipping attestation cross-check (run the full build to enforce it)");
}

// ---- 3. SBOM ⊆ pinned-set (vice-versa) --------------------------------------
for (const { pkg, purl } of nixPkgs) {
  if (!pkg.versionInfo || !flakeRevs.has(pkg.versionInfo))
    fail(`Nix-sourced SPDX package "${pkg.name}" (${purl}) has no matching flake.lock rev — orphan entry`);
}

if (errors.length) {
  console.error(`✗ check:sbom: ${errors.length} completeness violation(s) — refusing to ship an incomplete SBOM:`);
  for (const e of errors) console.error(`    ${e}`);
  process.exit(1);
}
console.log(`✓ check:sbom: SPDX-2.3 well-formed · ${sbom.packages.length} packages · pinned set (${flakeRevs.size} flake inputs) ⊆ SBOM ⊆ pinned set.`);
