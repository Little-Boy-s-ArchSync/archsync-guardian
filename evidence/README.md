# Guardian evidence

`phase-2-evidence.json` binds the supported analyzer contract, deterministic fixture outputs, finding evidence and enforced quality gates to SHA-256 manifests for implementation source, the complete fixture tree, verification source/configuration, package metadata, lockfile and the vendored Core runtime artifact.

Regenerate only after an intentional Phase 2 contract or analyzer change:

```bash
pnpm evidence:update
pnpm phase2:verify
```

Any change to a bound implementation, input, verifier or dependency makes the committed Phase 2 manifest stale until the complete gate is rerun and the regenerated evidence is reviewed.

The manifest records the exact covered and total item counts from `coverage/coverage-summary.json` and rejects any statement, branch, function or line metric below 100%. The thin terminal/demo process boundary is verified separately by 23 built-binary CLI checks.

The canonical 20-case end-to-end result and 40-signal detector challenge result are generated and verified in `archsync-benchmark`, which owns the source patches, annotated source signals and ground truth.

`phase-3-evidence.json` binds the Git-diff contract, controlled `PASS/BLOCK/REVIEW` cases, exact PR annotations, baseline-cache behavior, component-incremental analysis and measured cold/warm timings to Phase 3 source hashes, fixture-tree hashes, package metadata, the lockfile and the pinned Core runtime artifact.

Regenerate measured Phase 3 evidence only after an intentional implementation or contract change:

```bash
pnpm phase3:evidence:update
pnpm phase3:verify
```

The committed timing values are observed measurements from the environment recorded in the evidence file. Verification recomputes functional outcomes and provenance hashes, validates every raw timing sample and recomputes the stored medians instead of pretending timings are deterministic across machines.
