# Migrate Guardian consumers from Core 0.1.0 to 0.1.1

This guide applies to Guardian's exact Core dependency recorded in [`contract-compatibility.md`](../contract-compatibility.md). Core package SemVer and the Architecture Model/JSON contract versions are not interchangeable.

## Architecture models

Change only the root model version:

```diff
-version: "0.1.0"
+version: "0.1.1"
```

Component, relationship, rule, and quality-goal shapes are unchanged. The deprecated `version: "0.1"` alias is still readable as the legacy `0.1.0` generation, but maintained models should declare `0.1.1`. Do not delete `version`: it remains required. Unsupported string versions now fail at `/version` and list `0.1.1`, `0.1.0`, and `0.1`.

## JSON consumers

`archsync model graph`, `archsync model diff`, and `archsync model check-json` now emit the Core CLI JSON `1.0.0` envelope:

- top-level `schema_version: "1.0.0"`;
- a `kind` discriminator;
- a `contracts` map identifying the model, graph, conformance, finding, and evidence versions;
- `schema_version: "1.0.0"` on Core findings and model-evidence records.

Existing graph, diff, classification, summary, finding, and diff fields remain at the top level. Consumers that ignore additive fields can continue unchanged. Strict schemas must add the envelope fields and must reject an unknown major contract version rather than guessing.

Guardian source commands are separate: `scan` emits Observed Graph `0.1`, while source `check --json` emits Guardian Result `0.1` with Finding/Source Evidence `0.1`. Their embedded `model_evidence` records carry Core Evidence `1.0.0`. Do not parse a Guardian source result as a Core CLI result merely because both contain conformance information.

## Safe rollout

1. Update maintained architecture files to `0.1.1`.
2. Update strict Core model-command JSON decoders for the `1.0.0` envelope and record versions.
3. Frozen-install Guardian with the reviewed vendored Core artifact.
4. Run `pnpm build && pnpm core:compatibility:verify`.
5. Run the consumer's model validation and source/Git checks against a clean baseline.
6. Run `pnpm phase3:verify`; for a release, require the Ubuntu/Windows/macOS matrix.
7. Confirm `archsync version --json` reports Core Model `0.1.1`, previous `0.1.0`, Core JSON contracts `1.0.0`, the expected Guardian contracts, and the reviewed Core source commit/checksum under `dependencies.core`.

The compatibility gate replays identical current/previous fixtures and requires identical Guardian results. The unsupported fixture must fail with the migration-oriented version message.

## Rollback

Restore the previous Guardian package or the complete prior vendored dependency set (Core tarball, provenance JSON, `pnpm-lock.yaml`, generated `dist`, and evidence manifests). Do not replace only the tarball: the verifier intentionally rejects mismatched provenance and checksums. Validate the restored model reader and rerun the full gate before redeployment.
