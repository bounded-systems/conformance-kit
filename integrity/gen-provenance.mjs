#!/usr/bin/env node
// integrity · gen-provenance — emit $DIST/provenance.json (+ the /rekor sidecar)
// for the ENTIRE site. Run at deploy time, after the keyless signing steps, with
// the GitHub Actions OIDC env in scope.
//
//   node integrity/gen-provenance.mjs
//
// Keyless attestations (GitHub Actions OIDC → Fulcio → Rekor, no stored key):
//   1. site manifest     — cosign sign-blob over $DIST/site.sha256 (the whole
//      served site). Verify the live bytes in place.
//   2. in-toto statement — cosign sign-blob over $DIST/attestation.intoto.json
//      (the SLSA predicate), IF present (some sites emit one, some don't).
//   3. OCI artifact      — the built site pushed to GHCR + cosign-signed by digest.
// Proves WHO built the site and that it is intact — not that the build was safe or
// authorized. The signatures + Rekor entries are ground truth; this file is a
// convenience view, and the `verify` recipes confirm it independently.
//
// Site-agnostic: every site value comes from the GitHub Actions env (GITHUB_*),
// the OCI_* env, $PROVENANCE_DOC_URL (the caveat link), and $DIST. The emitted
// builder.repository becomes the identity verify-site.mjs / verify.mjs enforce —
// nothing is hardcoded.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// $DIST may be absolute or relative-to-cwd (resolve handles both); default ./dist.
const dist = resolve(process.cwd(), process.env.DIST || "dist");
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const repo = process.env.GITHUB_REPOSITORY || "";
const sha = process.env.GITHUB_SHA || "";
const ref = process.env.GITHUB_REF || "";
const runId = process.env.GITHUB_RUN_ID || "";
const workflowRef = process.env.GITHUB_WORKFLOW_REF || "";
const ociRef = process.env.OCI_REF || "";
const ociDigest = process.env.OCI_DIGEST || "";
const docUrl = process.env.PROVENANCE_DOC_URL || "";

const idFlags =
  `  --certificate-identity-regexp '^https://github.com/${repo}/' \\\n` +
  `  --certificate-oidc-issuer https://token.actions.githubusercontent.com`;

async function rekorIndex(bundleName) {
  const p = join(dist, bundleName);
  if (!(await exists(p))) return null;
  try {
    const b = JSON.parse(await readFile(p, "utf8"));
    const e = b?.verificationMaterial?.tlogEntries?.[0];
    return e?.logIndex != null ? String(e.logIndex) : null;
  } catch { return null; }
}

const manifestBytes = await readFile(join(dist, "site.sha256"));
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const fileCount = manifestBytes.toString("utf8").trim().split("\n").filter(Boolean).length;
const manifestIdx = await rekorIndex("site.sha256.sigstore.json");
const attIdx = await rekorIndex("attestation.intoto.json.sigstore.json");

const provenance = {
  scope: "entire-site",
  fileCount,
  // Machine-readable freshness. The authoritative timestamp is the Rekor entry's
  // integratedTime (one click away at /rekor) — this is when the build that
  // produced these bytes ran, surfaced so a verifier can report build age.
  builtAt: new Date().toISOString(),
  builder: {
    repository: repo,
    commit: sha,
    ref,
    runId,
    workflowRef,
    issuer: "https://token.actions.githubusercontent.com",
  },
  siteManifest: {
    file: "site.sha256",
    sha256: manifestSha256,
    bundle: "site.sha256.sigstore.json",
    transparencyLog: "rekor.sigstore.dev",
    rekorLogIndex: manifestIdx,
    rekorEntry: manifestIdx ? `https://search.sigstore.dev/?logIndex=${manifestIdx}` : null,
    verify:
      `cosign verify-blob \\\n  --bundle site.sha256.sigstore.json \\\n${idFlags} \\\n  site.sha256\n` +
      `# then check the live bytes against the signed manifest:\nsha256sum -c site.sha256`,
  },
  intotoStatement: (await exists(join(dist, "attestation.intoto.json")))
    ? {
        file: "attestation.intoto.json",
        bundle: "attestation.intoto.json.sigstore.json",
        predicateType: "https://slsa.dev/provenance/v1",
        rekorLogIndex: attIdx,
        rekorEntry: attIdx ? `https://search.sigstore.dev/?logIndex=${attIdx}` : null,
        verify: `cosign verify-blob \\\n  --bundle attestation.intoto.json.sigstore.json \\\n${idFlags} \\\n  attestation.intoto.json`,
      }
    : null,
  ociArtifact: ociRef
    ? {
        registry: "ghcr.io",
        ref: ociRef,
        digest: ociDigest || null,
        pull: `oras pull ${ociRef}`,
        verify: `cosign verify ${ociDigest ? ociRef.split(":")[0] + "@" + ociDigest : ociRef} \\\n${idFlags}`,
      }
    : null,
  caveat:
    "Provenance proves who built this site and that it is intact — not that the build was safe or authorized. Identity and integrity, not legitimacy." +
    (docUrl ? ` ${docUrl}` : ""),
};

await writeFile(join(dist, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

// /rekor — a stable, one-click redirect to THIS build's real Rekor entry (the
// whole-site manifest signature). The signed HTML can't bake the per-version
// logIndex without circularity, so this unsigned sidecar carries it (excluded
// from site.sha256). The target is the real search.sigstore.dev entry showing the
// cert identity + digest — a wrong index wouldn't match, so it degrades detectably.
if (manifestIdx) {
  const rekorUrl = `https://search.sigstore.dev/?logIndex=${manifestIdx}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${rekorUrl}">
<title>This build's Rekor entry</title>
<script>location.replace(${JSON.stringify(rekorUrl)})</script>
</head>
<body style="font-family:system-ui,sans-serif;margin:2rem;line-height:1.5;">
<p>Redirecting to this build's entry in the public Rekor transparency log…</p>
<p><a href="${rekorUrl}">${rekorUrl}</a></p>
</body>
</html>
`;
  await mkdir(join(dist, "rekor"), { recursive: true });
  await writeFile(join(dist, "rekor", "index.html"), html);
}

console.log(`✓ provenance: entire site (${fileCount} files) · manifest sha256:${manifestSha256.slice(0, 12)}… · rekor#${manifestIdx ?? "?"}${manifestIdx ? " · /rekor → entry" : ""}${ociRef ? ` · oci ${ociRef}` : ""} → provenance.json`);
