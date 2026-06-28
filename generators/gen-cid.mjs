#!/usr/bin/env node
// gen-cid — content-address the served site as an IPFS UnixFS directory CID, with
// NO daemon and NO new dependency, and record it in the build provenance alongside
// the existing digests (the site.sha256 manifest hash).
//
//   node generators/gen-cid.mjs            # uses ./dist
//   DIST=out node generators/gen-cid.mjs
//
// Runs LAST, after every served byte exists. It builds the exact UnixFS dag-pb DAG
// `ipfs add -r` would (classic layout: sha2-256, 256 KiB fixed chunker, no raw
// leaves), so the reported CIDv1 re-derives from the served bytes by any IPFS
// implementation. The file set is exactly the signed whole-site manifest
// ($DIST/site.sha256) when present, so the CID and the manifest cover identical
// content; otherwise it walks $DIST with the same sidecar exclusions. No pinning,
// no DNSLink — just a portable address.
//
// Recorded into $DIST/provenance.json (merged if gen-provenance already wrote it;
// created minimally for a local build). provenance.json is excluded from the
// manifest + the CID set, so there is no circularity. Site-agnostic: the only knob
// is $DIST.
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

// $DIST may be absolute or relative-to-cwd (resolve handles both); default ./dist.
const dist = resolve(process.cwd(), process.env.DIST || "dist");
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const CHUNK = 262144;  // kubo default fixed chunker
const MAX_LINKS = 174; // kubo default balanced-layout fanout

// Same sidecars gen-sitemanifest.mjs excludes from site.sha256 (they describe the
// site, they are not the site) — plus any Sigstore bundle, which is written after.
const EXCLUDE = new Set([
  "site.sha256", "provenance.json", "rekor/index.html",
  "attestation.intoto.json", "_headers", "_redirects", "_routes.json",
]);
const isExcluded = (rel) => EXCLUDE.has(rel) || rel.endsWith(".sigstore.json") || rel.startsWith("rekor/");

// ---- protobuf + dag-pb + UnixFS (single-block + balanced multi-block) --------
const varint = (n) => { const o = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return Buffer.from(o); };
const lenDelim = (tag, buf) => Buffer.concat([varint(tag), varint(buf.length), buf]);
const vfield = (tag, n) => Buffer.concat([varint(tag), varint(n)]);
const sha256 = (buf) => createHash("sha256").update(buf).digest();
const multihash = (buf) => Buffer.concat([Buffer.from([0x12, 0x20]), sha256(buf)]); // 0x12 sha2-256, 0x20 len

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (bytes) => { let bits = 0, value = 0, out = ""; for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(value << (5 - bits)) & 31]; return out; };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes) => { let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++; let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } return "1".repeat(zeros) + out; };
const cidV1Base32 = (mh) => "b" + base32(Buffer.concat([Buffer.from([0x01, 0x70]), mh])); // 0x01 v1, 0x70 dag-pb
const cidV0Base58 = (mh) => base58(mh); // v0 == bare dag-pb multihash, base58btc

// UnixFS Data: Type(1) File=2 / Directory=1, Data(2), filesize(3), blocksizes(4 repeated)
const ufLeaf = (data) => Buffer.concat([vfield(0x08, 2), lenDelim(0x12, data), vfield(0x18, data.length)]);
const ufFileRoot = (filesize, blocksizes) => Buffer.concat([vfield(0x08, 2), vfield(0x18, filesize), ...blocksizes.map((b) => vfield(0x20, b))]);
const ufDir = () => vfield(0x08, 1);
// dag-pb PBNode: Links(2) entries first, then Data(1). PBLink: Hash(1), Name(2), Tsize(3)
const pbLink = (mh, name, tsize) => Buffer.concat([lenDelim(0x0a, mh), lenDelim(0x12, Buffer.from(name, "utf8")), vfield(0x18, tsize)]);
const pbNode = (linkBufs, data) => Buffer.concat([...linkBufs.map((l) => lenDelim(0x12, l)), ...(data ? [lenDelim(0x0a, data)] : [])]);

