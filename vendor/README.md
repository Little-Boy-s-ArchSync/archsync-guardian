# Vendored Core package for private-repository CI

`archsync-core-0.1.1-integration-503b5fe.tgz` is the byte-reproducible `pnpm pack` output of private repository `archsync-core` at the exact integration commit used by this branch:

```text
503b5fe97aa39a78d5e5de80b794a94508e106cc
```

SHA-256:

```text
7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9
```

The source commit is the head of merged Core integration pull request [#3](https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/3). It combines CORE-101 pull request #1 commit `a1f0143aa8eb917aa0d93e28101b1893347453e2` and proposed Phase 6 quality-goal commit `783716d7961690b1e8c1cda4acb956777977a853`; merge status is not a claim that the package is released. The active machine-readable attestation is [`archsync-core-0.1.1-integration-503b5fe.provenance.json`](archsync-core-0.1.1-integration-503b5fe.provenance.json). Two independent clean `pnpm pack` runs under Node 26.0.0 and pnpm 11.16.0 produced byte-identical artifacts with the SHA-256 above.

`archsync-core-0.1.1.tgz` and its matching provenance file retain the exact CORE-101 PR #1 package as a compatibility reference. Guardian installs the integration artifact above so the same tested dependency also exposes the proposed quality-goal contract required by the Phase 6 foundation.

Guardian declares Core as a bundled runtime dependency. This tarball lets Guardian's clean-clone CI and package verification install and run without cross-repository credentials.

Regenerate from a clean detached checkout of the pinned commit (example shown in PowerShell; choose any temporary path outside both repositories):

```powershell
git clone https://github.com/Little-Boy-s-ArchSync/archsync-core.git "D:\Temp\archsync-core-503b5fe"
cd "D:\Temp\archsync-core-503b5fe"
git checkout --detach 503b5fe97aa39a78d5e5de80b794a94508e106cc
pnpm install --frozen-lockfile
pnpm phase1:verify
pnpm pack --pack-destination "D:\Temp\archsync-core-package"
```

Pack twice into separate empty directories and compare SHA-256 values before replacing the vendored artifact. Then run `pnpm install`, `pnpm evidence:update`, `pnpm phase3:evidence:update`, and `pnpm phase3:verify`. The compatibility verifier rejects a package/provenance/hash mismatch.
