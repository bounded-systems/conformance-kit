---
bump: minor
---
`ck-shacl-runner` accepts a dataset directly via `--turtle <file>` / `--jsonld <file>`, not only a directory of built HTML — so artifacts that were never a website (a database mirror, an export, a manifest) can use the same shapes, validator and exit codes. The HTML path is unchanged. Also adds the gate's first failing-case test: a violating fixture that must exit 1 with both violations named, because a gate never observed failing is indistinguishable from one that cannot fail.
