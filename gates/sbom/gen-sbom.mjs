#!/usr/bin/env node
// gen-sbom — emit a deterministic SPDX 2.3 SBOM for the WHOLE supply chain a build
// pulls from: the npm lockfiles + (optionally) the Nix flake.lock inputs.
//
// It reads the committed lockfiles (the single source of truth) and emits one
// SPDX-2.3 JSON. Each package carries a versionInfo, a downloadLocation, and a
// checksum + purl externalRef:
//   • npm packages  — from package-lock.json (+ any extra lockfiles); integrity hash
//                     (base64 SRI) decoded to a hex SPDX checksum, downloadLocation =
//                     the resolved registry tarball.
//   • Nix inputs    — from flake.lock (if present); narHash (sha256 SRI) decoded to a
//                     hex SPDX SHA256 checksum, rev pinned via a pkg:github purl + a
//                     git+https downloadLocation.
//
// Pure + deterministic: a function of the lockfiles only (no network, no clock — the
// creation timestamp is derived from flake.lock's newest lastModified when present,
// else epoch 0; output is sorted; the namespace is content-derived). Zero deps.
//
// Site-agnostic injection (all optional, neutral defaults):
//   $ROOT                 repo root containing the lockfiles (default: cwd).
//   $DIST                 output dir (default: $ROOT/dist).
//   $SBOM_LOCKFILES       comma list of npm lockfile paths, relative to $ROOT
//                         (default: "package-lock.json").
//   $SBOM_NAME            SPDX document name (default: "<basename(ROOT)>-sbom").
//   $SBOM_NAMESPACE_BASE  documentNamespace prefix; the content fingerprint is
//                         appended (default: "https://spdx.invalid/sbom").
//   $SBOM_CREATORS        comma list of SPDX creators
//                         (default: "Tool: gen-sbom.mjs").
//   $SBOM_OUT             output filename under $DIST (default: "sbom.spdx.json").
import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename, resolve } from "node:path";

// $ROOT / $DIST may be absolute or relative-to-cwd (resolve handles both).
const root = resolve(process.cwd(), process.env.ROOT || ".");
const dist = process.env.DIST ? resolve(process.cwd(), process.env.DIST) : join(root, "dist");
const lockfiles = (process.env.SBOM_LOCKFILES || "package-lock.json").split(",").map((s) => s.trim()).filter(Boolean);
const docName = process.env.SBOM_NAME || `${basename(root)}-sbom`;
const nsBase = (process.env.SBOM_NAMESPACE_BASE || "https://spdx.invalid/sbom").replace(/\/$/, "");
const creators = (process.env.SBOM_CREATORS || "Tool: gen-sbom.mjs").split(",").map((s) => s.trim()).filter(Boolean);
const outName = process.env.SBOM_OUT || "sbom.spdx.json";

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

// SPDXID must be [a-zA-Z0-9.-]; map everything else to '-' so @scope/name@1.2.3
// becomes a legal, collision-resistant element id.
const spdxId = (s) => "SPDXRef-Package-" + s.replace(/[^a-zA-Z0-9.-]/g, "-");
const SRI_ALG = { sha512: "SHA512", sha384: "SHA384", sha256: "SHA256", sha1: "SHA1" };
// Decode an SRI hash (alg-<base64>) → { algorithm, checksumValue } in lowercase hex,
// the only checksum form SPDX accepts. Returns null for anything unrecognised.
const sriToChecksum = (sri) => {
  if (typeof sri !== "string" || !sri.includes("-")) return null;
  const [alg, b64] = [sri.slice(0, sri.indexOf("-")), sri.slice(sri.indexOf("-") + 1)];
  const algorithm = SRI_ALG[alg];
  if (!algorithm || !b64) return null;
  return { algorithm, checksumValue: Buffer.from(b64, "base64").toString("hex") };
};

