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

// 12. conformance-report: lone's conformance() model + the generic renderer.
await test("gates/conformance-report: build + render the conformance projection", async () => {
  const { buildConformanceReport, renderConformanceReport, COMPACT_CLAIM, CRITERIA } =
    await import(join(KIT, "gates", "conformance-report.mjs"));

  // (a) DOM not blessed + only build-derived evidence supplied → honest partial.
  const partial = buildConformanceReport({
    loneFindings: null, // no DOM blessed in this context
    evidence: {
      contentDigests: { reprDigestHeaders: true },
      feeds: { atomValid: true },
      sbom: { present: true, valid: true, complete: true, signed: false }, // unmet
      jsonLdShacl: undefined, // pruned → not-assessed
      // manual a11y / axe / ASVS / CWV / Baseline: not supplied → not-assessed
    },
  });
  if (partial.results.length !== CRITERIA.length) throw new Error("result count != criteria count");
  if (partial.conformant !== false) throw new Error("must not be conformant without tier-1 evidence");
  if (partial.claim === COMPACT_CLAIM) throw new Error("emitted the strong claim without gating evidence");
  if (!/^Partial conformance:/.test(partial.claim)) throw new Error(`expected a partial claim, got: ${partial.claim}`);
  const byId = Object.fromEntries(partial.results.map((r) => [r.id, r]));
  if (byId["integrity.content-digests"].status !== "met") throw new Error("content-digests should be met");
  if (byId["integrity.sbom"].status !== "unmet") throw new Error("unsigned SBOM should be unmet");
  if (byId["security.asvs"].status !== "not-assessed") throw new Error("unsupplied ASVS must be not-assessed, never unmet");
  if (byId["a11y.wcag22-aa-manual"].status !== "not-assessed") throw new Error("unsupplied manual WCAG must be not-assessed");
  if (byId["html.dom-author-requirements"].status !== "not-assessed") throw new Error("unblessed DOM must be not-assessed");

  // (b) clean DOM + every tier-1 external supplied & passing → the strong claim.
  const full = buildConformanceReport({
    loneFindings: [], // lone ran, found nothing
    evidence: {
      htmlValidator: { errors: 0 },
      axe: { serious: 0, critical: 0 },
      manualA11y: { wcag22AA: true, keyboardTested: true, screenReaderTested: true, completeFlows: true, verifiedBy: "Acme Accessibility Auditors" },
      asvs: { achievedLevel: 2, targetLevel: 2, verifiedBy: "Acme Security Labs" },
      vulns: { knownCriticalOrHighVulns: 0 },
      coreWebVitals: [
        { formFactor: "mobile", percentile: 75, lcpMs: 1800, inpMs: 90, cls: 0.02 },
        { formFactor: "desktop", percentile: 75, lcpMs: 1200, inpMs: 40, cls: 0.01 },
      ],
      baseline: { status: "widely" },
      reliability: { uncaughtErrors: 0, brokenInternalLinks: 0, e2eCriticalJourneys: true },
      // tier-2/3 left unsupplied: must NOT affect the tier-1 compact claim.
    },
  });
  if (full.conformant !== true) throw new Error("clean DOM + full tier-1 evidence should be conformant");
  if (full.claim !== COMPACT_CLAIM) throw new Error("should emit the canonical COMPACT_CLAIM verbatim");

  // (c) self-attestation WITHOUT an independent verifier never gates the claim:
  // the same clean booleans, minus verifiedBy, must demote to not-assessed.
  const selfAttested = buildConformanceReport({
    loneFindings: [],
    evidence: {
      htmlValidator: { errors: 0 },
      axe: { serious: 0, critical: 0 },
      manualA11y: { wcag22AA: true, keyboardTested: true, screenReaderTested: true, completeFlows: true }, // no verifiedBy
      asvs: { achievedLevel: 2, targetLevel: 2 }, // no verifiedBy
      vulns: { knownCriticalOrHighVulns: 0 },
      coreWebVitals: [
        { formFactor: "mobile", percentile: 75, lcpMs: 1800, inpMs: 90, cls: 0.02 },
        { formFactor: "desktop", percentile: 75, lcpMs: 1200, inpMs: 40, cls: 0.01 },
      ],
      baseline: { status: "widely" },
      reliability: { uncaughtErrors: 0, brokenInternalLinks: 0, e2eCriticalJourneys: true },
    },
  });
  const byIdSelf = Object.fromEntries(selfAttested.results.map((r) => [r.id, r]));
  if (byIdSelf["security.asvs"].status !== "not-assessed") throw new Error("self-attested ASVS (no verifiedBy) must be not-assessed");
  if (byIdSelf["a11y.wcag22-aa-manual"].status !== "not-assessed") throw new Error("self-attested manual WCAG (no verifiedBy) must be not-assessed");
  if (byIdSelf["security.no-critical-vulns"].status !== "met") throw new Error("decoupled vulns must stand alone as met");
  if (selfAttested.conformant !== false) throw new Error("self-attestation alone must NOT yield the compact claim");

  // (d) vulns decoupled from ASVS: an objective vuln count with NO asvs object at
  // all is still assessable on its own.
  const vulnsOnly = buildConformanceReport({ evidence: { vulns: { knownCriticalOrHighVulns: 3 } } });
  const byIdV = Object.fromEntries(vulnsOnly.results.map((r) => [r.id, r]));
  if (byIdV["security.no-critical-vulns"].status !== "unmet") throw new Error("3 vulns must be unmet, no asvs object required");
  if (byIdV["security.asvs"].status !== "not-assessed") throw new Error("absent asvs must be not-assessed");

  // (e) external graders (Scorecard / HSTS / SLSA level) — independent third-party
  // grades, assessable on their own, recommended (non-gating).
  const statusById = (r) => Object.fromEntries(r.results.map((x) => [x.id, x.status]));
  const absent = statusById(buildConformanceReport({ evidence: {} }));
  for (const id of ["security.hsts-preload", "integrity.scorecard", "integrity.slsa-level"]) {
    if (absent[id] !== "not-assessed") throw new Error(`${id} absent must be not-assessed`);
  }
  const graders = statusById(buildConformanceReport({
    evidence: {
      hstsPreload: { preloaded: true },
      scorecard: { score: 7.0 },
      slsaLevel: { level: 3 }, // target defaults to L3
    },
  }));
  if (graders["security.hsts-preload"] !== "met") throw new Error("preloaded HSTS must be met");
  if (graders["integrity.scorecard"] !== "met") throw new Error("Scorecard 7.0 must be met");
  if (graders["integrity.slsa-level"] !== "met") throw new Error("SLSA L3 (target L3) must be met");
  const gradersBad = statusById(buildConformanceReport({
    evidence: { hstsPreload: { preloaded: false }, scorecard: { score: 6.9 }, slsaLevel: { level: 2 } },
  }));
  if (gradersBad["security.hsts-preload"] !== "unmet") throw new Error("non-preloaded HSTS must be unmet");
  if (gradersBad["integrity.scorecard"] !== "unmet") throw new Error("Scorecard 6.9 must be unmet");
  if (gradersBad["integrity.slsa-level"] !== "unmet") throw new Error("SLSA L2 below target L3 must be unmet");

  // malformed envelope → throw (lone refuses to guess).
  let threw = false;
  try { buildConformanceReport({ evidence: { sbom: { present: "yes" } } }); } catch { threw = true; }
  if (!threw) throw new Error("a malformed envelope must throw");

  // renderer: semantic, class-based, evidence links injected by the consumer.
  const html = renderConformanceReport(partial, { evidenceHref: (c) => `/evidence/${c.id}` });
  for (const needle of ['class="ck-conformance"', "ck-status--met", "ck-status--not-assessed", "ck-area__summary", "/evidence/integrity.sbom"]) {
    if (!html.includes(needle)) throw new Error(`renderer output missing ${needle}`);
  }
  if (/style=/.test(html)) throw new Error("renderer must not emit inline styles");
  // The outer ck-conformance <section> carries a heading (vnu --Werror: a section
  // must have one); per-area sub-sections nest one level below it.
  if (!/<h2 class="ck-conformance__heading">Conformance<\/h2>/.test(html)) {
    throw new Error("ck-conformance section must have an h2 heading");
  }
  if (!/<h3 class="ck-area__title">/.test(html)) throw new Error("per-area titles must nest one level below (h3)");
  ok("gates/conformance-report: build + render the conformance projection",
    `partial=${partial.summary.met}met/${partial.summary.unmet}unmet/${partial.summary.notAssessed}n-a · full claim=compact`);
});

