# Phase 2 - Deterministic Guardian Core

**Target release:** ArchSync v0.1

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
- Ten-case benchmark evaluation with edge, classification, evidence and determinism metrics.

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
| `typescript-pg` | `pg` client and `query()` | source component -> PostgreSQL host (`data`) |
| `typescript-redis` | `redis` client and data operation | source component -> Redis host (`data`) |
| `typescript-amqp-publish` | `amqplib` `publish()` / `sendToQueue()` | producer -> queue (`async`) |
| `typescript-amqp-consume` | `amqplib` `consume()` | queue -> consumer (`async`) |

## Exit gate

1. Baseline source reconstructs five components and five relationships.
2. All ten patches are applied independently to the clean baseline.
3. Full-graph edge precision and recall are each at least 0.85.
4. Changed-edge precision and recall are each at least 0.85.
5. All ten classifications match ground truth.
6. Violation rule IDs match ground truth.
7. Expected source evidence files and exact lines match.
8. Repeated analysis produces byte-identical JSON for baseline and all cases.
9. Statement, line and function coverage are at least 90%; branch coverage is at least 85%.
10. Guardian and Benchmark gates pass from clean clones on Windows and Ubuntu.

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
