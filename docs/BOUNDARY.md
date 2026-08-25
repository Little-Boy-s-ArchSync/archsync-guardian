# Guardian boundary

## Owns

- Conformance orchestration.
- TypeScript source analysis and Observed Graph construction.
- Source-evidence enrichment for deterministic conformance results.
- Drift classification.
- Finding and approval contracts.
- Git-diff change scoping, baseline graph caching and component-incremental analysis.
- Pull-request annotations, Markdown reports and merge decisions.

## Does not own

- Architecture schema, graph primitives and pure deterministic conformance functions: `archsync-core`.
- Benchmark data: `archsync-benchmark`.
- MCP transport: `archsync-mcp`.
- Example projects and generated views: `archsync-examples`.

Guardian calls Core's conformance functions. It must not fork or duplicate `deny`, `allow`, `require` or `require-path` semantics.

The exact version mapping and enrichment boundary are executable in [`src/compatibility.ts`](../src/compatibility.ts) and documented in [`contract-compatibility.md`](contract-compatibility.md). Core model evidence remains Core Evidence `1.0.0`; Guardian source locations remain Guardian Source Evidence `0.1` and are never relabeled as Core evidence.

Guardian does not approve an evolution or rewrite `architecture.yaml`. Repository governance such as CODEOWNERS supplies the human approval boundary around model changes.
