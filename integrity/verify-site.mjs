#!/usr/bin/env node
// integrity · verify-site — independently verify a deployed site against its own
// signed, whole-site provenance. The honest counterpart to the in-page badge:
// run this from OUTSIDE the page (your shell, CI, an extension) so trust doesn't
// come from anything the page itself computes.
//
//   node integrity/verify-site.mjs https://bounded.tools
//   node integrity/verify-site.mjs ./dist            # a local build dir
//
// What it does:
//   1. loads /provenance.json (identity, Rekor index, OCI ref)
//   2. loads /site.sha256 + /site.sha256.sigstore.json (the signed manifest)
//   3. if `cosign` is on PATH: `cosign verify-blob` the manifest against the
//      builder's OIDC identity + Rekor (the real cryptographic check). Otherwise
//      prints the exact recipe and marks the signature step SKIPPED.
//   4. re-hashes every file the manifest lists (fetched live, or read locally) and
//      checks it byte-for-byte — integrity of the actual served bytes. In live-URL
//      mode it tolerates ONE known, benign CDN transform (Cloudflare's JS-detection
//      beacon injected into HTML): if stripping it makes the file match, that's a
//      pass-with-note, since the signed body is intact and only the edge added a
//      named script. The edge-independent ground truth is the signed OCI artifact.
// Exit 0 iff every checked file matches (directly or after a known edge strip) AND
// (cosign verified OR was skipped with a printed recipe). Exit 1 on any real
// mismatch or a failed cosign verify.
//
// Dependency-free: node:crypto + fetch + cosign (optional, shelled out). Designed
// to later publish to npm with Sigstore provenance and be consumed by a CLI, a
// browser extension, or CI policy.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: verify-site <https://site | ./dist>");
  process.exit(2);
}
const isUrl = /^https?:\/\//.test(target);
const base = isUrl ? target.replace(/\/$/, "") : target;
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

