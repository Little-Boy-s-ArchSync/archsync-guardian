# Phase 4 repair verification (preparatory)

## Status and boundary

This document describes a preparatory, deterministic verification bundle for
P4-110 through P4-114. It does not generate repairs, call an LLM, approve an
architecture change, merge code, or establish Phase 4 research evidence. The
P4-103 candidate schema is deliberately marked `0.1.0-preparatory` until its
upstream design and human governance decisions are accepted.

`ACCEPTABLE_FOR_REVIEW` means only that a candidate survived the automated
technical gates. A human still owns code review, architecture intent, security
review, approval, and merge.

## Candidate hand-off

A generator hands the verifier a `RepairCandidate` with:

- an opaque candidate identifier;
- one or more target BLOCK-finding fingerprints;
- the exact relative paths it expects to change;
- the SHA-256 hash of every existing base file, or `null` for a file expected
  not to exist; and
- one textual git-style unified diff.

The manifest is intentionally redundant with the patch. That redundancy lets
the verifier reject both an unexpected file and a stale/dirty base before Git
is invoked.

```json
{
  "schema_version": "0.1.0-preparatory",
  "candidate_id": "repair-001",
  "target_block_finding_fingerprints": ["ARCH-001|..."],
  "files": [
    {
      "path": "frontend/src/database.ts",
      "base_sha256": "<lowercase SHA-256>"
    }
  ],
  "unified_diff": "diff --git a/frontend/src/database.ts b/frontend/src/database.ts\n..."
}
```

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
5. Run the project test script through a direct, allowlisted command with a
   bounded timeout, bounded/sanitized output, a credential-minimized
   environment, package-manager offline flags, and an enforced no-network
   platform wrapper.
6. Run the injected ArchSync recheck again. Compare candidate BLOCK findings
   with the baseline, retaining pre-existing non-target findings while
   identifying unresolved targets and newly introduced BLOCK findings.
7. Produce one deterministic decision and remove the temporary workspace.

The verifier never edits the supplied source repository.

## Sandbox and network policy

The default command allowlist is `npm`, `pnpm`, `yarn`, and `bun` (including
their native Windows executable spellings). Commands are executed directly,
never through a caller-provided shell string. Arguments containing NUL bytes,
invalid time limits, and commands outside the allowlist fail closed.

Network isolation is enforced before a test command can run:

- macOS uses a `sandbox-exec` profile that denies network operations;
- Linux uses a new unprivileged user and network namespace through `unshare`;
- platforms without a built-in enforced backend, including the current Windows
  default, do not run the command and return `INCONCLUSIVE`.

An integrator may inject another command executor only through the typed
`NoNetworkCommandExecutor` boundary, which explicitly attests
`network_isolation: "ENFORCED"`. A missing executable, denied namespace setup,
timeout, output overflow, or executor failure is infrastructure uncertainty and
therefore cannot become a passing result.

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
| `INCONCLUSIVE` | Sandbox, network isolation, timeout, process, cleanup, target baseline, or recheck evidence did not complete conclusively. |
| `ACCEPTABLE_FOR_REVIEW` | Safe apply, passing tests, cleared targets, and no new BLOCK findings; human review is still mandatory. |

Decision precedence is safety, test conclusiveness/failure, conformance
comparability, conformance failure, then reviewability. A failed project test
cannot be hidden by an incomplete or clean ArchSync recheck, and an incomplete
recheck cannot be reported as a successful repair.

## Verification

The module is exported from `@archsync/guardian` and is included in the normal
typecheck, build, package, and 100% coverage gates. Its test suite covers the
five decisions plus path traversal, reserved paths, binary/mode/rename patches,
stale hashes, symlinks, Git preflight/application failures, platform isolation,
timeouts, redaction, cleanup, and injected baseline/candidate rechecks.

This bundle is preparatory technical work only. A future accepted Phase 4 ADR,
frozen generation protocol, human rubric, benchmark, and evidence manifest are
separate deliverables.
