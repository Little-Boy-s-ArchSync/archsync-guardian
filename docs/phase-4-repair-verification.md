# Phase 4 repair verification (preparatory)

## Status and boundary

This document describes a preparatory, deterministic verification bundle for
P4-110 through P4-114. It does not generate repairs, call an LLM, approve an
architecture change, merge code, or establish Phase 4 research evidence. The
single P4-103 candidate schema is deliberately marked `0.1.0-preparatory`
until its upstream design and human governance decisions are accepted. It
replaces the earlier divergent reasoner-only proposal and verifier-only patch
manifest; generation, verification, and review now share one canonical shape.

`ACCEPTABLE_FOR_REVIEW` is reserved for a candidate that survived the automated
technical gates under an approved filesystem-and-network isolator. No such
isolator or approval is configured in this repository, so the current runtime
cannot produce that decision. A human would still own code review, architecture
intent, security review, approval, and merge after that infrastructure exists.

## Candidate hand-off

A generator hands the verifier a `RepairCandidate` with:

- an opaque candidate identifier;
- status `PROPOSED` and no self-asserted verification evidence;
- one or more target BLOCK-finding fingerprints;
- the exact relative paths it expects to change;
- the SHA-256 hash of every existing base file, or `null` for a file expected
  not to exist;
- one textual git-style unified diff; and
- rationale, expected architecture impact, risk, proposed verification
  commands, and rollback information for human review.

The manifest is intentionally redundant with the patch. That redundancy lets
the verifier reject both an unexpected file and a stale/dirty base before Git
is invoked.

```json
{
  "schema_version": "0.1.0-preparatory",
  "candidate_id": "repair-001",
  "status": "PROPOSED",
  "target_block_finding_fingerprints": ["ARCH-001|..."],
  "files": [
    {
      "path": "frontend/src/database.ts",
      "base_sha256": "<lowercase SHA-256>"
    }
  ],
  "unified_diff": "diff --git a/frontend/src/database.ts b/frontend/src/database.ts\n...",
  "rationale": "Remove the direct data dependency.",
  "expected_architecture_impact": "Clear the declared ARCH-001 finding.",
  "risk": "high",
  "verification_commands": ["pnpm test"],
  "rollback": "Restore the file bound by base_sha256."
}
```

The provider boundary rejects `VERIFIED_FOR_REVIEW` and any `verification`
field in generated output. After the offline verifier returns its immutable
decision, `bindRepairVerificationResult` may attach that evidence and promote
the candidate only when patch application, tests, the conformance recheck, and
an approved isolation attestation all pass. The verifier summary and human
handoff carry the isolation status and attestation SHA-256. This transition
still does not approve or merge anything.

`createReviewHandoff` runtime-validates that canonical candidate before hashing
it. `recordHumanReview` can record an approval only when the handoff still has
the exact `ACCEPTABLE_FOR_REVIEW` decision, passing tests and conformance, safe
application, approved isolation with a matching attestation hash, and zero new
blocking findings. `isHumanApproved` rechecks the same invariants, so a
constructed or later-tampered status field cannot bypass the deterministic
verifier summary. Rejection and inconclusive human records remain available for
non-reviewable candidates.

## Verification pipeline

The orchestrator performs the following steps in order and cleans the sandbox
in all terminal paths:

1. Validate the preparatory schema and unified diff.
2. Copy the source snapshot to a uniquely named temporary workspace. Repository
   control data, `.env*` secret files, and generated `.archsync`, `.artifacts`,
   and `coverage` directories are not copied.
3. Run the injected ArchSync recheck on the untouched copy and establish that
   every declared target is a real baseline BLOCK finding.
4. Reject symbolic-link crossings, compare exact base hashes, and run
   `git apply --check` before the atomic application attempt.
5. Require a trusted, versioned isolation capability bound to the exact copied
   workspace. If it is absent, forged, stale, expired, or mismatched, stop
   before calling the executor. Only then may an approved adapter run the
   project test script through a direct, allowlisted command with a bounded
   timeout, bounded/sanitized output, credential-minimized environment, and
   package-manager offline flags.
6. Run the injected ArchSync recheck again. Compare candidate BLOCK findings
   with the baseline, retaining pre-existing non-target findings while
   identifying unresolved targets and newly introduced BLOCK findings.
7. Produce one deterministic decision and remove the temporary workspace.

The verifier never edits the supplied source repository.

## Sandbox, filesystem, and network policy

The default command allowlist is `npm`, `pnpm`, `yarn`, and `bun` (including
their native Windows executable spellings). Commands are executed directly,
never through a caller-provided shell string. Arguments containing NUL bytes,
invalid time limits, and commands outside the allowlist fail closed.

The copied temporary workspace is a cleanup and source-protection mechanism;
it is not filesystem confinement. Likewise, a no-network wrapper alone does
not prevent hostile project tests from reading or writing host files.