// Collect every resolved npm package across the given lockfiles, keyed name@version
// (deduped). lockfileVersion 3: packages[<path>] with version/resolved/integrity.
async function collectNpm(lockPaths) {
  const pkgs = new Map();
  for (const lp of lockPaths) {
    if (!(await exists(join(root, lp)))) continue;
    const lock = await readJson(join(root, lp));
    for (const [key, p] of Object.entries(lock.packages || {})) {
      if (!key.startsWith("node_modules/")) continue;   // skip the project root ("")
      if (!p.version || !p.resolved) continue;          // skip links/workspaces
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      const id = `${name}@${p.version}`;
      if (pkgs.has(id)) continue;
      pkgs.set(id, {
        kind: "npm",
        name,
        versionInfo: p.version,
        downloadLocation: p.resolved,
        purl: `pkg:npm/${name}@${p.version}`,
        checksum: sriToChecksum(p.integrity),
        license: typeof p.license === "string" ? p.license : null,
      });
    }
  }
  return [...pkgs.values()];
}

// Collect the Nix flake inputs. Each is pinned by a commit rev + narHash; narHash is
// an sha256 SRI we decode to a hex SPDX checksum.
function collectNix(flakeLock) {
  const out = [];
  for (const [nodeName, node] of Object.entries(flakeLock.nodes || {})) {
    if (nodeName === "root") continue;
    const lk = node.locked;
    if (!lk || !lk.rev) continue;
    const name = lk.repo ? `${lk.owner}/${lk.repo}` : nodeName;
    const downloadLocation = lk.type === "github"
      ? `git+https://github.com/${lk.owner}/${lk.repo}@${lk.rev}`
      : `git+https://${lk.owner || ""}/${lk.repo || nodeName}@${lk.rev}`;
    out.push({
      kind: "nix",
      node: nodeName,
      name,
      versionInfo: lk.rev,
      downloadLocation,
      purl: `pkg:github/${lk.owner}/${lk.repo}@${lk.rev}`,
      checksum: sriToChecksum(lk.narHash),
      rev: lk.rev,
      lastModified: lk.lastModified || 0,
      license: null,
    });
  }
  return out;
}

const flakeLock = (await exists(join(root, "flake.lock"))) ? await readJson(join(root, "flake.lock")) : { nodes: {} };
const npm = await collectNpm(lockfiles);
const nix = collectNix(flakeLock);

// Deterministic order: kind (nix before npm) then name then version.
const all = [...nix, ...npm].sort((a, b) =>
  (a.kind === b.kind ? 0 : a.kind === "nix" ? -1 : 1) ||
  a.name.localeCompare(b.name) || a.versionInfo.localeCompare(b.versionInfo));

const packages = all.map((p) => {
  const externalRefs = [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: p.purl }];
  return {
    name: p.name,
    SPDXID: spdxId(`${p.name}@${p.versionInfo}`),
    versionInfo: p.versionInfo,
    downloadLocation: p.downloadLocation,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: p.license || "NOASSERTION",
    copyrightText: "NOASSERTION",
    ...(p.checksum ? { checksums: [p.checksum] } : {}),
    externalRefs,
  };
});

// Deterministic, content-derived bits: no wall clock. The creation date is the
// newest flake.lock lastModified (a pure function of the pinned inputs; epoch 0 when
// no flake); the namespace is a digest of the package set so identical lockfiles →
// identical document, byte-for-byte.
const newest = Math.max(0, ...nix.map((p) => p.lastModified));
const created = new Date(newest * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const fingerprint = createHash("sha256").update(JSON.stringify(packages)).digest("hex");

const doc = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: docName,
  documentNamespace: `${nsBase}/${fingerprint}`,
  creationInfo: {
    created,
    creators,
  },
  packages,
  relationships: packages.map((p) => ({
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: p.SPDXID,
  })),
};

await writeFile(join(dist, outName), JSON.stringify(doc, null, 2) + "\n");
console.log(`✓ SBOM: ${packages.length} packages (${nix.length} Nix + ${npm.length} npm) → ${process.env.DIST || "dist"}/${outName} (SPDX-2.3)`);
