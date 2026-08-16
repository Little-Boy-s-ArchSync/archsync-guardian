# Phase 2 - Deterministic Guardian Core

**Target release:** ArchSync v0.2

**Status:** Strengthened and reproducible (2026-08-14)

## Objective

Build a deterministic path from `architecture.yaml` and a TypeScript/Node.js repository to an Observed Graph, graph drift classification and source-backed findings.

## Pipeline

```text
architecture.yaml -> Expected Graph
TypeScript source -> Observed Graph + file/line evidence
Expected + Observed -> Core conformance -> Guardian Finding v0.1
```

## In scope

- TypeScript AST scanning through the TypeScript Compiler API.
- Component discovery from repository roots.
- HTTP calls through `fetch` and URL endpoints.
- PostgreSQL access through `pg`.
- Redis access through `redis`.
- AMQP producer/consumer relationships through `amqplib`.
- Observed Graph contract v0.1.
- Finding contract v0.1 with source and model evidence.
- Full-repository `scan`, `check` and `check-json` commands.
- Twenty-case end-to-end benchmark evaluation with node, edge, classification, evidence and determinism metrics.
- Forty-signal detector challenge evaluation: 20 positive signals and 20 hard negatives.

## Out of scope

- Git diff, pull-request annotation, graph caching and CI merge gates (Phase 3).
- LLM explanation or repair.
- MCP transport.
- Terraform, Kubernetes or runtime analyzers.
- Automatic code repair or architecture baseline updates.

## Supported detectors

| Detector | Source signal | Observed relationship |
| --- | --- | --- |
| `typescript-fetch` | `fetch()` plus an HTTP(S) endpoint | source component -> endpoint host (`http`) |
| `typescript-pg` | `query()` on a client created from a tracked `pg` import | source component -> PostgreSQL host (`data`) |
| `typescript-redis` | supported data operation on a client created from a tracked `redis` import | source component -> Redis host (`data`) |
| `typescript-amqp-publish` | `publish()` / `sendToQueue()` on a channel derived from a tracked `amqplib` connection | producer -> queue (`async`) |
| `typescript-amqp-consume` | `consume()` on a channel derived from a tracked `amqplib` connection | queue -> consumer (`async`) |

## Exit gate

1. Baseline source reconstructs five components and five relationships.
2. All 20 patches are applied independently to the clean baseline.
3. Full-graph node and edge precision/recall are each at least 0.85.
4. Changed-node and changed-edge precision/recall are each at least 0.85.
5. `deny`, `allow`, direct `require` and multi-hop `require-path` rules are deterministic.
6. All 20 classifications match ground truth.
7. Violation rule IDs match ground truth.
8. Expected source evidence files and exact lines match.
9. Repeated analysis produces byte-identical JSON for baseline and all cases.
10. The detector challenge corpus classifies all 20 positive and 20 hard-negative signals exactly and deterministically.
11. Deterministic engine and model-command adapter statement, branch, function and line coverage are all exactly 100%; the built CLI contract additionally passes all 23 smoke checks.
12. Guardian and Benchmark gates pass from clean clones on Windows and Ubuntu.
13. The committed Phase 2 evidence binds implementation source, the complete fixture tree, verification source/configuration, package metadata, lockfile and vendored Core runtime by SHA-256.

## Authoritative commands

```bash
# archsync-guardian
pnpm install --frozen-lockfile
pnpm phase2:verify

# archsync-benchmark (after Guardian is pinned)
pnpm install --frozen-lockfile
pnpm phase2:verify
```

## CLI contract

```bash
archsync-guardian scan architecture.yaml repository observed.json
archsync-guardian check architecture.yaml repository
archsync-guardian check-json architecture.yaml repository
archsync-guardian benchmark ground-truth.json phase-2-results.json
```

Exit codes are `0` for no-impact, `1` for violation, `2` for invalid input/usage and `3` for evolution requiring review.

The roadmap calls this milestone analyzer v0.1. The frozen research baseline remains recorded as v0.1 in the benchmark; the hardened implementation documented here is Guardian v0.2. Guardian v0.3 adds the Phase 3 incremental Git/CI layer without changing the deterministic Phase 2 decision semantics.