`RepairIsolationCapability` is an opaque local capability with a
`1.0.0-preparatory` attestation. It binds a capability, isolator and approval
identifier to the SHA-256 of the exact real workspace path, declares
`SANDBOX_WORKSPACE_ONLY` filesystem scope, enforced network isolation and
direct allowlisted process execution, and has canonical issue/expiry times with
a maximum 15-minute lifetime. Runtime acceptance also requires the executor
object to exist in the module-private issuer registry; a caller-created object
with identical fields is rejected. Capabilities are one-workspace only.

No production issuer or approved isolator adapter is registered today.
Consequently, the default is
`FILESYSTEM_ISOLATION_CAPABILITY_REQUIRED`, and no project test process is
spawned. The retained platform network wrappers remain defense-in-depth
building blocks for a future isolator:

- macOS uses a `sandbox-exec` profile that denies network operations;
- Linux uses a new unprivileged user and network namespace through `unshare`;
- platforms without that network primitive, including the current Windows
  default, cannot satisfy the future combined isolator contract.

The in-process adapter used by unit and locked-fixture tests is explicitly
`TEST_ONLY`, can be minted only inside Vitest, never spawns a project command,
and always leaves the verifier `INCONCLUSIVE`. It cannot supply approved
evidence or promote a candidate. A future production adapter requires a code
change that adds the reviewed issuer inside the trust module; a structural
executor supplied by a caller is insufficient. A missing executable, denied
isolation setup, timeout, output overflow, or executor failure is infrastructure
uncertainty and cannot become a passing result.

Environment variables are allowlisted rather than inherited wholesale.
Proxy variables point to a closed loopback port, package managers are placed in
offline mode, and temporary/cache/config paths are redirected into the
sandbox. Logs remove ANSI sequences, sandbox paths, URL credentials, bearer
values, common secret assignments, and caller-supplied sensitive values before
they are retained. Output is capped at 256 KiB per stream.

## Patch safety policy

Accepted patches are textual add, modify, or delete diffs for regular files.
The validator rejects:

- absolute, drive-qualified, UNC, backslash, empty-segment, and traversal paths;
- `.git`, `.archsync`, `.env*`, or other undeclared paths;
- binary patches, symlinks, executable additions, mode changes, combined diffs,
  renames, copies, and malformed or duplicate file sections;
- a workspace file whose current SHA-256 does not match the candidate manifest;
- a target or parent path that crosses a symbolic link or is not a regular
  directory/file as expected;
- a diff that fails Git's clean-apply preflight, changes between preflight and
  application, or has no effect.

The patch is written outside the copied project workspace with owner-only file
permissions and is removed immediately after the apply attempt.

## Deterministic decisions

| Decision | Exact technical meaning |
| --- | --- |
| `REJECT_UNSAFE` | Schema, path, hash, symlink, patch-shape, or clean-apply safety failed. |
| `REJECT_TEST` | The safe apply completed, but the project test command returned non-zero. |
| `REJECT_CONFORMANCE` | Tests passed, but a target BLOCK finding remains or a new BLOCK finding appeared. |
| `INCONCLUSIVE` | Sandbox, approved filesystem/network isolation, timeout, process, cleanup, target baseline, or recheck evidence did not complete conclusively. |
| `ACCEPTABLE_FOR_REVIEW` | Approved isolation, safe apply, passing tests, cleared targets, and no new BLOCK findings; human review is still mandatory. This outcome is unreachable until an approved production isolator is added. |

Decision precedence is safety, test conclusiveness/failure, conformance
comparability, conformance failure, then reviewability. A failed project test
cannot be hidden by an incomplete or clean ArchSync recheck, and an incomplete
recheck cannot be reported as a successful repair.

## Verification

The module is exported from `@archsync/guardian` and is included in the normal
typecheck, build, package, and 100% coverage gates. Its test suite covers the
five decisions plus path traversal, reserved paths, binary/mode/rename patches,
stale hashes, symlinks, Git preflight/application failures, absent/forged/
mismatched/expired isolation capabilities with no executor call, platform
network defenses, timeouts, redaction, cleanup, injected baseline/candidate
rechecks, and tampered human-handoff rejection.

The integration suite also replays the exact hash-locked Order Platform
`case-06` source, architecture, and violation patch, verifies the inverse
repair on a disposable copy, and leaves the source workspace BLOCKed. Its
explicitly `TEST_ONLY` in-process invariant check does not spawn the declared
project command and cannot make the repair reviewable; the replay therefore
ends `INCONCLUSIVE`/`PROPOSED`. It is not evidence that an external repository's
tests passed. A separate locked snapshot maps
every deterministic finding emitted by the available 20-case corpus, while a
fake-provider regression runs all 12 available safety cases. Neither run is a
real-provider or human-adjudicated evaluation.

This bundle is preparatory technical work only. A future accepted Phase 4 ADR,
frozen generation protocol, human rubric, benchmark, and evidence manifest are
separate deliverables.
