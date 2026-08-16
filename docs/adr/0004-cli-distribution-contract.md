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

Each matrix job writes and uploads a machine-readable package-install evidence
record containing the platform/toolchain, installed version provenance and the
nine completed clean-install checks.

### Channel and rollback decision

| Option | Authentication and availability | Decision |
| --- | --- | --- |
| Public npm | Best user experience, but requires package-name ownership and a publication/security process not yet established | Deferred; do not claim this package is currently on npm |
| GitHub Packages | Requires registry configuration and authentication, including for many read-only installs | Rejected as the default MVP channel |
| Source checkout or global link | Useful only for contributors and can hide package/file/PATH defects | Development-only, not an end-user channel |
| GitHub Release tarball | Immutable artifact, existing team access, explicit SHA-256 file, no registry resolution for bundled Core | Selected default channel |
| `pnpm dlx --package=<tarball> archsync` | Executes the same verified artifact without a global install or source checkout | Selected fallback |

The default is a checksum-verified Guardian tarball installed globally with
pnpm. The fallback is `pnpm dlx` over that same local/downloaded tarball. CI
executes both paths. Rollback reinstalls an older immutable, checksum-verified
tarball and verifies its recorded source commit with `archsync version --json`.
Tags and release artifacts are never replaced in place.

Guardian embeds a deterministic provenance record during `prepack`. The record
binds the package name and version, the 40-character source commit, and a
SHA-256 digest of Guardian and its complete bundled Core executable/runtime
content, excluding the record and package manifests that package managers may
normalize during installation, and dependency command shims/files excluded by
dependency package whitelists. Package name and version are bound as separate
fields. The installed CLI recomputes the content digest before reporting
`integrity: verified`.
The release workflow separately publishes SHA-256 checksums of the compressed
tarballs.

The repository configures pnpm's hoisted linker in `pnpm-workspace.yaml`
because pnpm requires a hoisted runtime tree when materializing
`bundledDependencies`. This setting is part of the reproducible package
contract and is exercised by the frozen-lockfile CI install.

The bundled `yaml` runtime is patched only to include its declared `bin.mjs`
entrypoint in the package file list. Without that file, pnpm emits a
missing-bin warning while installing the otherwise functional Guardian
tarball. The clean-install gate rejects that warning and verifies the bundled
entrypoint explicitly.

`archsync doctor` checks both global-command discovery and an explicit
`PNPM_HOME` or `PNPM_HOME/bin` entry on `PATH`; pnpm uses the latter layout on
some Windows installations. It treats either missing item as a warning during
source development and prints an actionable `pnpm setup` instruction. The
clean-prefix test requires both checks to pass when the release is installed.

## Consequences

- Source-level tests can no longer hide missing `files`, `bin`, peer dependency,
  lifecycle, shell-shim or PATH defects.
- `archsync version --json` is suitable for bug reports and experiment evidence.
- npm-registry publication can be added later without changing the package or
  CLI contract; the GitHub Release tarballs remain the verified v0.3 channel.
