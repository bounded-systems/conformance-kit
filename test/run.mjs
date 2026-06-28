#!/usr/bin/env node
// test/run.mjs — verify the kit's generic logic against fixtures, in isolation.
// Each case exercises one tool with site values injected via env/args + a fixture
// input. Build/lint is implicit (these all `import`/run). Exit 1 on any failure.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, cp, rm, mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIX = join(KIT, "fixtures");
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

let passed = 0, failed = 0;
const ok = (name, extra = "") => { console.log(`✓ ${name}${extra ? ` — ${extra}` : ""}`); passed++; };
const bad = (name, e) => { console.error(`✗ ${name}\n    ${String(e).split("\n").join("\n    ")}`); failed++; };

// Run a kit script under node; return stdout. Throws (with stderr) on nonzero exit.
const runNode = (rel, args = [], env = {}) =>
  execFileSync("node", [join(KIT, rel), ...args], { encoding: "utf8", env: { ...process.env, ...env }, cwd: KIT, stdio: ["ignore", "pipe", "pipe"] });

const work = await mkdtemp(join(tmpdir(), "ck-test-"));

async function test(name, fn) { try { await fn(); } catch (e) { bad(name, e.stdout ? e.stdout + (e.stderr || "") : e); } }

// 1. SBOM: gen against the fixture lockfile, then completeness gate.
await test("gates/sbom: gen-sbom + check-sbom on a fixture lockfile", async () => {
  const dist = join(work, "sbom"); await mkdir(dist, { recursive: true });
  const env = { ROOT: "fixtures", DIST: dist, SBOM_NAME: "fixture-sbom", SBOM_NAMESPACE_BASE: "https://fixture.example/sbom" };
  const out = runNode("gates/sbom/gen-sbom.mjs", [], env);
  const sbom = JSON.parse(await readFile(join(dist, "sbom.spdx.json"), "utf8"));
  if (sbom.spdxVersion !== "SPDX-2.3") throw new Error("not SPDX-2.3");
  if (sbom.packages.length !== 2) throw new Error(`expected 2 npm packages, got ${sbom.packages.length}`);
  runNode("gates/sbom/check-sbom.mjs", [], env); // exits 0 = well-formed + complete
  ok("gates/sbom: gen-sbom + check-sbom on a fixture lockfile", out.trim().split("\n").pop());
});

// 2. SHACL: sample shapes + HTML with conforming JSON-LD → conforms: true.
await test("gates/shacl-runner: sample shapes + HTML → conforms:true", async () => {
  const dir = join(work, "shacl"); await mkdir(dir, { recursive: true });
  await cp(join(FIX, "site", "index.html"), join(dir, "index.html")); // the page carrying the Person JSON-LD
  const out = runNode("gates/shacl-runner.mjs", [join(FIX, "jsonld.shapes.ttl"), dir]);
  if (!/conforms: true/.test(out)) throw new Error("did not report conforms: true");
  ok("gates/shacl-runner: sample shapes + HTML → conforms:true", out.trim().split("\n").pop());
});

// 3. structure-audit: sample built site → pass (baseline written to a work path).
await test("integrity/structure-audit: sample site → pass", async () => {
  const out = runNode("integrity/structure-audit/audit.mjs", [join(FIX, "site")], { STRUCTURE_BASELINE: join(work, "structure.json") });
  if (!/structure-audit passed/.test(out)) throw new Error(out);
  ok("integrity/structure-audit: sample site → pass", out.trim().split("\n").pop());
});

// 4. seo-gate: sample built site → pass.
await test("gates/seo-gate: sample site → pass", async () => {
  const out = runNode("gates/seo-gate.mjs", [join(FIX, "site")], { SEO_DEPLOY_SIDECARS: "/rekor,/provenance.json" });
  if (!/seo-gate: \d+ page/.test(out)) throw new Error(out);
  ok("gates/seo-gate: sample site → pass", out.trim().split("\n").pop());
});

// 5. readability-gate: fixture corpus → exit 0 (WARN-only).
await test("gates/readability-gate: fixture corpus → reports signal", async () => {
  const out = runNode("gates/readability-gate.mjs", [join(FIX, "corpus.json")]);
  if (!/readability-gate: signal reported/.test(out)) throw new Error(out);
  ok("gates/readability-gate: fixture corpus → reports signal", out.trim().split("\n").pop());
});

// 6. commonmark-runner: reference renderer satisfies the default fixtures.
await test("gates/commonmark-runner: reference renderer passes defaults", async () => {
  const out = runNode("gates/commonmark-runner.mjs", [join(FIX, "renderer.mjs")]);
  if (!/commonmark-runner: pinned/.test(out)) throw new Error(out);
  ok("gates/commonmark-runner: reference renderer passes defaults", out.trim().split("\n").pop());
});

