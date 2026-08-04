---
bump: minor
---
`ck-shacl-runner` now executes SHACL-SPARQL constraints. The previous validator (`rdf-validate-shacl`) threw `Cannot find validator for constraint component sh#SPARQLConstraintComponent` on any `sh:sparql` shape at every version, so cross-row invariants — referential agreement, acyclicity, "this status implies that relationship" — could not be enforced at all; only per-node structure could. Swapped to `shacl-engine` (same RDF/JS stack, same `@zazuko/env-node` the kit already uses) with its SPARQL validations and target resolvers enabled, plus a required-to-fail cyclic fixture so that opt-in cannot be dropped silently. Report output and exit codes are unchanged.