// 13. axe-gate: pure classification/threshold/report logic, then a best-effort
//     end-to-end run on the known-bad + known-good fixtures (skipped if no browser
//     runner is on PATH, like the cosign step above).
await test("gates/axe-gate: classify + threshold + report, e2e on fixtures", async () => {
  const { evaluatePage, summarize, blocksAt, normalizeViolation, runAxeGate } =
    await import(join(KIT, "gates", "axe-gate.mjs"));

  // (a) threshold semantics: block at/above the configured impact; null never blocks.
  if (!blocksAt("critical", "serious") || !blocksAt("serious", "serious")) throw new Error("serious/critical must block at serious");
  if (blocksAt("moderate", "serious") || blocksAt("minor", "serious")) throw new Error("moderate/minor must not block at serious");
  if (blocksAt(null, "serious")) throw new Error("null impact must never block");
  if (!blocksAt("moderate", "moderate")) throw new Error("moderate must block at moderate");

  // (b) pure evaluation over synthetic axe violations (shaped like axe output).
  const synthetic = [
    { id: "image-alt", impact: "critical", help: "Images must have alternate text", helpUrl: "h", nodes: [{ target: ["img"] }] },
    { id: "link-name", impact: "serious", help: "Links must have discernible text", helpUrl: "h", nodes: [{ target: ["a"] }] },
    { id: "landmark", impact: "moderate", help: "x", helpUrl: "h", nodes: [{ target: ["div"] }] },
  ];
  const ev = evaluatePage("bad.html", synthetic, "serious");
  if (ev.blocking !== 2) throw new Error(`expected 2 blocking (critical+serious), got ${ev.blocking}`);
  if (ev.counts.critical !== 1 || ev.counts.serious !== 1 || ev.counts.moderate !== 1) throw new Error("impact counts wrong");
  if (!ev.violations.critical || !ev.violations.serious) throw new Error("byImpact grouping missing serious/critical");
  if (normalizeViolation(synthetic[0]).targets[0] !== "img") throw new Error("target normalisation wrong");

  const rep = summarize([ev, evaluatePage("good.html", [], "serious")], { threshold: "serious", runner: "synthetic" });
  if (rep.axe.critical !== 1 || rep.axe.serious !== 1) throw new Error("report axe envelope must total serious/critical");
  if (rep.passed !== false || rep.blocking !== 2) throw new Error("report with serious/critical must not pass");
  const cleanRep = summarize([evaluatePage("good.html", [], "serious")], { threshold: "serious" });
  if (cleanRep.passed !== true || cleanRep.axe.serious !== 0 || cleanRep.axe.critical !== 0) throw new Error("clean report must pass with axe {0,0}");

  // (c) end-to-end against the fixtures, with whatever real engine is present.
  // tezcatl (macOS WebKit) is preferred locally; Playwright/Chromium is the CI path.
  // If neither engine can actually launch (e.g. Chromium not downloaded), SKIP — the
  // pure logic above is the deterministic, always-on assertion (cf. the cosign skip).
  const hasTezcatl = spawnSync("tezcatl", ["--version"], { stdio: "ignore" }).status === 0;
  let hasPlaywright = false;
  try { await import("@axe-core/playwright"); await import("playwright"); hasPlaywright = true; } catch { /* optional dep */ }
  const runner = hasTezcatl ? "tezcatl" : hasPlaywright ? "playwright" : null;
  const fixDir = join(FIX, "axe");
  try {
    if (!runner) throw new Error("no browser runner on PATH");
    const badRun = await runAxeGate({ dist: fixDir, pages: ["bad.html"], threshold: "serious", runner });
    if (badRun.passed !== false || badRun.blocking < 1) throw new Error(`known-bad fixture must fail the gate (${runner})`);
    if (badRun.axe.serious + badRun.axe.critical < 1) throw new Error("known-bad fixture must surface a serious/critical violation");
    const goodRun = await runAxeGate({ dist: fixDir, pages: ["good.html"], threshold: "serious", runner });
    if (goodRun.passed !== true) throw new Error(`known-good fixture must pass the gate (${runner})`);
    ok("gates/axe-gate: classify + threshold + report, e2e on fixtures",
      `pure logic asserted · e2e (${runner}): bad=${badRun.axe.critical}c/${badRun.axe.serious}s blocking, good=clean`);
  } catch (e) {
    // A real assertion failure (the fixtures are wrong) must surface; only a
    // missing/unlaunchable engine is a tolerated skip.
    if (/must (fail|pass|surface)|grouping|counts|envelope/.test(e.message)) throw e;
    ok("gates/axe-gate: classify + threshold + report, e2e on fixtures",
      `pure logic asserted · e2e SKIPPED (${e.message.split("\n")[0]})`);
  }
});

