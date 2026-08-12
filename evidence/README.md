# Phase 2 evidence

`phase-2-evidence.json` binds the supported analyzer contract, deterministic fixture outputs, finding evidence and enforced quality gates to source hashes.

Regenerate only after an intentional Phase 2 contract or analyzer change:

```bash
pnpm evidence:update
pnpm phase2:verify
```

The canonical ten-case precision/recall result is generated and verified in `archsync-benchmark`, which owns the source patches and ground truth.
