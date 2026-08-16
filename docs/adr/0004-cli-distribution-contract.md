# ADR-0004: Verify the CLI from release tarballs in a clean prefix

## Status

Accepted for the v0.3 release line.

## Context

Running `pnpm cli`, linking a source checkout, or executing `dist/bin.js` proves
that the implementation works inside the repository. It does not prove that the
published package contains the required files, installs its Core peer, exposes
the `archsync` command on Windows, macOS and Linux, or preserves source
provenance after `.git` is no longer available.

## Decision

The supported v0.3 command-line distribution is the Guardian tarball produced
by `pnpm pack`. It bundles the pinned Core runtime because Core and Guardian
cannot both own the global `archsync` shim and Core is not yet published to a
registry. The release still contains a separate Core tarball for API-only
consumers. A release is acceptable only when CI:

1. builds and tests Core and Guardian;
2. packs both packages from a clean commit;
3. confirms Guardian contains the pinned Core runtime and installs that exact
   Guardian tarball into a temporary global directory;
4. prepends only that directory to `PATH`;
5. invokes the installed `archsync` binary from an unrelated temporary project;
6. validates an architecture model and runs `version --json` and `doctor --json`;
7. verifies that the package contains only the declared runtime surface; and
8. repeats the test on Windows, macOS and Linux.

Guardian embeds a deterministic provenance record during `prepack`. The record
binds the package name and version, the 40-character source commit, and a
SHA-256 digest of Guardian and its complete bundled Core executable/runtime
content, excluding the record and package manifests that package managers may
normalize during installation. Package name and version are bound as separate
fields. The installed CLI recomputes the content digest before reporting
`integrity: verified`.
The release workflow separately publishes SHA-256 checksums of the compressed
tarballs.

The repository configures pnpm's hoisted linker in `pnpm-workspace.yaml`
because pnpm requires a hoisted runtime tree when materializing
`bundledDependencies`. This setting is part of the reproducible package
contract and is exercised by the frozen-lockfile CI install.

`archsync doctor` treats a missing global command as a warning during source
development and prints an actionable `pnpm setup` instruction. The clean-prefix
test requires that same check to pass when the release is installed.

## Consequences

- Source-level tests can no longer hide missing `files`, `bin`, peer dependency,
  lifecycle, shell-shim or PATH defects.
- `archsync version --json` is suitable for bug reports and experiment evidence.
- npm-registry publication can be added later without changing the package or
  CLI contract; the GitHub Release tarballs remain the verified v0.3 channel.