async function load(path) {
  if (isUrl) {
    const res = await fetch(`${base}/${path}`);
    if (!res.ok) throw new Error(`GET /${path} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(join(base, path));
}

let failures = 0;
const log = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) failures++; };

// 1 + 2: provenance + signed manifest
const provenance = JSON.parse((await load("provenance.json")).toString("utf8"));
const repo = provenance?.builder?.repository || "";
const manifest = (await load("site.sha256")).toString("utf8");
const bundle = (await load("site.sha256.sigstore.json")).toString("utf8");
console.log(`· site: ${base}`);
console.log(`· builder: ${repo} @ ${(provenance?.builder?.commit || "").slice(0, 7)} · rekor#${provenance?.siteManifest?.rekorLogIndex ?? "?"}`);
if (provenance?.builtAt) {
  const ms = Date.now() - Date.parse(provenance.builtAt);
  const age = Number.isFinite(ms)
    ? (ms < 36e5 ? `${Math.round(ms / 6e4)}m` : ms < 864e5 ? `${Math.round(ms / 36e5)}h` : `${Math.round(ms / 864e5)}d`)
    : "?";
  console.log(`· built: ${provenance.builtAt} (${age} ago) — authoritative time is the Rekor entry's integratedTime at /rekor`);
}

// 3: signature (cosign if available)
const cosign = spawnSync("cosign", ["version"], { stdio: "ignore" });
if (cosign.status === 0) {
  const dir = await mkdtemp(join(tmpdir(), "verify-site-"));
  await writeFile(join(dir, "site.sha256"), manifest);
  await writeFile(join(dir, "site.sha256.sigstore.json"), bundle);
  const r = spawnSync("cosign", [
    "verify-blob",
    "--bundle", join(dir, "site.sha256.sigstore.json"),
    "--certificate-identity-regexp", `^https://github.com/${repo}/`,
    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
    join(dir, "site.sha256"),
  ], { encoding: "utf8" });
  log(r.status === 0, `cosign verify-blob (identity ^github.com/${repo}/ + Rekor)`);
  if (r.status !== 0) console.error((r.stderr || "").trim());
} else {
  console.log("· cosign not found — signature check SKIPPED. Verify it out-of-band:");
  console.log(`    ${(provenance?.siteManifest?.verify || "").split("\n").join("\n    ")}`);
}

// 4: byte-for-byte integrity of every listed file.
//
// Honesty caveat for live-URL mode: a CDN may inject markup into HTML responses,
// so served HTML can differ from the signed bytes on a perfectly legitimate deploy.
// Cloudflare's "JavaScript Detections" adds a bot beacon (`__CF$cv$params` /
// `cdn-cgi/challenge-platform`) before </body>. We detect that ONE known, benign
// transform, strip it, and re-hash: if it then matches, the signed body is intact
// and only the edge added a named script — reported as a PASS WITH NOTE, not a
// silent pass and not a false alarm. Anything else is a real mismatch. The
// edge-independent ground truth is the signed OCI artifact (see provenance.json
// `ociArtifact.verify`), which no CDN sits in front of.
const KNOWN_EDGE_INJECTIONS = [
  {
    // Cloudflare "JavaScript Detections": one <script> naming the challenge beacon,
    // injected before </body> on HTML responses.
    name: "cloudflare-js-detections",
    applies: (p) => /\.html$/.test(p),
    re: /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?(?:__CF\$cv\$params|cdn-cgi\/challenge-platform)(?:(?!<\/script>)[\s\S])*?<\/script>/g,
  },
  {
    // Cloudflare "Managed robots.txt" / AI-crawler control: a managed block prepended
    // to robots.txt; our signed file survives intact as the tail after the END marker.
    name: "cloudflare-managed-robots",
    applies: (p) => /(^|\/)robots\.txt$/.test(p),
    re: /^[\s\S]*?# END Cloudflare Managed Content\n+/,
  },
];
const stripKnownEdge = (buf, path) => {
  let s = buf.toString("utf8");
  const hit = [];
  for (const rule of KNOWN_EDGE_INJECTIONS) {
    if (!rule.applies(path)) continue;
    const next = s.replace(rule.re, "");
    if (next !== s) { hit.push(rule.name); s = next; }
  }
  return { stripped: Buffer.from(s, "utf8"), hit };
};

const entries = manifest.trim().split("\n").filter(Boolean).map((l) => {
  const [hash, ...rest] = l.split("  ");
  return { hash, path: rest.join("  ") };
});
let mismatches = 0;
let edgeAdjusted = 0;
const edgeNames = new Set();
for (const { hash, path } of entries) {
  try {
    const bytes = await load(path);
    if (sha256hex(bytes) === hash) continue;
    // mismatch — in live mode, try removing known, named edge injections before failing
    if (isUrl) {
      const { stripped, hit } = stripKnownEdge(bytes, path);
      if (hit.length && sha256hex(stripped) === hash) {
        edgeAdjusted++; hit.forEach((n) => edgeNames.add(n));
        console.log(`  ~ ${path}: matches after removing edge injection (${hit.join(", ")})`);
        continue;
      }
    }
    mismatches++;
    console.log(`  ✗ ${path}: ${sha256hex(bytes).slice(0, 12)}… ≠ ${hash.slice(0, 12)}…`);
  } catch (e) { mismatches++; console.log(`  ✗ ${path}: ${e.message}`); }
}
const note = edgeAdjusted ? ` (${edgeAdjusted} matched only after stripping a known edge injection: ${[...edgeNames].join(", ")})` : "";
log(mismatches === 0, `${entries.length} files match the signed manifest${mismatches ? ` (${mismatches} mismatch)` : note}`);
if (edgeAdjusted && mismatches === 0) {
  console.log(`  · the signed body is intact; your CDN rewrites these files on serve. For byte-exact serving, disable it, or verify the signed OCI artifact (edge-independent).`);
}

console.log(failures ? `\n✗ verification FAILED (${failures})` : `\n✓ verified: served bytes match this build's signed provenance`);
process.exit(failures ? 1 : 0);
