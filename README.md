# ArchSync Guardian

The control plane that will compare expected and observed architecture, enforce deterministic rules and govern architecture evolution.

## Repository boundary

Guardian depends on `@archsync/core`. It does not own the Architecture Model schema and does not treat Draw.io or runtime observations as a source of truth.

## Planned Phase 2 scope

- Build Expected Graph from `architecture.yaml`.
- Receive Observed Graph from analyzers.
- Detect graph drift.
- Evaluate `deny` and `require` rules.
- Classify `no-impact`, `violation` and `evolution`.
- Emit evidence-rich findings for CLI and CI.

LLM reasoning, automatic repair, IaC and runtime evidence remain out of scope until the deterministic Guardian Core is verified.