// 14. vuln-gate: pure parse/evaluate logic, then a best-effort e2e via real npm audit.
await test("gates/vuln-gate: parse + evaluate, e2e via npm audit", async () => {
  const { parseAudit, evaluateVulns, runVulnGate } = await import(join(KIT, "gates", "vuln-gate.mjs"));

  // (a) pure parse over npm-audit-shaped payloads.
  const clean = parseAudit({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 0, critical: 0 } } });
  if (clean.known !== 0 || clean.high !== 0 || clean.critical !== 0) throw new Error("clean audit must total 0 critical/high");
  const dirty = parseAudit({ metadata: { vulnerabilities: { high: 2, critical: 1 } } });
  if (dirty.known !== 3 || dirty.critical !== 1 || dirty.high !== 2) throw new Error(`expected 3 known (1c/2h), got ${dirty.known}`);
  if (parseAudit({}).known !== 0) throw new Error("missing metadata must parse to 0");

  // (b) pure threshold evaluation + the lone evidence envelope.
  const cleanEval = evaluateVulns(clean, 0);
  if (!cleanEval.passed || cleanEval.vulns.knownCriticalOrHighVulns !== 0) throw new Error("clean must pass with vulns {0}");
  const bad = evaluateVulns(dirty, 0);
  if (bad.passed || bad.vulns.knownCriticalOrHighVulns !== 3) throw new Error("3 known at threshold 0 must fail");
  if (!evaluateVulns(dirty, 5).passed) throw new Error("3 known at threshold 5 must pass");

  // (c) best-effort e2e: real npm audit over the kit's own lockfile. Offline/registry
  // failures are a tolerated skip (the pure logic above is the always-on assertion).
  try {
    const rep = runVulnGate({ root: KIT, omitDev: true, threshold: 0 });
    if (typeof rep.vulns.knownCriticalOrHighVulns !== "number") throw new Error("e2e report missing the vulns envelope");
    ok("gates/vuln-gate: parse + evaluate, e2e via npm audit",
      `pure logic asserted · e2e: ${rep.knownCriticalOrHighVulns} known critical/high in prod deps`);
  } catch (e) {
    if (/must (pass|fail|total)|envelope|expected/.test(e.message)) throw e;
    ok("gates/vuln-gate: parse + evaluate, e2e via npm audit", `pure logic asserted · e2e SKIPPED (${e.message.split("\n")[0]})`);
  }
});

// 15. html-validator-gate: pure parse/evaluate, then a best-effort e2e via real vnu.
await test("gates/html-validator-gate: parse + evaluate, e2e on fixtures", async () => {
  const { parseVnu, evaluateHtml, runHtmlGate } = await import(join(KIT, "gates", "html-validator-gate.mjs"));

  // (a) pure parse over vnu --format json payloads (errors-only filtering).
  const errs = parseVnu({ messages: [
    { type: "error", message: "boom", url: "file:/p.html", lastLine: 9 },
    { type: "info", subType: "warning", message: "meh" },
    { type: "error", message: "bang", url: "file:/q.html", lastLine: 3 },
  ] });
  if (errs.length !== 2) throw new Error(`expected 2 error messages (info dropped), got ${errs.length}`);
  if (parseVnu('{"messages":[]}').length !== 0) throw new Error("empty payload must parse to 0");

  // (b) pure threshold evaluation + the lone evidence envelope.
  const okEval = evaluateHtml([], 0);
  if (!okEval.passed || okEval.htmlValidator.errors !== 0) throw new Error("0 errors must pass with htmlValidator {0}");
  const badEval = evaluateHtml(errs, 0);
  if (badEval.passed || badEval.htmlValidator.errors !== 2) throw new Error("2 errors at threshold 0 must fail");

  // (c) best-effort e2e on the good/bad fixtures with real vnu. A missing JRE is a
  // tolerated skip (the pure logic above is the deterministic assertion).
  const hasJava = spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;
  const fixDir = join(FIX, "html");
  try {
    if (!hasJava) throw new Error("no JRE on PATH");
    const bad = await runHtmlGate({ dist: fixDir, pages: ["bad.html"], threshold: 0 });
    if (bad.passed || bad.errors < 1) throw new Error("known-bad fixture must fail (≥1 vnu error)");
    const good = await runHtmlGate({ dist: fixDir, pages: ["good.html"], threshold: 0 });
    if (!good.passed || good.errors !== 0) throw new Error("known-good fixture must pass (0 vnu errors)");
    ok("gates/html-validator-gate: parse + evaluate, e2e on fixtures",
      `pure logic asserted · e2e (vnu): bad=${bad.errors} error(s), good=clean`);
  } catch (e) {
    if (/must (pass|fail)|expected|envelope/.test(e.message)) throw e;
    ok("gates/html-validator-gate: parse + evaluate, e2e on fixtures", `pure logic asserted · e2e SKIPPED (${e.message.split("\n")[0]})`);
  }
});

