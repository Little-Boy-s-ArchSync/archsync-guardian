# ArchSync Guardian

`@archsync/guardian` is the deterministic TypeScript source analyzer and architecture conformance control plane for ArchSync Phase 2.

**Phase 2 status:** complete and reproducible as of 2026-08-12.

## Repository boundary

Guardian depends on `@archsync/core`. It does not own the Architecture Model schema and does not treat draw.io or runtime observations as a source of truth.

## Phase 2 capabilities

- Scan a TypeScript/Node.js repository into Observed Graph v0.1.
- Detect HTTP, PostgreSQL, Redis and AMQP relationships through AST signals.
- Call Core's deterministic graph diff and `deny`/`allow`/`require`/`require-path` conformance engine.
- Classify `no-impact`, `violation` and `evolution`.
- Emit Finding v0.1 with relative file, line, column, detector and confidence evidence.
- Evaluate the ten-case Order Platform benchmark with precision/recall and reproducibility metrics.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm phase2:verify
```

## Repository scan

With `archsync-benchmark` checked out next to this repository:

```bash
pnpm guardian check \
  ../archsync-benchmark/order-platform/architecture.yaml \
  ../archsync-benchmark/order-platform/repository
```

Expected baseline output:

```text
NO-IMPACT / PASS (0 violations, 0 architecture changes)
- No source-level architecture drift detected
OBSERVED 5 components, 5 relationships, 9 TypeScript files
```

Generate the machine-readable Observed Graph:

```bash
pnpm guardian scan architecture.yaml repository observed.json
```

Run the canonical benchmark directly during development:

```bash
pnpm guardian benchmark \
  ../archsync-benchmark/order-platform/ground-truth.json
```

The expected result is 10/10 deterministic cases with `1.000` full-graph and changed-graph node/edge precision/recall, classification accuracy and exact source evidence accuracy.

## Repository map

```text
src/analyzer.ts       TypeScript source -> Observed Graph
src/guardian.ts       Core conformance orchestration + evidence enrichment
src/contracts.ts      Observed Graph and Finding v0.1 contracts
src/benchmark.ts      Phase 2 benchmark evaluator and metrics
evidence/             deterministic local evidence manifest
docs/                 boundary, ADR and Phase 2 exit gate
```

See [`docs/phase-2.md`](docs/phase-2.md) for the exact gate. Git diff and pull-request CI are Phase 3. LLM reasoning, automatic repair, MCP, IaC and runtime evidence remain out of scope.
