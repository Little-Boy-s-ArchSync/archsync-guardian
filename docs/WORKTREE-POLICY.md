# Generated output and clean-worktree policy

Committed files are source, documentation, fixtures, vendored release input, and reproducibility evidence. Build output (`dist/`) and frozen evidence are committed only when an explicit update command refreshes them. Coverage, package archives, logs, caches, and package-install evidence are ignored.

Normal verification and demo commands must write transient state only beneath the operating system temporary directory, Git's private metadata, or ignored `.artifacts/`, `.archsync/`, and `coverage/` directories. They must not create `observed-order-platform.json` or any other ad-hoc output in the repository root. A user-requested `scan`/`report` destination is the only exception.

The CI clean-worktree gate snapshots all tracked and untracked state, runs the full Phase 3 verification (which includes the real PASS/BLOCK/REVIEW demo in the built CLI smoke suite), and requires the exact same state afterward. A generated file must therefore be either an intentional reviewed artifact, a temporary file cleaned on both success and failure, or an ignored cache with a documented retention rule.
