# Phase 3: Git Diff and Pull-Request Architecture Gate

## Objective

Turn the deterministic Phase 2 repository check into a change-scoped control loop that can run on every pull request:

```text
approved architecture.yaml + base commit -> cached baseline Observed Graph
Git diff -> affected source components -> incremental Observed Graph update
baseline findings vs head findings -> introduced/resolved findings
introduced violation -> BLOCK
introduced non-forbidden topology -> REVIEW
no introduced drift -> PASS
```

The approved architecture model remains the source of truth. Phase 3 never rewrites `architecture.yaml`, accepts a topology change, repairs code or merges a pull request automatically.

## Version note

The roadmap used `v0.2 / MVP` as a planning label for Phase 3. The implementation uses Guardian package `v0.3.0` because `v0.2.0` was consumed by the provenance-aware analyzer hardening completed before the PR gate. Patch release `v0.3.1` adds the unified CLI, diagnostics and demo experience without changing analyzer or decision semantics. This is a package-version adjustment, not a scope change: Phase 3 remains the roadmap's Git-diff and CI milestone.

## Why the decision is diff-scoped

A full repository scan is still the source of the baseline graph. For a pull request, ArchSync compares stable finding identities between the base commit and the proposed head:

- a finding present only at the head is introduced by the change;
- a finding present at both base and head is pre-existing and remains visible, but does not block an unrelated change;
- a finding present only at the base is resolved by the change.

This avoids turning rollout of ArchSync on an existing repository into an all-at-once cleanup requirement while still preventing new architectural debt.

## Incremental algorithm

1. Resolve the merge base of `<base-ref>` and `HEAD`. With `--diff .`, use `HEAD` as the base and inspect staged, unstaged and untracked files.
2. Build the base Observed Graph from the committed TypeScript tree.
3. Cache that graph inside Git metadata using a key derived from base SHA, architecture model SHA-256 and analyzer version.
4. Map changed TypeScript paths to source components.
5. Re-scan all TypeScript files in affected components only.
6. Replace evidence and relationships owned by those components in the cached graph.
7. Evaluate base and head graphs with the same deterministic Core rules.
8. Emit GitHub annotations, a Markdown PR report and exit code `0`, `1` or `3`.

The cache is local evidence acceleration, not authority. A missing, stale or corrupt entry is rebuilt from Git.

## CLI contract

Guardian v0.3 owns the unified `archsync` CLI. The same entry point exposes Core model operations through `archsync model ...`, source reconstruction through `scan`/`check`, and the Phase 3 Git gate through `check --diff`. `archsync-guardian` remains a compatibility binary.

Working-tree demo:

```text
archsync check architecture.yaml . --diff .
```

Pull-request branch compared with `main`:

```text
archsync check architecture.yaml . --diff main --github --report archsync-pr-report.md
```

Machine-readable result:

```text
archsync check architecture.yaml . --diff main --json
```

Options:

- `--diff <base-ref>` enables Phase 3 diff mode.
- `--github` emits workflow-command annotations and appends Markdown to `GITHUB_STEP_SUMMARY` when available.
- `--report <file>` writes a stable Markdown report artifact.
- `--cache-dir <directory>` overrides the Git-internal cache location.
- `--no-cache` forces baseline reconstruction.

The CLI also provides `archsync doctor` for Node/Git/platform preflight checks and `archsync demo` for a real PASS/BLOCK/REVIEW benchmark demonstration. Both use Node child processes with `shell: false`; no Bash or PowerShell script is required. Deterministic engine, doctor and model-command adapter modules must reach 100% statement, branch, function and line coverage. The verification matrix additionally runs all 22 built-CLI smoke checks on Windows, macOS and Ubuntu.

## Exit gate

| Decision | Exit | Meaning | Default merge action |
|---|---:|---|---|
| `PASS` | 0 | No new rule violation or topology drift | Continue |
| `BLOCK` | 1 | The diff introduces at least one deterministic rule violation | Reject until fixed |
| `REVIEW` | 3 | The diff introduces non-forbidden architecture evolution | Require architecture approval |
| Invalid | 2 | Bad model, Git state, arguments or runtime failure | Fix the check |

Updating the model in the same pull request is allowed only as an explicit architecture proposal. The consuming repository must protect `architecture.yaml` with CODEOWNERS or an equivalent approval policy; otherwise a developer could legitimize a code change without the governance promised by ArchSync.

## Phase 3 evidence

`evidence/phase-3-evidence.json` records:

- source hashes for the implementation that produced the evidence;
- hashes for the architecture, baseline fixture, violation fixture, package metadata, lockfile and pinned Core runtime artifact;
- controlled `PASS`, `BLOCK` and `REVIEW` diff cases;
- exact changed file and source-line findings;
- component-scoped incremental analysis;
- the exact number of TypeScript files parsed incrementally versus files represented in the head graph;
- cache miss and five cache-hit timing samples on the recorded machine.

The timing verifier recomputes every stored median from the raw samples. The larger benchmark additionally compares each incremental result with a separate full scan of the same patched head repository.

Run:

```powershell
pnpm phase3:verify
```

## Remaining research boundary

Phase 3 proves the deterministic Git/PR control path. It does not yet evaluate developer comprehension, approval delay, real-repository generalization, automatic repair, IaC, runtime evidence or the Evolution Engine quality-goal scorecard.
