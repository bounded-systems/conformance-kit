#!/usr/bin/env node
// gen-identity — emit a did:web identity + a résumé (or any JSON subject) as a W3C
// Verifiable Credential 2.0.
//
//   IDENTITY_DOMAIN=example.com IDENTITY_REPO=owner/repo \
//     node generators/gen-identity.mjs
//
// Writes:
//   $DIST/.well-known/did.json     — minimal did:web:<DOMAIN> document
//   $DIST/api/v1/resume.vc.json    — the subject as a W3C VC 2.0; credentialSubject
//                                    is the input JSON verbatim, issuer is the did
//
// Keyless by design: there is no held signing key. The VC's proof is an ENVELOPING
// Sigstore bundle minted in CI (cosign sign-blob → Fulcio cert from the GitHub
// Actions OIDC identity → Rekor), served alongside as resume.vc.json.sigstore.json.
// So the did:web document advertises the Sigstore verification path as a service
// rather than a static public key — bound to $IDENTITY_REPO's OIDC identity.
//
// Site-agnostic injection:
//   $IDENTITY_DOMAIN          domain for the DID + site origin (required).
//   $IDENTITY_REPO            "owner/repo" for the cert-identity regexp (required).
//   $DIST                     output dir (default: cwd/dist).
//   $IDENTITY_SUBJECT         path to the credentialSubject JSON (default:
//                             $DIST/resume.json).
//   $IDENTITY_SUBJECT_SCHEMA  optional JSON Schema the subject must satisfy
//                             (validated with the kit's schema-validate.mjs).
//   $IDENTITY_VC_NAME         VC `name` (default: "<subject.basics.name> — Résumé").
//   $IDENTITY_VC_DESCRIPTION  VC `description` (default: generic).
//   $IDENTITY_VALID_FROM_PATH dotted path into the subject for validFrom (default:
//                             "meta.lastModified"); omitted if absent.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateSchema } from "../lib/schema-validate.mjs";

const DOMAIN = process.env.IDENTITY_DOMAIN;
const REPO = process.env.IDENTITY_REPO;
if (!DOMAIN || !REPO) { console.error("✗ gen-identity: IDENTITY_DOMAIN and IDENTITY_REPO are required"); process.exit(2); }

const dist = resolve(process.cwd(), process.env.DIST || "dist");
const SITE = `https://${DOMAIN}`;
const DID = `did:web:${DOMAIN}`;
const subjectPath = process.env.IDENTITY_SUBJECT || join(dist, "resume.json");
const validFromPath = process.env.IDENTITY_VALID_FROM_PATH || "meta.lastModified";

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const writeJson = async (p, obj) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(obj, null, 2) + "\n"); };
const dotGet = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

const subject = await readJson(subjectPath);
const subjectName = subject?.basics?.name || DOMAIN;
const vcName = process.env.IDENTITY_VC_NAME || `${subjectName} — Résumé`;
const vcDescription = process.env.IDENTITY_VC_DESCRIPTION ||
  `Issued as a Verifiable Credential. The cryptographic proof is an enveloping Sigstore bundle served alongside (resume.vc.json.sigstore.json), keyless and bound to the source repo's GitHub Actions OIDC identity.`;

// ---- did:web document --------------------------------------------------------
// Minimal + honest: no verificationMethod, because there is no held key. The
// assertion path is keyless Sigstore (Fulcio/Rekor), surfaced as a service so a
// verifier knows exactly how to check a credential this DID issues.
const did = {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/jws-2020/v1",
  ],
  id: DID,
  controller: DID,
  alsoKnownAs: [SITE, `${SITE}/`],
  service: [
    { id: `${DID}#resume`, type: "VerifiableCredentialService", serviceEndpoint: `${SITE}/api/v1/resume.vc.json` },
    { id: `${DID}#profile`, type: "LinkedDomains", serviceEndpoint: SITE },
    {
      id: `${DID}#sigstore`,
      type: "SigstoreKeylessVerification",
      serviceEndpoint: {
        oidcIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentityRegexp: `^https://github.com/${REPO}/`,
        transparencyLog: "https://rekor.sigstore.dev",
        note: "Credentials are signed with an enveloping Sigstore bundle (e.g. resume.vc.json.sigstore.json), not an embedded key proof.",
      },
    },
  ],
};

// ---- subject as a Verifiable Credential 2.0 ---------------------------------
// credentialSubject is the input JSON VERBATIM (so it keeps satisfying any schema
// it was built against). validFrom is a content fact (a dotted path into the
// subject), never a wall clock — keeps the VC deterministic.
const validFrom = dotGet(subject, validFromPath);
const vc = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  id: `${SITE}/api/v1/resume.vc.json`,
  type: ["VerifiableCredential"],
  issuer: DID,
  ...(validFrom ? { validFrom } : {}),
  name: vcName,
  description: vcDescription,
  credentialSubject: subject,
};

await writeJson(join(dist, ".well-known", "did.json"), did);
await writeJson(join(dist, "api", "v1", "resume.vc.json"), vc);

// ---- self-checks -------------------------------------------------------------
if (process.env.IDENTITY_SUBJECT_SCHEMA) {
  const schema = await readJson(process.env.IDENTITY_SUBJECT_SCHEMA);
  const errs = validateSchema(schema, vc.credentialSubject);
  if (errs.length) {
    console.error("✗ VC credentialSubject no longer satisfies its schema:");
    for (const e of errs) console.error(`    ${e}`);
    process.exit(1);
  }
}
const vcErrs = [];
if (vc["@context"]?.[0] !== "https://www.w3.org/ns/credentials/v2") vcErrs.push("missing/!first VC 2.0 @context");
if (!Array.isArray(vc.type) || !vc.type.includes("VerifiableCredential")) vcErrs.push("type must include VerifiableCredential");
if (!vc.issuer) vcErrs.push("missing issuer");
if (!vc.credentialSubject) vcErrs.push("missing credentialSubject");
if (did.id !== DID) vcErrs.push("did id mismatch");
if (vcErrs.length) { console.error("✗ identity documents malformed:"); for (const e of vcErrs) console.error(`    ${e}`); process.exit(1); }

console.log(`✓ identity: ${DID} → .well-known/did.json · VC 2.0 → api/v1/resume.vc.json (keyless-signed in CI)`);