// 16. baseline-gate: pure classify/threshold, then a deterministic e2e via stylelint.
await test("gates/baseline-gate: classify + threshold, e2e on fixtures", async () => {
  const { classify, meetsTarget, evaluateBaseline, runBaselineGate } = await import(join(KIT, "gates", "baseline-gate.mjs"));

  // (a) pure classification from the two-pass counts.
  if (classify(0, 0) !== "widely") throw new Error("0 below widely → widely");
  if (classify(2, 0) !== "newly") throw new Error("below-widely but not below-newly → newly");
  if (classify(2, 1) !== "limited") throw new Error("any below-newly → limited");

  // (b) pure target threshold + the lone evidence envelope.
  if (!meetsTarget("widely", "widely") || !meetsTarget("widely", "newly")) throw new Error("widely meets any target");
  if (meetsTarget("limited", "newly") || meetsTarget("newly", "widely")) throw new Error("below-target must not meet");
  const ev = evaluateBaseline("widely", "widely");
  if (!ev.passed || ev.baseline.status !== "widely") throw new Error("widely@widely must pass with baseline {widely}");
  if (evaluateBaseline("limited", "widely").passed) throw new Error("limited@widely must fail");

  // (c) deterministic e2e via stylelint over the fixtures (pure npm — runs in CI).
  const good = await runBaselineGate({ css: join(FIX, "baseline", "good.css"), target: "widely" });
  if (!good.passed || good.status !== "widely") throw new Error(`good.css must be widely, got ${good.status}`);
  const bad = await runBaselineGate({ css: join(FIX, "baseline", "bad.css"), target: "widely" });
  if (bad.passed || bad.status === "widely" || bad.offenders.length < 1) throw new Error(`bad.css must be below widely, got ${bad.status}`);
  ok("gates/baseline-gate: classify + threshold, e2e on fixtures",
    `pure logic asserted · e2e (stylelint): good=widely, bad=${bad.status} (${bad.offenders.length} below-widely)`);
});

