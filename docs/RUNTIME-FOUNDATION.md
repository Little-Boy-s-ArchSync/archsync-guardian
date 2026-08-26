# Runtime-awareness foundation

Status: proposed technical foundation; not an approved Phase 6 result.

The runtime modules provide four deterministic boundaries:

1. `collectRuntimeEvidence` ingests the supported OTLP/JSON fixture subset and produces a privacy-minimized evidence snapshot.
2. `buildObservedRuntimeGraph` aggregates services and communication edges, preserves model-mapping ambiguity and emits provenance/reliability/conflict signals.
3. `createEvolutionScorecard` evaluates every v0.2 quality goal independently against before/after evidence. Missing or incompatible evidence remains unknown and there is no composite score.
4. `createPendingApprovalRecord` creates a pending governance record. `validateApprovalRecord` prevents an accepted decision without a human identity/role and the exact baseline-update commit.

This work prepares the automatable portions of P6-101 through P6-106. P6-101 still requires lead and privacy/security approval. P6-106 still requires a real human decision for an actual candidate. No experimental runtime claim is made.
