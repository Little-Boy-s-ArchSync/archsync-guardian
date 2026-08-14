# ADR-0003: Diff-scoped pull-request decisions

- Status: Accepted
- Date: 2026-08-14
- Phase: 3

## Context

Running whole-repository conformance on every pull request can make an unrelated change fail because of drift that already exists at the base commit. Phase 3 also needs lower repeated analysis cost without allowing a cache to become architecture authority.

## Decision

Guardian constructs or loads the base commit's Observed Graph, rescans only source components touched by the Git diff, and merges that evidence into the baseline graph. Stable finding identities are compared between base and head.

Only findings introduced by the diff determine its merge decision:

- a new deterministic violation returns `BLOCK`;
- a new non-forbidden topology change returns `REVIEW`;
- no new finding returns `PASS`.

Pre-existing findings remain reported but do not block an unrelated diff. Resolved findings are recorded. Cache entries are keyed by base commit, architecture model hash and analyzer version and are rebuilt if missing or invalid.

## Consequences

- Existing repositories can adopt ArchSync without first removing every historical finding.
- Pull-request decisions are attributable to changed source components and lines.
- A clean result never changes the approved architecture automatically.
- Model updates still require repository-level architecture-owner approval.
- Full-repository scan remains available and is the source of every cold baseline.
