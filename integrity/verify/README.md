# @bounded-systems/verify

Standalone, out-of-page verifier. Given a deployed site URL (or a local `dist/`
directory) carrying a published Sigstore **bundle**, it proves **out of band** that
the served bytes are exactly what an allowed identity built and logged — offline,
no trust in the page itself.

What it checks, in-process via [`sigstore-js`](https://github.com/sigstore/sigstore-js):

- signature over the whole-site manifest;
- certificate chain to the Fulcio root (bundled trusted root — **no network**);
- Rekor inclusion proof (offline; not the deprecated Rekor query API);
- issuer + certificate SAN matched against the site's declared builder identity;
- then re-hashes every served file against the signed manifest, tolerating known,
  named CDN edge transforms (the signed body must still be intact underneath).

## Usage

```sh
# against a deployed site
deno run -A jsr:@bounded-systems/verify https://bounded.tools

# against a local build directory
deno run -A jsr:@bounded-systems/verify ./dist
```

Inputs are read from the target: `provenance.json` (the builder identity — nothing
is hardcoded), the whole-site `site.sha256` manifest, and the `.sigstore.json`
bundle. Exit code `0` on success, `1` on any verification failure.

## Provenance

This package is the canonical Sigstore verifier maintained in
[`bounded-systems/conformance-kit`](https://github.com/bounded-systems/conformance-kit)
at `integrity/verify/`. It is published to JSR keyless via GitHub Actions OIDC — no
long-lived tokens. See the kit README ("Publishing `@bounded-systems/verify`") for
how a release is cut.

MIT
