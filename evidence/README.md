# Guardian evidence

`phase-2-evidence.json` binds the supported analyzer contract, explicit Core–Guardian contract matrix, current/previous Core replay, unsupported-version failure, detector-to-source evidence, deterministic fixture outputs, finding evidence and enforced quality gates to SHA-256 manifests for implementation source, the complete fixture tree, verification source/configuration, package metadata, lockfile, vendored Core runtime artifact and its provenance attestation.

Regenerate only after an intentional Phase 2 contract or analyzer change:

```bash
pnpm evidence:update
pnpm phase2:verify
```

Any change to a bound implementation, input, verifier or dependency makes the committed Phase 2 manifest stale until the complete gate is rerun and the regenerated evidence is reviewed.

The verifier reads the exact covered and total item counts from `coverage/coverage-summary.json`, rejects any statement, branch, function or line metric below 100%, and rejects any covered/total mismatch. The committed manifest records the portable result (`complete: true`, `percent: 100`) because V8 can instrument a different absolute number of branches on different operating systems even when every branch is covered. The raw CI coverage artifact retains the platform-specific counts. The thin terminal/demo process boundary is verified separately by 23 built-binary CLI checks.

`pnpm core:compatibility:verify` separately verifies the exact integrated Core source-commit attestation and artifact checksum, installed package version, current/previous replays, unsupported-version failure, Core graph/finding/evidence/conformance/CLI JSON `1.0.0` records, and Guardian's owned observed/finding/source-evidence/result mapping.

The canonical 20-case end-to-end result and 40-signal detector challenge result are generated and verified in `archsync-benchmark`, which owns the source patches, annotated source signals and ground truth.

`phase-3-evidence.json` binds the Git-diff contract, Core–Guardian contract map and exact Core dependency, controlled `PASS/BLOCK/REVIEW` cases, exact PR annotations, baseline-cache behavior, component-incremental analysis and measured cold/warm timings to Phase 3 source hashes, fixture-tree hashes, package metadata, the lockfile, pinned Core runtime artifact and provenance attestation.

Regenerate measured Phase 3 evidence only after an intentional implementation or contract change:

```bash
pnpm phase3:evidence:update
pnpm phase3:verify
```

The committed timing values are observed measurements from the environment recorded in the evidence file. Verification recomputes functional outcomes and provenance hashes, validates every raw timing sample and recomputes the stored medians instead of pretending timings are deterministic across machines.

`phase-5-evidence.json` binds the preparatory, non-executing IaC foundation to
the complete implementation/test source, committed `dist` output, Terraform and
Kubernetes fixtures, positive and hard-negative security corpora, governance
documents, package metadata and lockfile. It records controlled parser,
normalization, identity, claim-classification and four-rule security outcomes,
plus the repository-wide 100% coverage totals.

Generate and verify it only after the implementation and documentation are
intentional:

```bash
pnpm phase5:evidence:update
pnpm phase5:verify
```

The manifest intentionally records ADR-0005, Phase 5 Lead approval and Security
approval as Proposed/Pending. It explicitly records that neither P4-120 nor a
Phase 4/5 benchmark freeze is claimed. Evidence verification proves technical
reproducibility; it cannot turn a pending human gate into an approval.

The Phase 4 repair tests also prove a default-deny execution boundary: an
opaque, versioned filesystem-and-network isolation capability must be issued
for the exact workspace before an executor is called. No production issuer is
configured. The deterministic `TEST_ONLY` adapter cannot yield
`ACCEPTABLE_FOR_REVIEW`; absent, forged, mismatched and expired capabilities
remain non-spawning, inconclusive evidence.
