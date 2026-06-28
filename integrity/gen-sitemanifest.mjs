#!/usr/bin/env node
// integrity · gen-sitemanifest — content-address the ENTIRE built site.
//
// Walk $DIST (default ./dist relative to the working directory) and emit
// `$DIST/site.sha256`: one `sha256␠␠relpath` line per served file, sorted, in the
// exact format `sha256sum -c` accepts. This single file is the whole-site digest
// the deploy keyless-signs (cosign sign-blob), so provenance covers every asset.
// A visitor verifies the signature on this manifest, then checks the live bytes.
//
//   node integrity/gen-sitemanifest.mjs            # uses ./dist
//   DIST=out node integrity/gen-sitemanifest.mjs
//   MANIFEST_EXCLUDE=_worker.js,_extra node integrity/gen-sitemanifest.mjs
//
// Site-agnostic: dist resolved from cwd (not the file's location), so it runs
// identically whether invoked in-repo or vendored. The provenance sidecars are
// excluded — they describe the site, they are not the site, and the manifest can't
// hash its own signature. EXCLUDE is a superset of both reference sites' sidecars
// (a name that doesn't exist in a given site is simply never matched); a consumer
// adds platform control files of its own via $MANIFEST_EXCLUDE (comma-separated).
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

// $DIST may be absolute or relative-to-cwd (resolve handles both); default ./dist.
const dist = resolve(process.cwd(), process.env.DIST || "dist");

const EXCLUDE = new Set([
  "site.sha256",
  "site.sha256.sigstore.json",
  "provenance.json",
  "rekor/index.html",
  "attestation.intoto.json",
  "attestation.intoto.json.sigstore.json",
  // Platform control files: consumed by the host (e.g. Cloudflare Pages), never
  // served as content — so they don't belong in a manifest of SERVED bytes (a
  // verifier re-hashing the live site 404s on them). Still covered by the OCI
  // artifact signature, which packs the whole dist.
  "_headers",
  "_redirects",
  "_routes.json",
  ...(process.env.MANIFEST_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(dist, abs);
    if (ent.isDirectory()) { out.push(...await walk(abs)); continue; }
    if (EXCLUDE.has(rel)) continue;
    out.push(rel);
  }
  return out;
}

const files = (await walk(dist)).sort();
const lines = [];
for (const rel of files) {
  const sha256 = createHash("sha256").update(await readFile(join(dist, rel))).digest("hex");
  lines.push(`${sha256}  ${rel}`);
}
const manifest = lines.join("\n") + "\n";
await writeFile(join(dist, "site.sha256"), manifest);

const siteDigest = createHash("sha256").update(manifest).digest("hex");
console.log(`✓ site manifest: ${files.length} files → ${process.env.DIST || "dist"}/site.sha256 (site digest sha256:${siteDigest.slice(0, 12)}…)`);