// → { mh, size }  size = cumulative (this block's bytes + all descendants)
function encodeFile(content) {
  if (content.length <= CHUNK) { const node = pbNode([], ufLeaf(content)); return { mh: multihash(node), size: node.length }; }
  let layer = [];
  for (let i = 0; i < content.length; i += CHUNK) { const c = content.subarray(i, i + CHUNK); const node = pbNode([], ufLeaf(c)); layer.push({ mh: multihash(node), size: node.length, bs: c.length }); }
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += MAX_LINKS) {
      const group = layer.slice(i, i + MAX_LINKS);
      const blocksizes = group.map((g) => g.bs);
      const filesize = blocksizes.reduce((a, b) => a + b, 0);
      const node = pbNode(group.map((g) => pbLink(g.mh, "", g.size)), ufFileRoot(filesize, blocksizes));
      next.push({ mh: multihash(node), size: node.length + group.reduce((a, g) => a + g.size, 0), bs: filesize });
    }
    layer = next;
  }
  return { mh: layer[0].mh, size: layer[0].size };
}

// A directory tree node: { dirs: Map<name,node>, files: Map<name,absPath> }
const newDir = () => ({ dirs: new Map(), files: new Map() });
function insert(treeRoot, relParts, abs) {
  let node = treeRoot;
  for (let i = 0; i < relParts.length - 1; i++) { const seg = relParts[i]; if (!node.dirs.has(seg)) node.dirs.set(seg, newDir()); node = node.dirs.get(seg); }
  node.files.set(relParts[relParts.length - 1], abs);
}
async function encodeDir(node) {
  const links = [];
  for (const [name, abs] of node.files) { const r = encodeFile(await readFile(abs)); links.push({ name, mh: r.mh, size: r.size }); }
  for (const [name, child] of node.dirs) { const r = await encodeDir(child); links.push({ name, mh: r.mh, size: r.size }); }
  links.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))); // go-ipfs sorts dir links by raw name
  const node2 = pbNode(links.map((l) => pbLink(l.mh, l.name, l.size)), ufDir());
  return { mh: multihash(node2), size: node2.length + links.reduce((a, l) => a + l.size, 0) };
}

// ---- collect the served file set ---------------------------------------------
async function fromManifest() {
  const text = await readFile(join(dist, "site.sha256"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => line.slice(line.indexOf("  ") + 2));
}
async function fromWalk() {
  const out = [];
  const walk = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name); const rel = relative(dist, abs);
      if (ent.isDirectory()) { await walk(abs); continue; }
      if (isExcluded(rel)) continue;
      out.push(rel);
    }
  };
  await walk(dist);
  return out;
}

const usedManifest = await exists(join(dist, "site.sha256"));
const rels = (usedManifest ? await fromManifest() : await fromWalk()).filter((r) => !isExcluded(r)).sort();
const tree = newDir();
for (const rel of rels) insert(tree, rel.split("/"), join(dist, rel));
const r = await encodeDir(tree);
const cid = cidV1Base32(r.mh);
const cidV0 = cidV0Base58(r.mh);

// ---- record into the build provenance ----------------------------------------
const provPath = join(dist, "provenance.json");
const provenance = (await exists(provPath)) ? JSON.parse(await readFile(provPath, "utf8")) : { scope: "entire-site" };
provenance.contentAddress = {
  ...(provenance.contentAddress || {}),
  ipfs: {
    cid,
    cidV0,
    codec: "dag-pb",
    multihash: "sha2-256",
    scope: usedManifest ? "served-site (site.sha256 file set)" : "served-site (dist minus provenance sidecars)",
    fileCount: rels.length,
    pinned: false,
    dnslink: false,
    derivation: "generators/gen-cid.mjs — zero-dep UnixFS v1 (dag-pb, sha2-256, 256 KiB fixed chunker, no raw leaves)",
    note: "IPFS UnixFS directory CID over the served site, computed with no daemon. Re-derives from the served bytes: `ipfs add -rQ --cid-version=1` over the same file set yields this CID (or `ipfs add -rQ` then `ipfs cid base32` from the v0 form).",
  },
};
await writeFile(provPath, JSON.stringify(provenance, null, 2) + "\n");

console.log(`✓ ipfs CID: ${cid} (${rels.length} files, ${usedManifest ? "from site.sha256" : "from dist walk"}) → provenance.json contentAddress.ipfs`);
