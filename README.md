# ArchSync Guardian

`@archsync/guardian` is the deterministic TypeScript source analyzer and architecture conformance control plane for ArchSync Phases 2 and 3.

**Phase 3 status:** v0.3 Git-diff and pull-request gate implemented; v0.3.1 adds the unified cross-platform CLI and professional demo runner.

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
- Expose every Core, Guardian and Git-gate capability through one cross-platform `archsync` command.
- Run a real PASS/BLOCK/REVIEW demonstration without Bash, PowerShell-specific syntax or mocked results.

## Setup

The CLI requires Node.js 22 or later and Git. It is tested on Windows, macOS and Ubuntu. From this repository:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm doctor
pnpm phase3:verify
```

The published/package binary is `archsync`. During source development, use the equivalent `pnpm cli <command>`. The former `archsync-guardian` binary remains as a compatibility alias.

## Unified CLI

```text
archsync help
archsync version
archsync doctor

archsync model validate architecture.yaml
archsync model graph architecture.yaml
archsync model diff expected.yaml observed.yaml
archsync model check expected.yaml observed.yaml
archsync model report expected.yaml observed.yaml report.drawio

archsync scan architecture.yaml repository observed.json
archsync check architecture.yaml repository
archsync check architecture.yaml repository --json
archsync check architecture.yaml repository --diff main --report archsync-pr-report.md
archsync benchmark ground-truth.json result.json
```

Model commands are namespaced to avoid confusing model-to-model conformance with source-repository conformance. Existing top-level model commands (`validate`, `validate-dir`, `graph`, `diff`, `report`, `mermaid`, and `drawio`) remain compatible.

## Professional demo

With `archsync-benchmark` checked out next to this repository:

```text
pnpm demo
```

Or invoke the CLI directly:

```text
archsync demo --benchmark ../archsync-benchmark/order-platform --scenario all
archsync demo --benchmark ../archsync-benchmark/order-platform --scenario block --verbose
archsync demo --benchmark ../archsync-benchmark/order-platform --scenario all --report demo-output/report.md
```

Running `archsync demo` in an interactive terminal shows a numbered menu. In CI or with `--scenario all`, it runs one real Git-diff case for each decision. Expected `BLOCK` and `REVIEW` decisions do not make the demo command fail; the command exits `0` only when every actual decision, changed-file set, cache transition and ground-truth label match. `--json` emits a machine-readable result and `--verbose` reveals the complete technical gate output.

The deterministic analyzer, conformance, benchmark, Git-gate, doctor and model-command adapter modules are enforced at 100% statement, branch, function and line coverage. The thin terminal entry point and demo process orchestrator are additionally exercised by a mandatory 22-command built-binary smoke suite on every supported operating system because they cross process, temporary-Git and terminal boundaries.

## Repository scan

With `archsync-benchmark` checked out next to this repository:

```text
pnpm cli check ../archsync-benchmark/order-platform/architecture.yaml ../archsync-benchmark/order-platform/repository
```

Expected baseline output:

```text
NO-IMPACT / PASS (0 violations, 0 architecture changes)
- No source-level architecture drift detected
OBSERVED 5 components, 5 relationships, 9 TypeScript files
```

Generate the machine-readable Observed Graph:

```text
pnpm cli scan architecture.yaml repository .archsync/observed.json
```

`.archsync/` is the local workspace for generated scan output and is ignored by
Git. A generated graph is not research evidence by itself. If a graph is used
to support a reported result, copy it into the benchmark evidence bundle only
together with its source commit, architecture-model hash, analyzer version,
generation command and verifier/checksum manifest.

Check only architecture impact introduced by the current working-tree diff:

```text
pnpm cli check architecture.yaml repository --diff .
```

Check a pull-request branch against `main`, emit GitHub annotations and save a report:

```text
pnpm cli check architecture.yaml repository --diff main --github --report archsync-pr-report.md
```

Phase 3 returns exit `0` for `PASS`, `1` for `BLOCK`, `3` for `REVIEW` and `2` for invalid input or Git state. It does not rewrite the expected model. Protect `architecture.yaml` with CODEOWNERS so an architecture evolution cannot be accepted by silently changing the baseline.

Run the canonical benchmark directly during development:

```text
pnpm cli benchmark ../archsync-benchmark/order-platform/ground-truth.json
```

The expected end-to-end result is 20/20 deterministic cases with `1.000` full-graph and changed-graph node/edge precision/recall, classification accuracy and exact source evidence accuracy. The detector challenge corpus separately evaluates 20 positive and 20 hard-negative source signals.

## Repository map

```text
src/analyzer.ts       TypeScript source/component -> Observed Graph
src/guardian.ts       Core conformance orchestration + evidence enrichment
src/phase3.ts         Git diff, baseline cache, incremental merge and PR reports
src/contracts.ts      Observed Graph and Finding v0.1 contracts
src/benchmark.ts      Phase 2 benchmark evaluator and metrics
src/model-cli.ts      unified Architecture Model command adapter
src/demo.ts           cross-platform real-patch demo runner
src/doctor.ts         Node/Git/platform preflight diagnostics
evidence/             deterministic Phase 2 and Phase 3 evidence manifests
docs/                 boundaries, ADRs, exit gates and GitHub Actions example
```

See [`docs/phase-2.md`](docs/phase-2.md) for source reconstruction and [`docs/phase-3.md`](docs/phase-3.md) for the Git/PR gate. LLM reasoning, automatic repair, MCP, IaC and runtime evidence remain out of scope.
