# Incremental correctness validation — 2026-09-26

## Results and claim boundary

This is a deterministic regression and differential-testing receipt, not an independent accuracy benchmark or evidence of superiority to other tools. Eighteen new adversarial integration/merge cases and two parser cases extend the pre-existing phase-3 tests. The targeted suite passes 37 tests across three files. Full-scan comparisons share the analyzer with incremental scans: they assess incremental orchestration, scope, merge and cache correctness, not the analyzer's semantic accuracy.

The nine initial adversarial cases all failed on the original implementation. `before-fixes-node22.log` reproduces them with original committed phase3.ts, phase3-git.ts, analyzer.ts and contracts.ts from Guardian commit `993127c37c41733d694045fa60016b68b17f8970`, in an isolated temporary source tree, on Node 22.16.0. Nine other current tests were skipped by the reproduction filter. `before-fixes.log` is the initial exploratory run on Node 26.8.2. `ignored-before-fix.log` separately records the later ignored-source failure on Node 22.16.0. No historical evidence files were overwritten.

## Reproduced defects and repairs

| Threat | Observed failure before repair | Repair |
|---|---|---|
| Non-ASCII, tab or newline in untracked source filename (3 cases) | Git's quoted path was opened literally, causing ENOENT | NUL-delimited untracked inventory |
| Same filenames in tracked modified source (3 cases) | New forbidden database relationship incorrectly returned PASS | NUL-delimited name/status and statistics; decode Git C-quoted patch headers |
| Two subprojects at one Git commit using one architecture model | Second project's baseline reused the first project's BLOCK result | Include repository-relative project root in cache identity |
| Valid JSON with damaged observed graph | Cache accepted null relationships, then crashed | Verify SHA-256 of serialized observed payload before reuse |
| Nested component beneath a changed parent | Merge discarded unchanged nested relationships and inbound component evidence | Remove evidence by exact source ownership from component-root records; preserve evidence contributed by unchanged sources |
| Ignored, untracked source that full scanning reads | Diff returned PASS while fresh full scan returned BLOCK | Enumerate ignored source outside analyzer-excluded directories and rescan its component; expose dirty state |

The payload checksum detects accidental local corruption; it is not authentication against an adversary able to rewrite the payload and checksum. The cache key derives the exported analyzer version, with an explicit cache-format revision. A concurrent-writer test verifies publication with distinct temporary filenames. Model-rule changes invalidate the cache.

## Differential checks

Cold and warm cache runs are compared with a fresh full scan after file addition, modification, deletion, rename within a component, rename across components, and deletion of a complete component. These compare head classification, decision, finding count and scanned-file count; cold/warm runs additionally compare deltas and introduced/resolved finding objects. The nested-component test compares the entire observed graph including source evidence.

The ignored-source fix adds one Git inventory command to each diff run, parallel with the existing untracked inventory. It can increase rescanning where ignored local source exists. Directories excluded by the analyzer (`.git`, coverage, dist, node_modules, tmp) remain excluded from this additional inventory. Committed-feature changes still report a clean worktree. Existing pre-existing-violation behavior remains covered: overall diff PASS means no new graph-level finding, not that the head graph has no violations.

## Reproduction

Use Node 22.16.0 and the repository's installed dependencies:

```sh
pnpm exec vitest run src/phase3-adversarial.test.ts src/phase3.test.ts src/phase3-git.test.ts
```

The tests initialize isolated local Git repositories, use no network and clean them up afterward. `after-fixes.log` contains targeted validation output. `source-sha256.json` binds this receipt to the phase-3 source/test files at handoff; the parent integration receipt governs subsequent combined verification.

## Remaining boundaries

This finite suite is not a proof for all filesystem layouts, Git configurations or concurrent worktree edits. It does not establish semantic recall for unsupported language constructs, symlink-based source layouts, or dynamically constructed endpoints. Scanning and Git inventory are not an atomic repository snapshot; do not mutate the worktree during analysis. Relevance or eligibility of literature is outside this test evidence.
