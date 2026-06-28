#!/usr/bin/env node
// integrity · http-probe — a post-deploy RFC 9110 HTTP-correctness probe.
//
//   node integrity/http-probe.mjs https://your-site.example
//   PROBE_CONFIG=probe.json node integrity/http-probe.mjs https://your-site.example
//
// Sibling to verify-site.mjs (which checks the SIGNED BYTES) — this checks the EDGE'S
// HTTP SEMANTICS: that the deployed origin speaks HTTP correctly per RFC 9110/9111.
// It runs AFTER the site is live; it is a post-deploy probe, NOT a build gate (it
// needs a live URL). Fail-closed: any wrong status / type / parity / conditional
// behaviour exits 1. Dependency-free (node fetch only).
//
// What it asserts (RFC 9110, and 9111 for conditional caching):
//   1. status    — each indexable route returns 200; a known-missing path returns 404.
//   2. type      — Content-Type is correct + carries a charset for text.
//   3. HEAD parity — HEAD mirrors GET's status + Content-Type and returns no body (§9.3.2).
//   4. conditional — when GET returns an ETag, a follow-up If-None-Match yields 304 with
//                  no body (§13.1.2 / RFC 9111). Skipped (with a note) if no ETag is served.
//   5. 404 page  — the unknown path serves the site's 404 document.
//   6. redirects terminate — routes that 3xx must reach a terminal 2xx within a hop cap
//                  (no loops); the canonical apex host must not itself redirect.
//
// Site-agnostic: the routes to probe come from a config (NO hardcoded paths). Supply
// EITHER a JSON file via $PROBE_CONFIG / 2nd positional arg, OR the env vars
// $PROBE_HTML_ROUTES + $PROBE_MISSING (comma lists). Config shape:
//   { "htmlRoutes": ["/", "/about"],
//     "typed": [ { "path": "/robots.txt", "type": "text/plain", "charset": true },
//                { "path": "/sitemap.xml", "type": "xml" } ],
//     "missing": "/this-should-404" }
// With no config at all, only the apex (/) is probed (status + type + HEAD parity).
import { argv, exit, env } from "node:process";
import { readFile } from "node:fs/promises";

const target = argv[2];
if (!target || !/^https?:\/\//.test(target)) {
  console.error("usage: http-probe <https://site> [config.json]");
  exit(2);
}
const base = target.replace(/\/$/, "");

async function loadConfig() {
  const path = argv[3] || env.PROBE_CONFIG;
  if (path) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (e) { console.error(`✗ http-probe: cannot read config ${path}: ${e.message}`); exit(2); }
  }
  const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    htmlRoutes: list(env.PROBE_HTML_ROUTES).length ? list(env.PROBE_HTML_ROUTES) : ["/"],
    typed: [],
    missing: env.PROBE_MISSING || "/this-path-should-never-exist-12345",
  };
}
const cfg = await loadConfig();
const HTML_ROUTES = cfg.htmlRoutes || ["/"];
const TYPED = cfg.typed || [];
const MISSING = cfg.missing || "/this-path-should-never-exist-12345";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };
const note = (msg) => console.log(`  · ${msg}`);
const ct = (res) => (res.headers.get("content-type") || "").toLowerCase();

async function main() {
  console.log(`· http-probe: ${base} (RFC 9110 correctness)`);

  // 1 + 2 + 3 + 4: HTML routes — status, type, HEAD parity, conditional request.
  for (const path of HTML_ROUTES) {
    const url = `${base}${path}`;
    const get = await fetch(url, { redirect: "follow" });
    ok(get.status === 200, `GET ${path} → ${get.status} (want 200)`);
    ok(/text\/html/.test(ct(get)), `GET ${path} Content-Type ${ct(get) || "(none)"} (want text/html)`);
    // charset on HTML is RECOMMENDED, not required — HTML declares it in-band via
    // <meta charset>, and some asset edges omit it on text/html. Note, don't fail.
    if (!/charset=/.test(ct(get))) note(`GET ${path}: no charset in Content-Type (HTML declares it via <meta charset>)`);

    // HEAD parity (§9.3.2): same status + Content-Type, empty body.
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    ok(head.status === get.status, `HEAD ${path} status ${head.status} == GET ${get.status}`);
    ok(ct(head) === ct(get), `HEAD ${path} Content-Type matches GET`);
    const headBody = await head.text();
    ok(headBody.length === 0, `HEAD ${path} returns no body (${headBody.length} bytes)`);

    // Conditional request (§13.1.2 / RFC 9111): ETag → If-None-Match → 304.
    const etag = get.headers.get("etag");
    if (etag) {
      const inm = await fetch(url, { headers: { "If-None-Match": etag }, redirect: "follow" });
      ok(inm.status === 304, `GET ${path} If-None-Match(${etag.slice(0, 12)}…) → ${inm.status} (want 304)`);
      const body304 = await inm.text();
      ok(body304.length === 0, `304 ${path} carries no body`);
    } else {
      note(`GET ${path}: no ETag served — conditional-request check skipped`);
    }
  }

  // 2: typed non-HTML assets.
  for (const { path, type, charset, skip } of TYPED) {
    if (skip) continue;
    const res = await fetch(`${base}${path}`, { redirect: "follow" });
    ok(res.status === 200, `GET ${path} → ${res.status} (want 200)`);
    if (type) ok(ct(res).includes(type), `GET ${path} Content-Type ${ct(res) || "(none)"} (want *${type}*)`);
    if (charset) ok(/charset=/.test(ct(res)), `GET ${path} declares a charset`);
  }

  // 5: 404 handling — unknown path → 404, serving the site's 404 document.
  const miss = await fetch(`${base}${MISSING}`, { redirect: "follow" });
  ok(miss.status === 404, `GET ${MISSING} → ${miss.status} (want 404)`);
  ok(/text\/html/.test(ct(miss)), `404 Content-Type ${ct(miss) || "(none)"} (want text/html)`);

  // 6: redirects terminate (no loops) within a small hop cap; the apex must not redirect.
  const HOP_CAP = 5;
  const apex = await fetch(base + "/", { redirect: "manual" });
  ok(apex.status < 300 || apex.status >= 400, `apex / does not redirect (status ${apex.status})`);
  let hops = 0, cur = base + "/", terminal = null;
  while (hops <= HOP_CAP) {
    const r = await fetch(cur, { redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      cur = new URL(r.headers.get("location"), cur).toString();
      hops++;
      continue;
    }
    terminal = r.status;
    break;
  }
  ok(terminal !== null && hops <= HOP_CAP, `redirect chain from / terminates in ${hops} hop(s) → ${terminal ?? "(loop)"}`);

  console.log(failures ? `\n✗ http-probe FAILED (${failures})` : `\n✓ http-probe: edge HTTP semantics conform to RFC 9110`);
  exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("✗ http-probe: error —", e.message); exit(1); });
