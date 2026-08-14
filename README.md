# ArchSync Guardian

`@archsync/guardian` is the deterministic TypeScript source analyzer and architecture conformance control plane for ArchSync Phases 2 and 3.

**Phase 3 status:** v0.3 Git-diff and pull-request gate implemented with reproducible local evidence as of 2026-08-14.

## Repository boundary

Guardian depends on `@archsync/core`. It does not own the Architecture Model schema and does not treat draw.io or runtime observations as a source of truth.

## Capabilities

- Scan a TypeScript/Node.js repository into Observed Graph v0.1.
- Detect HTTP, PostgreSQL, Redis and AMQP relationships through provenance-aware AST signals.
- Track named aliases and namespace imports for `pg`, `redis` and `amqplib`, while rejecting method-name lookalikes that are not derived from those packages.
- Call Core's deterministic graph diff and `deny`/`allow`/`require`/`require-path` conformance engine.
- Classify `no-impact`, `violation` and `evolution`.
- Emit Finding v0.1 with relative file, line, column, detector and confidence evidence.
- Evaluate 20 independent Order Platform patches and a separate 40-signal detector challenge corpus with precision/recall, specificity and reproducibility metrics.
- Cache the base-commit Observed Graph and re-scan only source components affected by a Git diff.
- Distinguish findings introduced, preserved or resolved by a pull request.
- Emit GitHub annotations and a Markdown report with `PASS`, `BLOCK` or `REVIEW`.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm phase3:verify
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

Check only architecture impact introduced by the current working-tree diff:

```powershell
pnpm guardian check architecture.yaml repository --diff .
```

Check a pull-request branch against `main`, emit GitHub annotations and save a report:

```powershell
pnpm guardian check architecture.yaml repository `
  --diff main `
  --github `
  --report archsync-pr-report.md
```

Phase 3 returns exit `0` for `PASS`, `1` for `BLOCK`, `3` for `REVIEW` and `2` for invalid input or Git state. It does not rewrite the expected model. Protect `architecture.yaml` with CODEOWNERS so an architecture evolution cannot be accepted by silently changing the baseline.

Run the canonical benchmark directly during development:

```bash
pnpm guardian benchmark \
  ../archsync-benchmark/order-platform/ground-truth.json
```

The expected end-to-end result is 20/20 deterministic cases with `1.000` full-graph and changed-graph node/edge precision/recall, classification accuracy and exact source evidence accuracy. The detector challenge corpus separately evaluates 20 positive and 20 hard-negative source signals.

## Repository map

```text
src/analyzer.ts       TypeScript source/component -> Observed Graph
src/guardian.ts       Core conformance orchestration + evidence enrichment
src/phase3.ts         Git diff, baseline cache, incremental merge and PR reports
src/contracts.ts      Observed Graph and Finding v0.1 contracts
src/benchmark.ts      Phase 2 benchmark evaluator and metrics
evidence/             deterministic Phase 2 and Phase 3 evidence manifests
docs/                 boundaries, ADRs, exit gates and GitHub Actions example
```

See [`docs/phase-2.md`](docs/phase-2.md) for source reconstruction and [`docs/phase-3.md`](docs/phase-3.md) for the Git/PR gate. LLM reasoning, automatic repair, MCP, IaC and runtime evidence remain out of scope.
