# ArchSync Guardian

`@archsync/guardian` is the deterministic TypeScript source analyzer and architecture conformance control plane for ArchSync Phases 2 and 3, with preparatory Phase 4 reasoning/repair-verification, Phase 5 Infrastructure-as-Evidence and Phase 6 runtime-awareness foundations.

**Phase 3 status:** v0.3 Git-diff and pull-request gate implemented; v0.3.1 added the unified cross-platform CLI and professional demo runner; v0.3.2 hardened installable artifacts, PATH diagnostics and provenance; v0.3.3 binds the audited package to Core v0.1.1 and the corrected finding contract. This integration verifies exact Core integration pull request #3 commit `503b5fe97aa39a78d5e5de80b794a94508e106cc`, now merged into Core `main`, which combines the CORE-101 compatibility commit `a1f0143aa8eb917aa0d93e28101b1893347453e2` and proposed Phase 6 quality-goal commit `783716d7961690b1e8c1cda4acb956777977a853`. The merge status does not represent these changes as a registry release.

Operational guarantees are documented in [the offline/privacy contract](docs/OPERATIONS-PRIVACY.md) and [clean-worktree policy](docs/WORKTREE-POLICY.md). `pnpm privacy:verify` mechanically rejects runtime network clients, while `pnpm repo:verify-clean` proves the full verification/demo path leaves no repository artifacts behind.

**Phase 4 preparatory status:** versioned Explanation and canonical P4-103 Repair Candidate contracts, evidence-only prompting, outbound redaction, provider provenance/reliability, citation validation, complete deterministic taxonomy mapping over the locked 20-case benchmark replay, default-deny repair verification, and human-review handoff are implemented behind a proposed ADR. Project tests require an opaque, short-lived filesystem-and-network isolation capability bound to the exact workspace; no production issuer or approved isolator is configured, and the explicitly `TEST_ONLY` in-process adapter cannot produce reviewable evidence. The exact locked case-06 fixture and all 12 development safety cases run through deterministic/fake boundaries in tests. These are regression checks, not model, provider, repair-quality, or research results. Real-provider execution remains prohibited until EXP-101, Lead review, dataset/configuration freeze, and the provider security checklist are complete. Run `pnpm phase4:verify` for the technical gate.

See [`docs/phase-4-integration-status.md`](docs/phase-4-integration-status.md) for task-by-task coverage and remaining human/provider gates.

**Phase 5 status:** technical preparation only. Terraform/Kubernetes parsing,
cross-source identity, normalized graph, evidence claims, conflict classification
and security fixtures are implemented behind the library API. ADR-0005 remains
Proposed; Phase 5 Lead and Security approval are both pending. This repository
does not claim P4-120 or any Phase 4/5 benchmark freeze.

**Phase 6 status:** the proposed runtime-awareness foundation adds privacy-minimized OTLP fixture ingestion, deterministic observed-runtime graphs, evidence-grounded per-goal scorecards and a fail-closed human approval record. It is not approved or experimentally validated; see [`docs/adr/0005-runtime-evidence-proposed.md`](docs/adr/0005-runtime-evidence-proposed.md).

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
- Preserve Core CLI JSON `1.0.0` envelopes for namespaced model commands while keeping Guardian source-result contracts explicitly separate.
- Run a real PASS/BLOCK/REVIEW demonstration without Bash, PowerShell-specific syntax or mocked results.
- Parse a deliberately narrow Terraform literal subset and Kubernetes
  multi-document Deployment/Service/Ingress/ConfigMap subset without executing
  infrastructure tools or hiding unsupported expressions.
- Join spec, code and IaC observations through explicit aliases and namespaces,
  retaining unknown/ambiguous identity, confidence and ranged evidence.
- Build a stable normalized infrastructure graph, spec-code-IaC evidence claims,
  deterministic conflict classifications and four preparatory security finding
  families with positive/hard-negative fixtures.
- Validate and apply a narrowly declared textual repair diff in a disposable workspace, run project tests without network access, inject an ArchSync recheck, and return a deterministic reviewability decision.
- Ingest the supported privacy-minimized OTLP/JSON fixture subset and build a deterministic observed-runtime graph with explicit missing or ambiguous evidence.
- Evaluate each proposed quality goal independently in a before/after scorecard and reject accepted high-risk decisions without an exact human approval record.

