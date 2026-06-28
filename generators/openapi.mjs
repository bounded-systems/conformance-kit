// generators/openapi.mjs — the GENERIC, reusable core of a static-API generator.
//
// A site's static JSON API is intrinsically site-specific (its endpoints project
// THAT site's contracts: profile, posts, corpus, a résumé VC, …). So the per-endpoint
// projection stays in the consuming site's build. What IS reusable — and lives here —
// is the machinery around it:
//
//   sortKeys(value)              deterministic byte output: recursively sort object
//                                keys (arrays keep order).
//   writeApiFile(apiDir, rel, obj, {sort})
//                                write a JSON file under the API tree (mkdir -p),
//                                key-sorted by default, with a trailing newline.
//   embedSchema(schema)          strip $schema/$id so a JSON-Schema component can be
//                                embedded under an OpenAPI components/schemas entry
//                                whose internal "#/…" refs resolve at the document root.
//   jsonResponse(ref)            a 200 application/json response referencing a schema.
//   validateOpenapi(openapi)     OpenAPI 3.1/3.2 well-formedness: version, info, ≥1
//                                path, every operation carries responses, every local
//                                "#/components/…" $ref resolves. Returns string[]
//                                (empty = well-formed).
//
// Pair with lib/schema-validate.mjs to self-check that each emitted document
// validates against the schema its OpenAPI operation advertises. Zero deps.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : (v && typeof v === "object") ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

export const writeApiFile = async (apiDir, rel, obj, { sort = true } = {}) => {
  const p = join(apiDir, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(sort ? sortKeys(obj) : obj, null, 2) + "\n");
  return p;
};

// Strip the dialect ($schema) + identity ($id) keys so an embedded component's own
// "#/…" pointers resolve against the OpenAPI document root. Resources with internal
// JSON-pointer refs (e.g. draft-04 "#/definitions/…") should re-add an $id by the
// caller so those refs resolve WITHIN the embedded resource.
export const embedSchema = (s) => { const { $schema, $id, ...rest } = s; return rest; };

export const jsonResponse = (ref) => ({ description: "OK", content: { "application/json": { schema: { $ref: ref } } } });

export function validateOpenapi(openapi) {
  const errs = [];
  if (!/^3\.[12]\.\d+$/.test(openapi.openapi || "")) errs.push(`openapi version ${openapi.openapi} is not 3.1/3.2`);
  if (!openapi.info?.title || !openapi.info?.version) errs.push("info.title/version missing");
  if (!openapi.paths || !Object.keys(openapi.paths).length) errs.push("no paths");
  const refs = new Set();
  JSON.stringify(openapi, (k, v) => { if (k === "$ref" && typeof v === "string" && v.startsWith("#/")) refs.add(v); return v; });
  for (const [p, ops] of Object.entries(openapi.paths || {})) for (const [m, op] of Object.entries(ops)) if (!op.responses) errs.push(`${m.toUpperCase()} ${p} has no responses`);
  // Only OpenAPI-level component refs resolve against the document root; schema-internal
  // JSON-pointer refs (e.g. "#/definitions/…") resolve within their own $id'd resource.
  for (const ref of [...refs].filter((r) => r.startsWith("#/components/"))) {
    const node = ref.replace(/^#\//, "").split("/").reduce((o, seg) => o?.[seg], openapi);
    if (node == null) errs.push(`dangling $ref ${ref}`);
  }
  return errs;
}
