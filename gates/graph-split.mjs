#!/usr/bin/env node
// graph-split — an IA QUERY over a JSON-LD @graph, not a gate. It answers "what
// subtree can move to its own page?" mechanically: a cluster of nodes whose @id
// references all stay INSIDE the cluster (or point at shared anchors like the
// site/org root) is CLOSED — it lifts out to a standalone page with no dangling
// links. Turns a taste call into a query.
//
//   node gates/graph-split.mjs <doc.json.ld>            # report clusters + closure
//   node gates/graph-split.mjs <doc.json.ld> --json     # machine-readable
//
// Site-agnostic. Anchors (nodes every cluster may reference and still be closed —
// the org/site root, a shared context) auto-detected as the most-referenced nodes,
// overridable with $GRAPH_ANCHORS (comma list of @id or #fragment).
import { readFile } from "node:fs/promises";

const path = process.argv[2];
const asJson = process.argv.includes("--json");
if (!path) {
  console.error("usage: graph-split <doc.json.ld> [--json]");
  process.exit(2);
}

const doc = JSON.parse(await readFile(path, "utf8"));
const graph = Array.isArray(doc["@graph"]) ? doc["@graph"] : [doc];
const nodes = new Map(); // @id -> node
for (const n of graph) if (n["@id"]) nodes.set(n["@id"], n);

// collect every @id a node references (anywhere in its properties)
function refsOf(node) {
  const out = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v["@id"] === "string" && v["@id"] !== node["@id"]) out.add(v["@id"]);
      for (const [k, val] of Object.entries(v)) if (k !== "@id") walk(val);
    }
  };
  for (const [k, v] of Object.entries(node)) if (k !== "@id") walk(v);
  return [...out].filter((id) => nodes.has(id)); // only intra-graph refs
}

const refs = new Map([...nodes].map(([id, n]) => [id, refsOf(n)]));

// anchors: nodes referenced by many others (the hub) — a cluster may point at them
// and still be "closed" (a shared root doesn't create a dangling page link).
const inDeg = new Map([...nodes.keys()].map((id) => [id, 0]));
for (const rs of refs.values()) for (const r of rs) inDeg.set(r, inDeg.get(r) + 1);
const envAnchors = (process.env.GRAPH_ANCHORS || "").split(",").map((s) => s.trim()).filter(Boolean);
const anchors = new Set(
  envAnchors.length
    ? [...nodes.keys()].filter((id) => envAnchors.some((a) => id === a || id.endsWith(a)))
    : [...inDeg.entries()].filter(([, d]) => d >= Math.max(3, nodes.size * 0.4)).map(([id]) => id),
);

// connected components over non-anchor nodes, edges = refs that aren't to anchors
const nonAnchor = [...nodes.keys()].filter((id) => !anchors.has(id));
const adj = new Map(nonAnchor.map((id) => [id, new Set()]));
for (const id of nonAnchor) {
  for (const r of refs.get(id)) {
    if (anchors.has(r)) continue;
    adj.get(id).add(r);
    if (adj.has(r)) adj.get(r).add(id); // undirected for clustering
  }
}
const seen = new Set();
const clusters = [];
for (const id of nonAnchor) {
  if (seen.has(id)) continue;
  const stack = [id], comp = [];
  seen.add(id);
  while (stack.length) {
    const c = stack.pop();
    comp.push(c);
    for (const nb of adj.get(c)) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  clusters.push(comp);
}

// a cluster is CLOSED (splittable) if every ref from its members stays in the
// cluster or points at an anchor.
const report = clusters.map((members) => {
  const set = new Set(members);
  const escapes = [];
  for (const m of members) {
    for (const r of refs.get(m)) {
      if (!set.has(r) && !anchors.has(r)) escapes.push(`${short(m)}→${short(r)}`);
    }
  }
  return {
    size: members.length,
    closed: escapes.length === 0,
    label: labelOf(members),
    members: members.map(short),
    escapes,
  };
}).sort((a, b) => b.size - a.size);

function short(id) {
  return id.replace(/^.*[#/]/, "") || id;
}
function labelOf(members) {
  const types = members.map((m) => nodes.get(m)["@type"]).filter(Boolean);
  const t = [...new Set(types.flat())][0] || "nodes";
  return `${members.length}× ${t}`;
}

if (asJson) {
  console.log(JSON.stringify({ anchors: [...anchors].map(short), clusters: report }, null, 2));
  process.exit(0);
}
console.log(`graph-split: ${nodes.size} nodes · anchors: ${[...anchors].map(short).join(", ") || "(none)"}\n`);
console.log(`${report.length} cluster(s) — a CLOSED one can move to its own page:\n`);
for (const c of report) {
  const mark = c.closed ? "✅ closed  " : "⚠  escapes ";
  console.log(`  ${mark} ${c.label} — {${c.members.slice(0, 8).join(", ")}${c.members.length > 8 ? ", …" : ""}}`);
  if (!c.closed) console.log(`             would dangle: ${c.escapes.slice(0, 4).join(", ")}`);
}