## Setup

The CLI requires Node.js 22 or later and Git. It is tested on Windows, macOS and Ubuntu. From this repository:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm doctor
pnpm repo:verify-clean
```

The published/package binary is `archsync`. During source development, use the equivalent `pnpm cli <command>`. The former `archsync-guardian` binary remains as a compatibility alias.

For a release tarball downloaded and checksum-verified from GitHub Releases,
the default installation is:

```text
pnpm setup
pnpm add --global ./archsync-guardian-0.3.3.tgz
archsync version --json
archsync doctor
```

Reopen the terminal after `pnpm setup`. If a global install is not permitted,
run the same immutable artifact without a source checkout:

```text
pnpm dlx --package=./archsync-guardian-0.3.3.tgz archsync doctor
```

Rollback means reinstalling a previous checksum-verified release tarball and
confirming its commit with `archsync version --json`; release tags and artifacts
must never be overwritten.

`archsync doctor` checks both command discovery and whether `PNPM_HOME` or its
`bin` child is present on `PATH`. The latter matches pnpm's Windows global-bin
layout. Source development remains usable with a warning, while clean-install
CI requires both checks to pass.

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

The deterministic analyzer, conformance, benchmark, Git-gate, doctor, version-provenance and model-command adapter modules are enforced at 100% statement, branch, function and line coverage. The thin terminal entry point and demo process orchestrator are additionally exercised by a mandatory 23-command built-binary smoke suite on every supported operating system because they cross process, temporary-Git and terminal boundaries. The same matrix packs Core and Guardian, installs the tarballs into an isolated global prefix, and calls the installed `archsync` binary from an unrelated project.

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
src/compatibility.ts  exact Core dependency and Core-to-Guardian contract map
src/phase3.ts         Git diff, baseline cache, incremental merge and PR reports
src/iac-terraform.ts  narrow, non-executing Terraform resource parser
src/iac-kubernetes.ts multi-document Kubernetes parser and reference resolver
src/iac-normalize.ts  identity map, graph normalization, claims and conflicts
src/iac-security.ts   preparatory deterministic infrastructure security rules
src/repair-isolation.ts  opaque, default-deny project-test isolation capability
src/repair-verification.ts  preparatory repair sandbox, patch/test/recheck gates
src/runtime/          privacy-minimized runtime evidence and observed graph
src/evolution/        per-goal scorecards and fail-closed approval records
src/contracts.ts      Observed Graph and Finding v0.1 contracts
src/benchmark.ts      Phase 2 benchmark evaluator and metrics
src/model-cli.ts      unified Architecture Model command adapter
src/demo.ts           cross-platform real-patch demo runner
src/doctor.ts         Node/Git/platform preflight diagnostics
evidence/             deterministic Phase 2 and Phase 3 evidence manifests
docs/                 boundaries, ADRs, exit gates and GitHub Actions example
```

See [`docs/phase-2.md`](docs/phase-2.md) for source reconstruction,
[`docs/phase-3.md`](docs/phase-3.md) for the Git/PR gate,
the [`Core–Guardian compatibility map`](docs/contract-compatibility.md),
[`support matrix and detector limitations`](docs/support-matrix.md), and
[`0.1.0 → 0.1.1 migration guide`](docs/migrations/core-0.1.0-to-0.1.1.md).
The preparatory boundaries are documented in
[`docs/phase-4-repair-verification.md`](docs/phase-4-repair-verification.md) for the
draft deterministic verification boundary, [`docs/phase-5.md`](docs/phase-5.md)
for the preparatory IaC contract, and [`docs/RUNTIME-FOUNDATION.md`](docs/RUNTIME-FOUNDATION.md)
for the proposed runtime boundary. Phase 4 reasoning is an evidence-only foundation;
repair generation, automatic approval/merge, MCP transport, rendered/dynamic IaC,
cloud-state discovery, production telemetry and experimental validation remain
outside this integration branch.
