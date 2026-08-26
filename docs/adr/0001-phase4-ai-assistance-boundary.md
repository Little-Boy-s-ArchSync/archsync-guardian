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

Only structured, redacted finding and evidence records may cross the provider boundary. Redaction covers every untrusted string field, including finding/evidence IDs, kind, rule ID, message, text, file, provider diagnostics and manifest metadata/artifact paths; arbitrary POSIX, Windows-drive and UNC absolute paths are removed. Every retry, timeout, token, cost, temperature and seed limit must be finite and structurally valid or the run fails before a provider call. Each attempt receives a runner-owned abort signal and is raced against its configured timeout; an optional external signal cancels both in-flight transport and retry backoff without retaining the caller's abort reason. A conservative prompt-byte upper bound is then checked against the input-token budget. Provider usage must be finite and non-negative; malformed usage fails closed without entering the manifest. If valid provider-reported input/output usage or cost still exceeds a configured limit, the run fails closed while retaining the measured usage—not raw content—in its manifest. The current fake-provider scaffold treats `raw_response_path` as metadata and never persists response content. A future real-provider adapter must implement governed retention under a run ID, including failed responses, only after named privacy and security reviewers approve the provider terms, storage location, access controls, retention period, and deletion behavior. Credentials must never enter a prompt, log, or manifest.

Repair application and verification use a disposable copy, but copying and cleanup are not filesystem confinement. Untrusted project tests must not execute until a reviewed isolator supplies an opaque, versioned, short-lived capability bound to that exact workspace and attesting both workspace-only filesystem scope and denied network access. Caller-shaped objects and the retained network-only platform wrappers are insufficient. No production capability issuer is configured, so the current runtime fails closed before spawning project tests and cannot emit `ACCEPTABLE_FOR_REVIEW`. The explicitly labelled `TEST_ONLY` in-process adapter is non-reviewable.

After an approved isolator exists, a candidate may become `VERIFIED_FOR_REVIEW`, never accepted. The verifier summary and human handoff retain the isolation status and attestation hash. The handoff runtime-validates the candidate; approval is impossible unless the embedded verifier summary is exactly `ACCEPTABLE_FOR_REVIEW` with approved isolation, passing tests and conformance, safe application, and zero new blocking findings. An approval record also requires an explicit human reviewer and immutable decision ID. High-risk work has no automatic acceptance path.

## Failure behavior

Provider cancellation, timeout, quota, rate limit, invalid JSON, unsupported citation, budget exhaustion, offline mode, or missing/invalid/expired isolation capability returns a failed or inconclusive manifest. The deterministic ArchSync gate continues unchanged. Failure cannot downgrade BLOCK, promote REVIEW, or authorize a test process.

## Acceptance gate

This ADR remains non-binding until EXP-101 is frozen and the Lead and security reviewer record approval. The code in the preparatory PR is testable scaffolding; it must not be wired to a real provider before the checklist in ADR 0002 is signed.
