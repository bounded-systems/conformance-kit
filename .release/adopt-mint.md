---
bump: minor
---
adopt @bounded-systems/mint for versioning + signed release provenance: per-PR `.release/` intents → `mint version` → signed `v*` tag, replacing the hand-edited package.json version + the publish-branch fast-forward (the npm registry publish is unchanged)
