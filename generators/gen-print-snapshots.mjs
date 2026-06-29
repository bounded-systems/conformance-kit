#!/usr/bin/env node
// Printed-view snapshot generator — the print/PDF twin of gen-snapshots (which does
// the headless reader/Markdown view). For every built page it renders the page's
// `@media print` view to a durable `<page>.print.pdf`, so the printed artifact is
// archived + content-addressable alongside the served bytes.
//
// Unlike the reader view, a PDF needs a real print-CSS renderer. The default is
// `tezcatl` (macOS-native WebKit, no Chromium download) — the same engine the kit's
// axe gate uses locally. So this generator is a LOCAL / macOS-deploy artifact: on a
// host without the renderer (e.g. a Linux CI runner) it SKIPS with a clear note.
//
//   node generators/gen-print-snapshots.mjs [distDir]
//
// Config-driven; NOTHING about any one site is hard-coded:
//   argv / $PRINT_DIST        built output dir                  (default: "dist")
//   $PRINT_PAGES             comma list of page paths under dist (default: every *.html)
//   $PRINT_RENDERER          renderer command                  (default: "tezcatl")
//   $PRINT_WAIT              ms to let JS/layout settle         (default: 600)
//   $PRINT_SUFFIX            output basename suffix             (default: ".print")
//
// The pure path/arg functions are exported for unit testing without a renderer.
import { readdir, access, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { resolve, join, relative, dirname, basename, extname } from "node:path";

// ── Pure core (renderer-free; unit-testable) ─────────────────────────────────

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ico": "image/x-icon", ".txt": "text/plain",
};
export const mimeFor = (p) => MIME[extname(p).toLowerCase()] || "application/octet-stream";

/** Output PDF path for a built page: dist/blog/x.html → dist/blog/x.print.pdf. */
export function pdfOutPath(file, suffix = ".print") {
  return join(dirname(file), basename(file, extname(file)) + suffix + ".pdf");
}

/** The renderer command + args. Pure: (renderer, url, out, wait) → [cmd, args]. */
export function rendererCommand(renderer, url, out, wait = 600) {
  if (renderer === "tezcatl") return ["tezcatl", [url, `--pdf=${out}`, `--wait=${wait}`]];
  // A custom $PRINT_RENDERER is a command template: "cmd {url} {out}".
  const parts = renderer.split(/\s+/).map((t) => t.replace("{url}", url).replace("{out}", out).replace("{wait}", String(wait)));
  return [parts[0], parts.slice(1)];
}

// ── Impure: static origin + renderer ─────────────────────────────────────────

/** Serve `root` over an ephemeral localhost origin so absolute asset paths resolve. */
function startServer(root) {
  return new Promise((res) => {
    const server = createServer(async (req, res2) => {
      try {
        let p = join(root, decodeURIComponent((req.url || "/").split("?")[0]));
        try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch { p = join(root, "404.html"); }
        res2.writeHead(200, { "content-type": mimeFor(p) });
        res2.end(readFileSync(p));
      } catch { res2.writeHead(404); res2.end(); }
    });
    server.listen(0, "127.0.0.1", () => res({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

function render(renderer, url, out, wait) {
  const [cmd, args] = rendererCommand(renderer, url, out, wait);
  return new Promise((res, rej) => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr.on("data", (d) => (err += d));
    ch.on("error", (e) => rej(new Error(`renderer "${cmd}" not runnable (on PATH?): ${e.message}`)));
    ch.on("close", (code) => (code === 0 ? res() : rej(new Error(`renderer "${cmd}" exit ${code}: ${err.trim().slice(0, 200)}`))));
  });
}

async function walkHtml(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkHtml(p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** Render each page → PDF. Exposed for programmatic use. */
export async function genPrintSnapshots({ dist, pages, renderer = "tezcatl", wait = 600, suffix = ".print" }) {
  const distAbs = resolve(dist);
  const files = pages && pages.length ? pages.map((p) => resolve(distAbs, p)) : (await walkHtml(distAbs)).sort();
  const { origin, close } = await startServer(distAbs);
  const written = [];
  try {
    for (const file of files) {
      const rel = relative(distAbs, file);
      const out = pdfOutPath(file, suffix);
      await render(renderer, `${origin}/${rel}`, out, wait);
      written.push(relative(distAbs, out));
    }
  } finally { close(); }
  return written;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const distArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const dist = resolve(distArg || process.env.PRINT_DIST || "dist");
  const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
  if (!(await exists(dist))) { console.error(`✗ gen-print-snapshots: ${dist} not found — build first.`); process.exit(2); }

  const renderer = (process.env.PRINT_RENDERER || "tezcatl").trim();
  const wait = Number.parseInt(process.env.PRINT_WAIT ?? "600", 10);
  const suffix = process.env.PRINT_SUFFIX || ".print";
  const pages = (process.env.PRINT_PAGES || "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean);

  // Renderer present? If not, SKIP (this is a local/macOS-deploy artifact, not CI).
  const cmd0 = rendererCommand(renderer, "", "", wait)[0];
  if (spawnSync(cmd0, ["--help"], { stdio: "ignore" }).error) {
    console.log(`✓ gen-print-snapshots: renderer "${cmd0}" not on PATH — SKIPPED (run on a host with it, e.g. macOS + tezcatl).`);
    return;
  }

  const written = await genPrintSnapshots({ dist, pages, renderer, wait, suffix });
  for (const w of written) console.log(`  ✓ ${w}`);
  console.log(`✓ gen-print-snapshots: ${written.length} printed PDF snapshot(s) via ${cmd0}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("✗ gen-print-snapshots: error —", e.stack || e.message); process.exit(1); });
}
