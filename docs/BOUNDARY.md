# Guardian boundary

## Owns

- Conformance orchestration.
- TypeScript source analysis and Observed Graph construction.
- Source-evidence enrichment for deterministic conformance results.
- Drift classification.
- Finding and approval contracts.
- Git-diff change scoping, baseline graph caching and component-incremental analysis.
- Pull-request annotations, Markdown reports and merge decisions.
- Preparatory static Terraform/Kubernetes observation, cross-source identity,
  normalized infrastructure graph, evidence-claim and security-finding
  contracts described by proposed ADR-0005.

## Does not own

- Architecture schema, graph primitives and pure deterministic conformance functions: `archsync-core`.
- Benchmark data: `archsync-benchmark`.
- MCP transport: `archsync-mcp`.
- Example projects and generated views: `archsync-examples`.

Guardian calls Core's conformance functions. It must not fork or duplicate `deny`, `allow`, `require` or `require-path` semantics.

The exact version mapping and enrichment boundary are executable in [`src/compatibility.ts`](../src/compatibility.ts) and documented in [`contract-compatibility.md`](contract-compatibility.md). Core model evidence remains Core Evidence `1.0.0`; Guardian source locations remain Guardian Source Evidence `0.1` and are never relabeled as Core evidence.

Guardian does not approve an evolution or rewrite `architecture.yaml`. Repository governance such as CODEOWNERS supplies the human approval boundary around model changes.

ADR-0005 is not accepted yet. Guardian does not execute Terraform, render
templates, access cloud accounts, inspect live cluster state, approve a trust
transition or claim that its narrow Phase 5 subset represents complete deployed
infrastructure. Phase 5 adoption requires both Lead and Security approval.
