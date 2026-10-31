# Retained read evidence

The files in `fixtures/` and `docs/` are byte-for-byte copies of sanitized retained material from the approved evidence pack.
The original pack records their relative paths and SHA-256 values in its manifest.json.
The B1.1 verification entry point checks its expected hashes in [scripts/verify.py](../scripts/verify.py) before using this material.
No private planning notes or original cluster identities are included.

P-001 through P-012 are sanitized observations, replayed here through a fake API.
They do not establish live product verification.
The minimal discovery payloads in test/fake_api.py are new synthetic variants, not additional observations.
The B2 TypeScript harness adds synthetic resource discovery, a custom resource, OpenAPI v3, named objects, namespace decoys, denial, expiry, malformed-body and timeout responses.
The two retained metrics success fixtures are synthetic and remain separate from the observed metrics 404 in P-009.
Additional empty pages terminate native kubectl pagination; compact reads preserve the first retained continuation without consuming it.
[fixture-hashes.json](fixture-hashes.json) locks every retained B2 envelope and is checked by [test/b2.ts](../test/b2.ts) before replay.

[linux-read-gate.md](linux-read-gate.md) records the packaged standalone and hosted Linux verification evidence.
