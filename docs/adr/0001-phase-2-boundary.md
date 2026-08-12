# ADR-0001: Phase 2 Guardian boundary

- Status: Accepted
- Date: 2026-08-12

## Context

Phase 1 placed schema, graph diff and pure conformance functions in `@archsync/core`. Phase 2 derives an Observed Graph from source code and attaches source evidence without duplicating Core's `deny`, `allow`, `require` or `require-path` semantics.

## Decision

`@archsync/core` remains the owner of Architecture Model validation, graph primitives, graph diff and deterministic conformance functions.

`@archsync/guardian` owns:

- analyzer execution;
- Observed Graph contract v0.1;
- source location evidence;
- conformance orchestration and evidence enrichment;
- Finding contract v0.1;
- repository-facing scan/check CLI;
- benchmark measurement orchestration.

The first analyzer supports one stack only: TypeScript/Node.js. Full repository scan is the Phase 2 unit of analysis. Git diff, pull-request annotations and incremental graph caching remain Phase 3 work.

## Consequences

- Guardian depends on Core and does not copy rule matching code.
- Guardian consumes Core as a peer dependency. Its own private-repository CI uses a pinned `pnpm pack` artifact of Core so no cross-repository token is required.
- Source evidence stays separate from approved `architecture.yaml`.
- Missing required edges and paths use a deterministic source-component anchor plus the Core model-rule location.
- Same repository and model must serialize to the same Observed Graph and Finding output.
- LLM, MCP, IaC, runtime analysis and automatic baseline updates remain excluded.
