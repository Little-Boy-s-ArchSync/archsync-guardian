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

Guardian does not approve an evolution or rewrite `architecture.yaml`. Repository governance such as CODEOWNERS supplies the human approval boundary around model changes.
