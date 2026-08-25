# ADR 0002: Real-provider security checklist

Status: **NOT APPROVED — real-provider runs prohibited**

All boxes require named human review before P4-115:

The preparatory suite now mechanically exercises every outbound string field, portable absolute-path and provider-diagnostic/manifest redaction; invalid or non-finite policy rejection before a provider call; malformed provider-usage rejection; pre-provider input-budget rejection; post-response output/token/cost rejection; runner-owned per-attempt timeout and transport abort; pre-call, in-flight, and retry-backoff cancellation; failed-manifest usage retention; and the fake-provider scaffold's no-filesystem-write contract. Passing those tests supplies review evidence but does not check or approve any box below.

- [ ] Provider, model, endpoint, region, terms, training use, retention period, and deletion route recorded.
- [ ] Credential comes from an approved secret store; no key appears in code, prompt, logs, manifest, evidence, or CI artifact.
- [ ] Network egress is restricted to the approved endpoint and has a tested stop switch.
- [ ] Canary token, URL credential, email, absolute-path, and private-code-window fixtures are redacted before transport.
- [ ] Prompt injection and citation-tampering corpus passes without changing the deterministic decision.
- [ ] Timeout, maximum attempts, backoff, cancellation, input/output token limits, and USD cap are configured.
- [ ] Quota, 429, timeout, malformed response, and offline fallback preserve PASS/BLOCK/REVIEW.
- [ ] Raw artifact publication classification and redaction review are complete.
- [ ] Incident owner can rotate the credential, stop egress, quarantine artifacts, notify maintainers, and document recovery.

Approval record (must be filled by humans, never the provider):

| Role | Name/ID | Decision | UTC time | Rationale |
| --- | --- | --- | --- | --- |
| Security reviewer | — | PENDING | — | — |
| Lead | — | PENDING | — | — |
