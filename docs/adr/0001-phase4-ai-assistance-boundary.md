# ADR 0001: Phase 4 AI-assistance boundary

- Status: **PROPOSED — blocked by EXP-101 and Lead approval**
- Technical draft: 2026-08-26
- Decision owners: Lead, security reviewer

## Context

ArchSync's PASS/BLOCK/REVIEW decision is deterministic. Phase 4 may help a reviewer understand a finding or prepare a repair candidate, but a provider response is untrusted evidence processing—not an architecture decision.

## Proposed boundary

The reasoner may:

- summarize an existing versioned finding;
- classify a root cause using the published taxonomy;
- cite only source/model/finding evidence IDs supplied in the request;
- propose a unified-diff repair with target files, risk, verification commands, architecture impact, and rollback;
- return uncertainty and provider/model/prompt provenance.

The reasoner must never:

- change PASS/BLOCK/REVIEW, suppress a deterministic finding, or invent an architecture metric;
- read files outside the explicit evidence window or receive private code outside that window;
- apply a patch, run a command, update a baseline, approve an evolution, merge a change, or create an approval identity;
- treat source comments, strings, model text, or provider output as instructions;
- send credentials, personal addresses, or machine-specific paths;
- retry without a fixed attempt/timeout/token/cost budget.

Only structured finding fields and redacted evidence records may cross the provider boundary. Provider terms, retention, location, and deletion behavior must be accepted before any real call. Raw responses are retained under a run ID even when failed; credentials never enter a prompt, raw response, log, or manifest.

Repair application and verification run in a separate offline sandbox. A candidate can become `VERIFIED_FOR_REVIEW`, never accepted. An approval record requires an explicit human reviewer and immutable decision ID. High-risk work has no automatic acceptance path.

## Failure behavior

Provider timeout, quota, rate limit, invalid JSON, unsupported citation, budget exhaustion, or offline mode returns a failed reasoner manifest. The deterministic ArchSync gate continues unchanged. Failure cannot downgrade BLOCK or promote REVIEW.

## Acceptance gate

This ADR remains non-binding until EXP-101 is frozen and the Lead and security reviewer record approval. The code in the preparatory PR is testable scaffolding; it must not be wired to a real provider before the checklist in ADR 0002 is signed.
