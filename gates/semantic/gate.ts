// gates/semantic/gate.ts — bless each rendered page's DOM with lone (semantic HTML
// + a11y). Blocking: any error-severity finding fails CI. Run from the site root
// after the build. lone is consumed from JSR (jsr:@bounded-systems/lone), pinned by
// deno.lock — no git clone, no hand-managed sha (see deno.json import map).
//
//   deno run --allow-read --allow-net gates/semantic/gate.ts
//
// Site-agnostic injection (Deno.env, both optional):
//   $SEMANTIC_DIR       directory of built HTML to bless (default "dist/blog").
//   $SEMANTIC_SELECTOR  CSS selector for the subject node to validate per page,
//                       falling back to <body> (default "article").
import { parseHTML } from "linkedom";
import { validate } from "@bounded-systems/lone";

const DIR = Deno.env.get("SEMANTIC_DIR") ?? "dist/blog";
const SELECTOR = Deno.env.get("SEMANTIC_SELECTOR") ?? "article";

let posts = 0, errors = 0, warns = 0;
for await (const e of Deno.readDir(DIR)) {
  if (!e.name.endsWith(".html")) continue;
  posts++;
  const { document } = parseHTML(await Deno.readTextFile(`${DIR}/${e.name}`));
  const subject = document.querySelector(SELECTOR) ?? document.body;
  const { findings } = await validate(subject);
  const errs = findings.filter((f) => f.severity === "error");
  errors += errs.length;
  warns += findings.length - errs.length;
  if (findings.length) {
    console.log(`\n${e.name} — ${errs.length} error(s), ${findings.length - errs.length} warn(s):`);
    for (const f of findings) console.log(`  [${f.severity}] ${f.code} ${f.path} — ${f.message}`);
  } else console.log(`${e.name} — clean`);
}
console.log(`\nlone: ${posts} page(s) · ${errors} error(s) · ${warns} warn(s)`);
Deno.exit(errors > 0 ? 1 : 0);
