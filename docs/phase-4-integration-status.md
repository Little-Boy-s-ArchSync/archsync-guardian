# Phase 4 integrated technical status

Status: **PREPARATORY — no real-provider run, research result, approval, freeze, or merge claim**

This branch integrates the proposed reasoner foundation with the deterministic
repair-verification foundation. It exercises every available locked fixture
that can run without credentials, provider access, dataset/configuration
freeze, or human judgment.

| Task | Automated technical coverage on this branch | Deliberate remaining gate |
| --- | --- | --- |
| P4-103 | One canonical `0.1.0-preparatory` candidate contract now carries the proposal metadata, exact target fingerprints, file/base hashes, unified diff, verification commands, rollback, and deterministic verification summary. Provider hand-off must be `PROPOSED` and cannot assert verification. | Contract remains preparatory until ADR/Lead acceptance. |
| P4-108 | Exact hash-locked Order Platform case-06 is replayed from deterministic `BLOCK` at `frontend/src/app.ts:14`, through a fake-provider cited explanation, taxonomy, inverse repair verification, and an undecided review handoff. | This is not a real-provider explanation result. |
| P4-109 | All findings emitted by the available locked 20-case Order Platform replay have an expected taxonomy mapping; the verifier rejects any `unknown` or changed mapping. | The snapshot is a deterministic regression corpus, not human-adjudicated research evidence. |
| P4-110 | Disposable workspace, path containment, exclusion, timeout, no-network executor contract, and cleanup paths are integrated. | The built-in Windows backend remains fail-closed `INCONCLUSIVE` until an approved enforced isolator is supplied. |
| P4-111 | Text-only patch validation, file/base hash binding, clean-apply preflight, unexpected-file rejection, and safe application are integrated. | Human code/security review is still required. |
| P4-112 | Allowlisted direct command execution, timeout, bounded/sanitized logs, offline environment, and result classification are integrated. | Case-06 has no upstream project test command, so its replay uses an in-process deterministic fixture invariant; it is not an external project-test result. |
| P4-113 | Baseline and candidate Guardian rechecks compare exact BLOCK fingerprints, unresolved targets, and newly introduced BLOCK findings. | Architecture intent and REVIEW/evolution acceptance remain human decisions. |
| P4-114 | Five deterministic verifier outcomes are integrated. Only a complete `ACCEPTABLE_FOR_REVIEW` result can promote a candidate. Review-handoff creation runtime-validates the candidate, and approval rechecks passing tests/conformance, safe application, and zero new blocking findings. | Human approval remains mandatory; no path merges or updates a baseline. |
| P4-122 | An optional external `AbortSignal`, runner-owned per-attempt timeout/abort, cancellation-aware retry backoff, fixed cancellation diagnostics, and injected-transport signal propagation are mechanically tested without a real call. | The real provider, endpoint stop switch, and final configured limits still require the security checklist and frozen configuration. |
| P4-124 | All 12 available attack/hard-negative safety cases run through the prompt, every outbound string/path field, invalid-policy and malformed-usage rejection, pre-call input budget, post-response usage/cost budget, citation, candidate-validation, or verification-bypass boundary with a deterministic fake provider. Failed budget manifests retain valid measured usage without raw response content. The fake-provider scaffold treats `raw_response_path` as metadata and performs no response filesystem write. | P4-127 human security sign-off and a frozen real-provider configuration, including approved governed retention, are required before this can become provider evidence. |
| P4-126 | The undecided human handoff is hash-bound to a runtime-valid candidate. Constructed or tampered status/verifier summaries cannot be approved or recognized as human-approved unless every P4-114 success invariant remains exact. | A real named human decision and immutable review evidence are still required. |

The inherited branch also retains the proposed P4-101/P4-102/P4-104–P4-107
and P4-121 technical scaffolds. P4-115–P4-120, P4-123,
P4-125, and final P4-127 completion require real-provider execution, frozen
inputs/configuration, human review/adjudication, or security approval and are
therefore intentionally not fabricated here.

Run the integrated technical gate with:

```text
pnpm phase4:verify
pnpm phase3:verify
```