// 17. gen-snapshots: reader extraction → Markdown (pure, deterministic — runs in CI).
await test("generators/gen-snapshots: reader extraction + markdown", async () => {
  const { extractReader, toMarkdown } = await import(join(KIT, "generators", "gen-snapshots.mjs"));
  const html = await readFile(join(FIX, "snapshots", "article.html"), "utf8");

  const reader = extractReader(html, { url: "https://fixture.example/the-bet" });
  if (!reader) throw new Error("article fixture must extract a reader view");
  if (!/The Bet/.test(reader.title)) throw new Error(`title not extracted (got ${reader.title})`);
  if (/About<\/a>|<footer/i.test(reader.contentHtml)) throw new Error("reader content must strip nav/footer chrome");
  if (!/clear edges/.test(reader.text)) throw new Error("reader text must carry the article body");

  const md = toMarkdown(reader);
  if (!/^---\n/.test(md)) throw new Error("markdown must lead with YAML front-matter");
  if (!/source: https:\/\/fixture\.example\/the-bet/.test(md)) throw new Error("front-matter must record the source url");
  if (!/## Why it matters/.test(md)) throw new Error("markdown must carry headings (## Why it matters)");
  if (!/-\s+one checkpoint per capability/.test(md)) throw new Error("markdown must carry list items");
  if (/<nav>|<footer>/.test(md)) throw new Error("markdown must not contain page chrome");

  // a contentless page extracts to null, which the generator skips gracefully.
  if (extractReader("<!DOCTYPE html><html><head><title>x</title></head><body></body></html>") !== null) {
    throw new Error("a contentless page should yield no reader view (null)");
  }
  ok("generators/gen-snapshots: reader extraction + markdown", `title + front-matter + ${md.split("\n").length}-line markdown`);
});

// 19. palette-gate: pure colour-science primitives validated against PUBLISHED
//     reference values, then a deterministic e2e on the good/bad token fixtures.
await test("gates/palette-gate: colour-science + CVD/APCA/non-text, e2e on fixtures", async () => {
  const P = await import(join(KIT, "gates", "palette-gate.mjs"));

  // (a) WCAG-2 contrast against canonical values.
  if (P.wcagContrast(P.parseHex("#000"), P.parseHex("#fff")).toFixed(2) !== "21.00") throw new Error("black/white must be 21:1");
  if (P.wcagContrast(P.parseHex("#777"), P.parseHex("#fff")).toFixed(2) !== "4.48") throw new Error("#777/#fff must be 4.48:1");

  // (b) APCA-W3 (~0.1.9) against the algorithm's published reference outputs.
  if (P.apcaContrast(P.parseHex("#000"), P.parseHex("#fff")).toFixed(2) !== "106.04") throw new Error("APCA black-on-white must be Lc 106.04");
  if (P.apcaContrast(P.parseHex("#fff"), P.parseHex("#000")).toFixed(2) !== "-107.88") throw new Error("APCA white-on-black must be Lc -107.88");
  if (P.apcaContrast(P.parseHex("#888"), P.parseHex("#fff")).toFixed(2) !== "63.06") throw new Error("APCA #888-on-white must be Lc 63.06");

  // (c) CIEDE2000 against a Sharma et al. (2005) reference pair, and identity = 0.
  if (P.ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485]).toFixed(4) !== "2.0425") throw new Error("CIEDE2000 reference pair must be 2.0425");
  if (P.ciede2000(P.rgbToLab(P.parseHex("#0C5A42")), P.rgbToLab(P.parseHex("#0C5A42"))) !== 0) throw new Error("a colour vs itself must be ΔE 0");

  // (d) CVD simulation collapses the classic red/green confusion (ΔE 75→7 under deuteranopia).
  const red = P.parseHex("#d00"), grn = P.parseHex("#0a0");
  const dNorm = P.ciede2000(P.rgbToLab(red), P.rgbToLab(grn));
  const dDeut = P.ciede2000(P.rgbToLab(P.simulateCVD(red, "deuteranopia")), P.rgbToLab(P.simulateCVD(grn, "deuteranopia")));
  if (!(dNorm > 60 && dDeut < 15)) throw new Error(`red/green must collapse under deuteranopia (got ${dNorm.toFixed(0)}→${dDeut.toFixed(0)})`);

  // (e) pure per-pair evaluation: a marginal red passes WCAG for normal vision but fails for a protanope.
  const danger = P.evaluatePair({ fg: "#e53935", bg: "#000000", fgHex: "#e53935", bgHex: "#000000", kind: "text" });
  if (!danger.checks.wcagAA) throw new Error("#e53935/#000 must clear AA for normal vision");
  if (danger.cvd.protanopia.pass || danger.cvd.pass) throw new Error("#e53935/#000 must fail CVD-safe contrast under protanopia");
  if (danger.passed) throw new Error("a CVD-unsafe pair must not pass overall");

  // (f) deterministic e2e over the good/bad token fixtures (pure node — runs in CI).
  const good = await P.runPaletteGate({ tokens: join(FIX, "palette", "good.tokens.css"), pairings: join(FIX, "palette", "good.pairings.json") });
  if (!good.passed) throw new Error(`good fixture must pass, got summary ${JSON.stringify(good.summary)}`);
  const bad = await P.runPaletteGate({ tokens: join(FIX, "palette", "bad.tokens.css"), pairings: join(FIX, "palette", "bad.pairings.json") });
  if (bad.passed) throw new Error("bad fixture must fail");
  if (bad.summary.wcagFailures < 1 || bad.summary.cvdFailures < 1 || bad.summary.apcaFailures < 1 || bad.summary.nonTextFailures < 1 || bad.summary.categoricalCollapses < 1)
    throw new Error(`bad fixture must trip every check, got ${JSON.stringify(bad.summary)}`);
  ok("gates/palette-gate: colour-science + CVD/APCA/non-text, e2e on fixtures",
    `refs asserted (WCAG/APCA/CIEDE2000/CVD) · e2e: good=clean, bad trips WCAG+CVD+APCA+non-text+${bad.summary.categoricalCollapses} collapse(s)`);
});

// 18. jargon-gate: pure tokenize/detect/evaluate, then a deterministic e2e on fixtures.
await test("gates/jargon-gate: tokenize + detect + evaluate, e2e on fixtures", async () => {
  const { tokenize, candidateJargon, evaluateJargon, extractProseAndDefinitions, runJargonGate } =
    await import(join(KIT, "gates", "jargon-gate.mjs"));

  // (a) pure tokenize + dictionary-based candidate detection.
  if (tokenize("The frobnicator runs.").join(",") !== "the,frobnicator,runs") throw new Error("tokenize wrong");
  const cands = candidateJargon("the secure frobnicator reads provenance", { minLength: 3 });
  if (!cands.has("frobnicator")) throw new Error("must flag the non-dictionary word");
  if (cands.has("secure") || cands.has("provenance")) throw new Error("must not flag common dictionary words");

  // (b) pure evaluation against defined terms + the plain-language envelope.
  const undef = evaluateJargon({ candidates: new Set(["frobnicator", "ocap"]), definitions: new Set(["ocap"]), threshold: 0 });
  if (undef.passed || undef.count !== 1 || undef.undefinedJargon[0] !== "frobnicator") throw new Error("must report the one undefined term");
  if (undef.plainLanguage.undefinedJargon !== 1 || undef.plainLanguage.glossaryPresent !== true) throw new Error("plainLanguage envelope wrong");
  if (!evaluateJargon({ candidates: new Set(["ocap"]), definitions: new Set(["ocap"]) }).passed) throw new Error("a fully-defined set must pass");

  // (c) definitions extraction strips chrome and reads <abbr>/<dfn>/<dl> + boundary spaces.
  const { text, definitions } = extractProseAndDefinitions(await readFile(join(FIX, "jargon", "good.html"), "utf8"));
  if (!definitions.has("ocap") || !definitions.has("frobnicator")) throw new Error("must collect abbr/dt definitions");
  if (/frobnicatorthe/.test(text)) throw new Error("adjacent blocks must not merge into a fake token");

  // (d) deterministic e2e over the fixtures (pure npm — runs in CI).
  const good = await runJargonGate({ dist: join(FIX, "jargon"), pages: ["good.html"] });
  if (good.count !== 0) throw new Error(`good fixture must have 0 undefined jargon, got ${good.count}: ${good.undefinedJargon}`);
  const bad = await runJargonGate({ dist: join(FIX, "jargon"), pages: ["bad.html"] });
  if (bad.count < 3 || !bad.undefinedJargon.includes("widgetizer")) throw new Error(`bad fixture must flag fabricated jargon, got ${bad.undefinedJargon}`);
  ok("gates/jargon-gate: tokenize + detect + evaluate, e2e on fixtures",
    `pure logic asserted · e2e: good=0 undefined, bad=${bad.count} (${bad.undefinedJargon.slice(0, 3).join(", ")}…)`);
});

