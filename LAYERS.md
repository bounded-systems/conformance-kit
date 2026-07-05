# Check layers — validate the new shape, trust the layer below

A site is a stack of abstractions. Each layer introduces **one new shape** on top
of the layer beneath it. The discipline: **every gate validates only the shape its
layer adds, and assumes the layer below is already guaranteed.** No gate
re-validates a lower abstraction — that would be redundant at best and a source of
conflicting verdicts at worst. Every shape is covered exactly once.

```
0. proof/evidence   grounding.json · attested-claims · worklog   ── ground truth
1. string tokens    strings.json {$value,$description}           ── named copy, grounded
2. json-ld knowledge  the @graph                                 ── semantic shape over data
3. markdown composed  blog/*.md, docs                            ── composed prose
4. website          rendered dist/ HTML                          ── the surface
```

| Layer | New shape | Gates (this repo) that own it | Trusts (never re-checks) |
|---|---|---|---|
| **0 proof** | grounded facts, PII-guarded, append-only | *(owned by the evidence repo — worklog)* | — |
| **1 tokens** | copy atoms `{value, desc}` | `token-grounding` (every figure-claim traces to proof) | proof is true |
| **2 json-ld** | RDF entities + relations | `shacl-runner` | the token *values* — checks structure, not copy |
| **3 markdown** | a composed document | `doc-scope`, `grammar-repetition`, `claim-discipline`, `readability`, `ai-readability`, `cognitive/focus-budget`, `commonmark` | tokens grounded · graph valid |
| **4 website** | rendered DOM | `axe`, `a11y-heuristic`, `html-validator`, `seo`, `css-purity`, `palette`, `opacity-contrast`, `semantic` | the prose · the graph |
| *orthogonal* | supply chain / brand | `sbom`, `vuln`, `likeness`, `jargon` | cross-cutting; not a layer |

## Purity rules (how to keep a gate in its layer)

- **A gate takes its layer's artifact as input, not a rendered lower/upper one.**
  Prose gates read the composed markdown corpus; they do **not** parse `dist/` HTML
  to re-judge the page. Website gates read `dist/`; they do **not** grade prose.
- **`doc-scope` judges documents, not pages.** A landing page is a website-layer
  shape (many sections by design); running one-topic/length on it is a layer
  violation. Feed it the composed-docs corpus only.
- **`claim-discipline` is word-choice on the atom**, at the token or prose layer —
  it does not check whether a claim is *true* (that's grounding, layer 1) or
  *proven* (layer 0).
- **`shacl-runner` checks graph structure**, never the copy inside a node.
- When a new gate is added, record its layer here. A gate that needs two layers'
  inputs is a smell — split it.