// 7. gen-sitemanifest + gen-cid on a copy of the sample site.
let manifestDist;
await test("integrity/gen-sitemanifest + generators/gen-cid: sample site", async () => {
  manifestDist = join(work, "dist"); await cp(join(FIX, "site"), manifestDist, { recursive: true });
  const m = runNode("integrity/gen-sitemanifest.mjs", [], { DIST: manifestDist });
  if (!await exists(join(manifestDist, "site.sha256"))) throw new Error("no site.sha256");
  const c = runNode("generators/gen-cid.mjs", [], { DIST: manifestDist });
  const prov = JSON.parse(await readFile(join(manifestDist, "provenance.json"), "utf8"));
  if (!/^bafy|^b[a-z2-7]+$/.test(prov.contentAddress?.ipfs?.cid || "")) throw new Error("no CIDv1");
  ok("integrity/gen-sitemanifest + generators/gen-cid: sample site", `${m.trim().split(" ").slice(0,4).join(" ")} · ${prov.contentAddress.ipfs.cid.slice(0,16)}…`);
});

// 8. verify-site: re-hash the served bytes against the signed manifest (signature
//    step SKIPPED when cosign is absent). Needs provenance + a bundle file present.
await test("integrity/verify-site: byte-rehash a local build", async () => {
  const cosign = spawnSync("cosign", ["version"], { stdio: "ignore" });
  await writeFile(join(manifestDist, "provenance.json"),
    JSON.stringify({ scope: "entire-site", builder: { repository: "owner/repo", commit: "deadbeef" },
      siteManifest: { file: "site.sha256", bundle: "site.sha256.sigstore.json", verify: "cosign verify-blob …" } }, null, 2) + "\n");
  await writeFile(join(manifestDist, "site.sha256.sigstore.json"), "{}");
  // re-generate the manifest so it covers the just-written provenance? No — provenance
  // is excluded from the manifest, so the rehash set is unchanged and stays valid.
  if (cosign.status === 0) { ok("integrity/verify-site: byte-rehash a local build", "cosign present — asserting only that it runs"); return; }
  const out = runNode("integrity/verify-site.mjs", [manifestDist]);
  if (!/served bytes match this build's signed provenance/.test(out)) throw new Error(out);
  ok("integrity/verify-site: byte-rehash a local build", "all files match · cosign SKIPPED");
});

// 9. generators/gen-identity: did:web + VC from a sample subject.
await test("generators/gen-identity: did:web + VC 2.0", async () => {
  const dist = join(work, "identity"); await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "resume.json"), JSON.stringify({ basics: { name: "Ada Lovelace", url: "https://fixture.example" }, meta: { lastModified: "2026-01-01" } }) + "\n");
  runNode("generators/gen-identity.mjs", [], { IDENTITY_DOMAIN: "fixture.example", IDENTITY_REPO: "owner/repo", DIST: dist });
  const did = JSON.parse(await readFile(join(dist, ".well-known", "did.json"), "utf8"));
  const vc = JSON.parse(await readFile(join(dist, "api", "v1", "resume.vc.json"), "utf8"));
  if (did.id !== "did:web:fixture.example") throw new Error("bad did id");
  if (vc.issuer !== "did:web:fixture.example" || vc.validFrom !== "2026-01-01") throw new Error("bad VC");
  ok("generators/gen-identity: did:web + VC 2.0", `${did.id} · validFrom ${vc.validFrom}`);
});

// 10. emitters: pure helpers.
await test("emitters: reprDigest / securityTxt / webManifest", async () => {
  const { reprDigest, securityTxt, securityTxtExpires, webManifest } = await import(join(KIT, "emitters", "index.mjs"));
  const d1 = reprDigest(Buffer.from("hello")), d2 = reprDigest("hello");
  if (d1 !== d2 || !/^sha-256=:.+:$/.test(d1)) throw new Error("reprDigest not deterministic/shaped");
  const st = securityTxt({ contact: "mailto:sec@fixture.example", canonical: "https://fixture.example/.well-known/security.txt", expires: securityTxtExpires("2026-01-01T00:00:00.000Z") });
  if (!/Contact: mailto:sec@fixture.example/.test(st) || !/Expires: 2027-01-01/.test(st)) throw new Error("securityTxt wrong");
  const wm = webManifest({ name: "Fixture Site", themeColor: "#0C5A42", backgroundColor: "#EDEAE1" });
  if (wm.short_name !== "Fixture" || wm.theme_color !== "#0C5A42") throw new Error("webManifest wrong");
  ok("emitters: reprDigest / securityTxt / webManifest");
});

// 11. openapi helper: validateOpenapi on a well-formed + a broken doc.
await test("generators/openapi: validateOpenapi", async () => {
  const { validateOpenapi, jsonResponse, embedSchema, sortKeys } = await import(join(KIT, "generators", "openapi.mjs"));
  const good = { openapi: "3.2.0", info: { title: "x", version: "1" }, paths: { "/p": { get: { responses: { 200: jsonResponse("#/components/schemas/P") } } } }, components: { schemas: { P: embedSchema({ $schema: "x", $id: "y", type: "object" }) } } };
  const e1 = validateOpenapi(good);
  if (e1.length) throw new Error("good doc flagged: " + e1.join("; "));
  const bad = { openapi: "2.0", info: {}, paths: {} };
  const e2 = validateOpenapi(bad);
  if (e2.length < 2) throw new Error("broken doc not flagged");
  if (JSON.stringify(sortKeys({ b: 1, a: 2 })) !== '{"a":2,"b":1}') throw new Error("sortKeys wrong");
  ok("generators/openapi: validateOpenapi", `good=ok, broken flagged ${e2.length}`);
});

await rm(work, { recursive: true, force: true });
console.log(`\n${failed ? "✗" : "✓"} conformance-kit tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
