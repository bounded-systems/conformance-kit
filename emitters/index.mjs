// emitters — pure helpers for the standards-compliant build artifacts a site's
// own build.mjs emits. Each is a PURE FUNCTION of injected config; nothing here
// reads a site's content model, so the actual copy/data stays in the consumer.
// Extracted from the emitters embedded in bdelanghe/site/build.mjs.
import { createHash } from "node:crypto";

// RFC 9530 representation digest: sha-256 of a doc's exact served bytes, as a
// structured-field byte sequence — `sha-256=:<base64>:`. Compute over the bytes the
// build itself writes (self-contained), per canonical document, then add as a
// `Repr-Digest:` response header for that route.
export const reprDigest = (buf) =>
  "sha-256=:" + createHash("sha256").update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).digest("base64") + ":";

// RFC 9116 /.well-known/security.txt — a machine-readable security-contact channel.
//   securityTxt({ contact, canonical, expires, preferredLanguages })
// `contact` is one or more mailto:/https: values; `expires` is an ISO timestamp (a
// year out from the build date is the convention, so a weekly rebuild rolls it
// forward and it never goes stale).
export function securityTxt({ contact, canonical, expires, preferredLanguages = ["en"] } = {}) {
  if (!contact) throw new Error("securityTxt: `contact` is required (mailto: or https: URL)");
  if (!expires) throw new Error("securityTxt: `expires` (ISO timestamp) is required");
  const contacts = Array.isArray(contact) ? contact : [contact];
  const lines = [
    ...contacts.map((c) => `Contact: ${c}`),
    `Expires: ${expires}`,
    ...(canonical ? [`Canonical: ${canonical}`] : []),
    ...(preferredLanguages?.length ? [`Preferred-Languages: ${preferredLanguages.join(", ")}`] : []),
  ];
  return lines.join("\n") + "\n";
}

// `expires` one year out from a reference date (ISO string), the security.txt convention.
export const securityTxtExpires = (fromISO = new Date().toISOString()) => {
  const d = new Date(fromISO);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
};

// W3C Web App Manifest (no service worker). All values injected by the consumer —
// typically from its design tokens so the <head> theme-color and the manifest can't
// drift. Returns the manifest object; the caller JSON.stringifies + writes it to
// /site.webmanifest and serves it as `application/manifest+json`.
export function webManifest({
  name, shortName, description,
  themeColor, backgroundColor,
  display = "standalone", startUrl = "/", icons = [],
} = {}) {
  if (!name) throw new Error("webManifest: `name` is required");
  return {
    name,
    ...(shortName ? { short_name: shortName } : { short_name: name.split(" ")[0] }),
    ...(description ? { description } : {}),
    ...(themeColor ? { theme_color: themeColor } : {}),
    ...(backgroundColor ? { background_color: backgroundColor } : {}),
    display,
    start_url: startUrl,
    icons,
  };
}

// The Cloudflare-_headers Content-Type rules a site needs once it serves Markdown
// siblings (/index.md, /resume.md, /blog/<slug>.md) + a web app manifest. Returned
// as a string a consumer concatenates into its own _headers file. The Markdown
// SIBLING CONTENT itself (rendering a page to text/markdown) is the site's job —
// only the serving rule is generic.
export const markdownSiblingHeaders = () =>
  `/*.md\n  Content-Type: text/markdown; charset=utf-8\n` +
  `/site.webmanifest\n  Content-Type: application/manifest+json; charset=utf-8\n`;