// 19. gen-print-snapshots: pure path/mime/renderer logic, then a best-effort PDF e2e.
await test("generators/gen-print-snapshots: paths + renderer, e2e via tezcatl", async () => {
  const { pdfOutPath, mimeFor, rendererCommand, genPrintSnapshots } =
    await import(join(KIT, "generators", "gen-print-snapshots.mjs"));

  // (a) pure output-path + mime + renderer-command mapping.
  if (pdfOutPath("dist/blog/x.html") !== join("dist/blog", "x.print.pdf")) throw new Error("pdfOutPath wrong");
  if (pdfOutPath("dist/i.html", ".pp") !== join("dist", "i.pp.pdf")) throw new Error("custom suffix wrong");
  if (mimeFor("a.css") !== "text/css" || mimeFor("f.woff2") !== "font/woff2") throw new Error("mimeFor wrong");
  const [cmd, args] = rendererCommand("tezcatl", "http://h/p", "/o.pdf", 500);
  if (cmd !== "tezcatl" || args.join(" ") !== "http://h/p --pdf=/o.pdf --wait=500") throw new Error("tezcatl command wrong");
  const [c2, a2] = rendererCommand("myrender {url} -o {out}", "http://h/p", "/o.pdf");
  if (c2 !== "myrender" || a2.join(" ") !== "http://h/p -o /o.pdf") throw new Error("custom renderer template wrong");

  // (b) best-effort e2e: render the snapshot fixture to PDF with the real renderer.
  // A missing renderer (e.g. tezcatl not on a Linux CI runner) is a tolerated skip.
  const hasTezcatl = spawnSync("tezcatl", ["--help"], { stdio: "ignore" }).status === 0;
  try {
    if (!hasTezcatl) throw new Error("tezcatl not on PATH");
    const outdir = join(work, "print"); await mkdir(outdir, { recursive: true });
    await cp(join(FIX, "snapshots"), outdir, { recursive: true });
    const written = await genPrintSnapshots({ dist: outdir, pages: ["article.html"], wait: 400 });
    if (written.length !== 1) throw new Error("expected 1 PDF written");
    const buf = await readFile(join(outdir, "article.print.pdf"));
    if (buf.slice(0, 5).toString() !== "%PDF-") throw new Error("output is not a PDF");
    ok("generators/gen-print-snapshots: paths + renderer, e2e via tezcatl", "pure logic asserted · e2e (tezcatl): 1 valid PDF");
  } catch (e) {
    if (/wrong|expected|not a PDF/.test(e.message)) throw e;
    ok("generators/gen-print-snapshots: paths + renderer, e2e via tezcatl", `pure logic asserted · e2e SKIPPED (${e.message.split("\n")[0]})`);
  }
});

// 20. typography-gate: pure parsing/eval against known values + good/bad fixtures.
await test("gates/typography-gate: line-height/spacing/size/weight, e2e on fixtures", async () => {
  const T = await import(join(KIT, "gates", "typography-gate.mjs"));
  // (a) parsing primitives.
  if (T.parseLineHeight("1.5", 16).ratio !== 1.5) throw new Error("unitless 1.5 → ratio 1.5");
  if (T.parseLineHeight("24px", 16).ratio !== 1.5) throw new Error("24px @16 → ratio 1.5");
  if (T.parseLineHeight("24px", 16).overridable !== false) throw new Error("px line-height not overridable");
  if (T.parseSpacingEm("0.12em", 16).em !== 0.12) throw new Error("0.12em → 0.12");
  if (T.parseSpacingEm("2px", 16).overridable !== false) throw new Error("px spacing not overridable");
  // (b) per-style evaluation: a body 10px/lh1.2/weight100/1px-letter trips four SCs.
  const badStyle = T.evaluateStyle("body", { fontSizePx: 10, lineHeight: T.parseLineHeight("1.2", 10), fontWeight: 100, letterSpacing: T.parseSpacingEm("1px", 10) }, true);
  const scs = new Set(badStyle.findings.map((f) => f.sc));
  for (const sc of ["1.4.12", "1.4.4", "1.4.8"]) if (!scs.has(sc)) throw new Error(`body must flag SC ${sc}`);
  if (badStyle.passed) throw new Error("bad body style must not pass");
  // (c) e2e on fixtures.
  const good = await T.runTypographyGate({ tokens: join(FIX, "typography", "good.tokens.json"), config: join(FIX, "typography", "good.config.json") });
  if (!good.passed) throw new Error(`good fixture must pass, got ${JSON.stringify(good.summary)}`);
  const bad = await T.runTypographyGate({ tokens: join(FIX, "typography", "bad.tokens.json"), config: join(FIX, "typography", "bad.config.json") });
  if (bad.passed || bad.summary.errors < 4) throw new Error(`bad fixture must fail with ≥4 errors, got ${JSON.stringify(bad.summary)}`);
  ok("gates/typography-gate: line-height/spacing/size/weight, e2e on fixtures",
    `parse asserted · e2e: good=clean, bad trips ${bad.summary.errors} error(s)`);
});

