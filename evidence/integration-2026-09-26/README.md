# Integrated robustness validation — 2026-09-26

Current local candidate: Guardian analyzer semantics 0.3. This is new development
evidence. It does not replace the paper's frozen v0.1/v0.2 measurements, prove
general field accuracy, or certify a published release.

## Completed checks

- Exact Node22.16.0 on macOS arm64; final full suite: 301/301 tests pass across
  32 files (`coverage-final.log`). Configured statement/branch/function/line
  coverage is 100%. Two inert, mandatory compiler-host callbacks are individually
  excluded with source explanations; detector logic has no new exclusions.
- Typecheck: see `../robustness-2026-09-26/analyzer-concat-mutation-typecheck.txt`.
- Current built CLI on all 20 D1 cases: exact classification, graph and declared
  evidence agreement; deterministic20/20 (`d1-final.json`, `d1-final.log`).
  This is reuse of a known development benchmark, not a holdout.
- CLI smoke, offline contract, Core contract compatibility and phase4 assets:
  actual command logs are retained here and in the analyzer evidence directory.
- Current phase2/phase3/phase5 engineering receipts were regenerated after final
  source changes. Their predecessors are retained under
  `previous-current-receipts/`; frozen Benchmark/vendor/manuscript result inputs
  were not rewritten. Final verifier logs are named `phase*-verify-final.log`.

## Failure-first evidence

See `../robustness-2026-09-26/ANALYZER.md` for detector inputs, initial failures,
repairs, the corrected invalid positive fixture, and remaining semantic limits.
See `../incremental-2026-09-26/README.md` for the original nine failures, the
additional ignored-source false PASS, cold/warm/full equivalence checks and
cache integrity boundaries.

`coverage-initial.log` retains the ignored-source failure encountered during
integration. `coverage-second.log` records all tests passing but the coverage
gate failing; obsolete prefix logic was removed and inert host adapters were
isolated. `coverage-before-second-review.log` precedes the final concatenation
and reassignment repairs. These earlier receipts must not replace the final log.

CLI smoke initially retained an old version expectation; that assertion was
updated to analyzer0.3 (`cli-smoke-initial.log`). Packaging directly from the
edited checkout correctly refused dirty tracked source (`package-verify.log`).
Packaging is tested from a separate locally committed source snapshot; the
snapshot is a validation artifact, not a commit or release in the user checkout.
`package-clean-final.json` records its identity and exit status, and
`package-install.json` records installation results when successful. The first
snapshot attempt used linked dependencies and was rejected by pnpm's no-TTY
dependency refresh; its output is retained. The final attempt installs the
lockfile into the isolated snapshot with install-time scripts disabled.

## Boundaries

No new Windows/Linux execution, independent human annotation, held-out accuracy,
external-tool superiority, calibrated confidence or performance improvement is
claimed. Direct-assignment invalidation is conservative and may suppress a
legitimate earlier use; inter-file flows, other mutation forms, dynamic templates
and fallback selection remain limitations. A cache checksum detects accidental
corruption, not a writer who can replace both payload and checksum.

The new source and distribution changes are local and reviewable. The standalone
repositories were edited; monorepo mirrors and remote releases were not updated.
