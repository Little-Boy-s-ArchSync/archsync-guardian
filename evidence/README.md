# Phase 2 evidence

`phase-2-evidence.json` binds the supported analyzer contract, deterministic fixture outputs, finding evidence and enforced quality gates to source hashes.

Regenerate only after an intentional Phase 2 contract or analyzer change:

```bash
pnpm evidence:update
pnpm phase2:verify
```

The canonical 20-case end-to-end result and 40-signal detector challenge result are generated and verified in `archsync-benchmark`, which owns the source patches, annotated source signals and ground truth.