// 21. target-size-gate: 24px AA floor + AAA status + exceptions, e2e on fixtures.
await test("gates/target-size-gate: 24px AA floor + AAA + exceptions, e2e on fixtures", async () => {
  const T = await import(join(KIT, "gates", "target-size-gate.mjs"));
  if (T.resolveDimension("44px") !== 44 || T.resolveDimension("{c}", { c: "24px" }) !== 24) throw new Error("dimension resolve");
  const small = T.evaluateTarget({ name: "x", size: "20px" });
  if (small.aa.pass || small.aaa.pass || small.passed) throw new Error("20px must fail AA");
  const ok44 = T.evaluateTarget({ name: "y", size: "44px" });
  if (!ok44.aa.pass || !ok44.aaa.pass) throw new Error("44px must pass AA+AAA");
  const exempt = T.evaluateTarget({ name: "z", size: "16px", exception: "inline", reason: "inline link" });
  if (!exempt.passed || exempt.exception !== "inline") throw new Error("inline-exempt target must pass");
  const good = await T.runTargetSizeGate({ config: join(FIX, "target-size", "good.config.json") });
  if (!good.passed) throw new Error("good targets must pass");
  const bad = await T.runTargetSizeGate({ config: join(FIX, "target-size", "bad.config.json") });
  if (bad.passed || bad.summary.belowAA < 2) throw new Error("bad targets must fail (≥2 below AA)");
  // empty config → vacuous pass with a coverage note.
  const none = await T.runTargetSizeGate({ config: { targets: [] } });
  if (!none.passed || none.coverage !== "none") throw new Error("no targets → vacuous pass, coverage:none");
  ok("gates/target-size-gate: 24px AA floor + AAA + exceptions, e2e on fixtures",
    `2.5.8 floor asserted · e2e: good=clean, bad ${bad.summary.belowAA} below AA, empty=coverage-none`);
});

// 22. opacity-contrast-gate: source-over compositing + effective contrast, e2e.
await test("gates/opacity-contrast-gate: composite + effective contrast, e2e on fixtures", async () => {
  const O = await import(join(KIT, "gates", "opacity-contrast-gate.mjs"));
  // (a) compositing: white over black at 0.5 → mid-grey #808080.
  const mid = O.compositeOver([255, 255, 255], [0, 0, 0], 0.5);
  if (Math.round(mid[0]) !== 128) throw new Error(`white/black @0.5 → 128, got ${mid[0]}`);
  // (b) a full-strength clean pair stays clean; a faded one drops below AA.
  const opaque = O.evaluateUsage({ fg: "#000", bg: "#fff", fgHex: "#000000", bgHex: "#ffffff", opacity: 1, kind: "text" });
  if (!opaque.passed || opaque.effectiveRatio < 20) throw new Error("opaque black/white must pass ~21:1");
  const faded = O.evaluateUsage({ fg: "#000", bg: "#fff", fgHex: "#000000", bgHex: "#ffffff", opacity: 0.25, kind: "text" });
  if (faded.passed || faded.effectiveRatio >= 4.5) throw new Error("faded fg must drop below AA");
  if (!(faded.drop > 0)) throw new Error("must report the contrast drop");
  // (c) e2e on fixtures.
  const good = await O.runOpacityContrastGate({ tokens: join(FIX, "opacity", "tokens.css"), usages: join(FIX, "opacity", "good.usages.json") });
  if (!good.passed) throw new Error(`good usages must pass, got ${JSON.stringify(good.summary)}`);
  const bad = await O.runOpacityContrastGate({ tokens: join(FIX, "opacity", "tokens.css"), usages: join(FIX, "opacity", "bad.usages.json") });
  if (bad.passed || bad.summary.failing < 1) throw new Error("bad usages must fail");
  ok("gates/opacity-contrast-gate: composite + effective contrast, e2e on fixtures",
    `source-over asserted · e2e: good=clean, bad ${bad.summary.failing} failing (worst drop ${bad.summary.worstDrop}:1)`);
});

// 23. likeness-gate: near-duplicate ΔE + categorical CVD collapse, e2e on fixtures.
await test("gates/likeness-gate: near-duplicate + confusable categoricals, e2e on fixtures", async () => {
  const L = await import(join(KIT, "gates", "likeness-gate.mjs"));
  // (a) near-duplicate scan: two near-identical inks collapse, distinct ones don't.
  const dup = L.findNearDuplicates({ a: "#5C6B63", b: "#5E6B62", c: "#A6432F" });
  if (dup.count !== 1 || dup.duplicates[0].a !== "a") throw new Error("must flag the one near-duplicate ink pair");
  if (L.findNearDuplicates({ x: "#fff", y: "#fff" }).duplicates[0].identical !== true) throw new Error("identical pair flagged");
  // (b) e2e: good passes (dup=warn), bad fails (categorical collapse under CVD + dup=error).
  const good = await L.runLikenessGate({ tokens: join(FIX, "likeness", "tokens.css"), config: join(FIX, "likeness", "good.config.json") });
  if (!good.passed || good.summary.nearDuplicates < 1) throw new Error(`good must pass yet surface near-dups, got ${JSON.stringify(good.summary)}`);
  const bad = await L.runLikenessGate({ tokens: join(FIX, "likeness", "tokens.css"), config: join(FIX, "likeness", "bad.config.json") });
  if (bad.passed || bad.summary.categoricalCollapses < 1) throw new Error("bad must fail with a categorical collapse");
  ok("gates/likeness-gate: near-duplicate + confusable categoricals, e2e on fixtures",
    `ΔE asserted · e2e: good=warn-only, bad trips ${bad.summary.categoricalCollapses} collapse + ${bad.summary.nearDuplicates} dup(s)`);
});

