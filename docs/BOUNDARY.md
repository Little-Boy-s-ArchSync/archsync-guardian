# Guardian boundary

## Owns

- Conformance orchestration.
- TypeScript source analysis and Observed Graph construction.
- Source-evidence enrichment for deterministic conformance results.
- Drift classification.
- Finding and approval contracts.

## Does not own

- Architecture schema, graph primitives and pure deterministic conformance functions: `archsync-core`.
- Benchmark data: `archsync-benchmark`.
- MCP transport: `archsync-mcp`.
- Example projects and generated views: `archsync-examples`.

Guardian calls Core's conformance functions. It must not fork or duplicate deny/require semantics.
