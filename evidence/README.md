# Guardian evidence

`phase-2-evidence.json` binds the supported analyzer contract, deterministic fixture outputs, finding evidence and enforced quality gates to source hashes.

Regenerate only after an intentional Phase 2 contract or analyzer change:

```bash
pnpm evidence:update
pnpm phase2:verify
```

The canonical 20-case end-to-end result and 40-signal detector challenge result are generated and verified in `archsync-benchmark`, which owns the source patches, annotated source signals and ground truth.

`phase-3-evidence.json` binds the Git-diff contract, controlled `PASS/BLOCK/REVIEW` cases, exact PR annotations, baseline-cache behavior, component-incremental analysis and measured cold/warm timings to the Phase 3 source hashes.

Regenerate measured Phase 3 evidence only after an intentional implementation or contract change:

```bash
pnpm phase3:evidence:update
pnpm phase3:verify
```

The committed timing values are observed measurements from the environment recorded in the evidence file. Verification recomputes functional outcomes and source hashes; it checks the recorded performance samples structurally instead of pretending timings are deterministic across machines.