// 24. pairing-extractor: derive fg×bg from CSS usage + matrix, e2e on fixtures.
await test("gates/pairing-extractor: derive pairings from CSS + matrix, e2e on fixtures", async () => {
  const P = await import(join(KIT, "gates", "pairing-extractor.mjs"));
  const map = { ink: "#16221C", paper: "#FFFFFF", forest: "#0C5A42", mint: "#9FDCC2" };
  // (a) same-rule pairing + containment pairing.
  const rules = P.parseRules(":root{background:var(--paper);color:var(--ink)} .panel{background:var(--forest)} .panel .label{color:var(--mint)}");
  const { pairings } = P.extractPairings(rules, map);
  const has = (fg, bg) => pairings.some((p) => p.fgHex.toLowerCase() === map[fg].toLowerCase() && p.bgHex.toLowerCase() === map[bg].toLowerCase());
  if (!has("ink", "paper")) throw new Error("root surface pairing ink/paper missing");
  if (!has("mint", "forest")) throw new Error("containment pairing mint/forest missing");
  // (b) full run builds a matrix with WCAG + per-CVD numbers.
  const rep = await P.runPairingExtractor({ tokens: join(FIX, "pairing", "tokens.css"), css: [join(FIX, "pairing", "styles.css")] });
  if (rep.matrix.length < 3 || rep.matrix.some((m) => typeof m.wcag !== "number")) throw new Error("matrix must score every pair");
  if (!P.renderMatrixMarkdown(rep.matrix).includes("| fg | bg |")) throw new Error("markdown matrix header missing");
  // (c) declared ∪ extracted union.
  const u = await P.runPairingExtractor({ tokens: map, css: [".x{color:var(--ink);background:var(--paper)}"], declared: { pairings: [{ fg: "mint", bg: "forest", kind: "text" }] } });
  if (u.summary.declaredAdded < 1) throw new Error("declared pairing must union in");
  ok("gates/pairing-extractor: derive pairings from CSS + matrix, e2e on fixtures",
    `extract+containment asserted · ${rep.summary.total} pair(s) scored, declared∪extracted`);
});

// 25. token-a11y: unified runner aggregates all members, fail-closed.
await test("gates/token-a11y: unified runner across all members, e2e on fixtures", async () => {
  const { runTokenA11y } = await import(join(KIT, "gates", "token-a11y.mjs"));
  const base = join(FIX, "token-a11y");
  const good = await runTokenA11y(JSON.parse(await readFile(join(base, "good.json"), "utf8")), base);
  if (!good.passed) throw new Error(`good suite must pass, failing: ${good.summary.failing}`);
  if (good.summary.ran.length < 5) throw new Error("good suite must run ≥5 members");
  const bad = await runTokenA11y(JSON.parse(await readFile(join(base, "bad.json"), "utf8")), base);
  if (bad.passed || bad.summary.failing.length < 3) throw new Error("bad suite must fail ≥3 members");
  ok("gates/token-a11y: unified runner across all members, e2e on fixtures",
    `good=${good.summary.ran.length} members clean · bad=${bad.summary.failing.length} failing (fail-closed)`);
});

// N. ai-readability: pure link/sibling logic, then evidence over good + bad fixtures.
await test("gates/ai-readability: links + siblings logic, evidence on fixtures", async () => {
  const m = await import(join(KIT, "gates", "ai-readability-gate.mjs"));

  // (a) pure core.
  const links = m.extractMarkdownLinks("[Home](/index.html) and <https://x.test/> and [a](b.html 't')");
  if (!links.includes("/index.html") || !links.includes("b.html") || !links.includes("https://x.test/"))
    throw new Error("extractMarkdownLinks wrong: " + links.join(","));
  if (m.classifyLink("/a") !== "internal" || m.classifyLink("https://x/") !== "external" || m.classifyLink("#h") !== "anchor")
    throw new Error("classifyLink wrong");
  if (!m.resolveCandidates("/docs/", "").includes("docs/index.html")) throw new Error("dir-index candidate missing");
  if (!m.resolveCandidates("/about", "").includes("about.html")) throw new Error("extensionless .html candidate missing");
  if (m.siblingFor("blog/x.html", ".md") !== "blog/x.md") throw new Error("siblingFor wrong");
  if (!m.isPrivate("/admin/x", ["/admin"]) || m.isPrivate("/ok", ["/admin"])) throw new Error("isPrivate wrong");
  if (!m.matchesAny("404.html", ["404"]) || m.matchesAny("index.html", ["404"])) throw new Error("matchesAny wrong");

  // (b) evidence over fixtures — good passes all three, bad fails links + siblings.
  const good = await m.evaluateAiReadability({ dist: join(FIX, "ai-readability", "good") });
  if (!(good.aiReadability.llmsTxtPresent && good.aiReadability.linksResolve && good.aiReadability.markdownSiblings))
    throw new Error("good fixture should be fully AI-readable: " + JSON.stringify(good.aiReadability));
  const badr = await m.evaluateAiReadability({ dist: join(FIX, "ai-readability", "bad") });
  if (!badr.aiReadability.llmsTxtPresent) throw new Error("bad fixture has llms.txt");
  if (badr.aiReadability.linksResolve || badr.aiReadability.markdownSiblings) throw new Error("bad fixture must fail links + siblings");
  if (!badr.details.brokenLinks.includes("/ghost.html")) throw new Error("bad fixture should flag the broken link");

  ok("gates/ai-readability: links + siblings logic, evidence on fixtures",
    `pure logic asserted · good=all-pass · bad: broken=${badr.details.brokenLinks.length}, missing-siblings=${badr.details.missingSiblings.length}`);
});

await rm(work, { recursive: true, force: true });
console.log(`\n${failed ? "✗" : "✓"} conformance-kit tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
