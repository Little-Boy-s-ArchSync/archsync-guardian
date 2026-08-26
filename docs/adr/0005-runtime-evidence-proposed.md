# ADR-0005: Runtime evidence scope for Phase 6

- Status: **Proposed — requires lead and privacy/security review**
- Date: 2026-08-26
- Sheet rows prepared: P6-101 through P6-106 technical foundation

## Context

Static source and infrastructure evidence cannot establish which communication paths were observed at runtime or quantify an architecture trade-off. Phase 6 needs a reproducible runtime snapshot while preserving the rule that missing telemetry is not proof of absence and architecture evolution remains human-governed.

## Proposed decision

Use a narrow OTLP/JSON ingestion boundary for fixture-replay first. Accept resource spans and gauge metrics with these requirements:

- every resource declares `service.name` and `deployment.environment.name`;
- spans retain correlation IDs, direction, communication family, timestamps, duration and error status, but not span names or arbitrary attributes;
- goal metrics carry `archsync.goal.id`, an explicit unit, value and timestamp;
- the configured UTC/unix-nanosecond evidence window, environment, sampling strategy/rate and retention are part of the hashed snapshot;
- normalized output is canonically ordered and contains SHA-256 provenance for the input and options.

The collector stores only semantic attributes needed to derive service identity, communication type, peer identity and goal linkage. Attribute keys suggesting credentials, cookies, secrets, end-user identifiers or email are rejected without logging their value. Raw payloads and arbitrary span attributes are not retained. Proposed fixture/evidence retention is 14 days, with a hard implementation maximum of 30 days.

Service-to-model mapping is explicit configuration. One candidate is `mapped` with confidence `1`; zero candidates is `unmapped`; multiple candidates is `ambiguous`. Both uncertain states have confidence `0` and emit visible signals. The runtime graph distinguishes `observed` model components from `no-evidence`, reports low sample edges and flags mapped edges absent from the declared model. It never rewrites the model.

The scorecard preserves one row per quality goal. Each row reports before/after evidence, compliance, improvement/regression/unchanged/unknown, confidence and exact evidence IDs. Unlike dimensions are never collapsed into a composite score. Missing, duplicate or unit-incompatible measurements are `unknown`.

Approval records are immutable snapshots. The implementation can create only a pending record; validation rejects any accepted decision without an identified human approver and an exact baseline-update commit. No fixture in this proposal represents approval.

## Reliability and sampling limits

Fixture replay uses a sampling rate of `1`. Production head/tail sampling is representable but not experimentally calibrated here. Edge counts below the configured minimum emit `RUNTIME_LOW_SAMPLE`; no statistical generalization is claimed. Clock skew, dropped spans, retries, async context loss, service-name churn and biased sampling remain threats until a reviewed experiment addresses them.

## Privacy and security review questions

Reviewers must decide whether the allowlist is sufficient for the intended deployment, whether trace/span IDs require additional handling, the approved retention period, access controls for raw telemetry before normalization, and whether environment/service names are sensitive in the deployment context.

## Consequences

This proposal enables deterministic fixtures, graph normalization, provenance and pre-approval trade-off rows. It does **not** approve the ADR, quality-goal targets, mapping configuration, an architecture evolution, a baseline update or the Phase 6 exit gate.
