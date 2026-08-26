# Vendored Core package for private-repository CI

`archsync-core-0.1.1.tgz` is the byte-reproducible `pnpm pack` output of private repository `archsync-core` at the exact merged `main` commit used by Guardian:

```text
1e8bbdd8342d833aad50e8fbcefde15d65a807e6
```

SHA-256:

```text
550051461cbd6774b8f92df82ba923c3c9a0b95d82cfe4a8f7f49e21c3697a13
```

The source commit is the merge result of Core pull request [#1](https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/1). The machine-readable attestation is [`archsync-core-0.1.1.provenance.json`](archsync-core-0.1.1.provenance.json). Two independent clean `pnpm pack` runs under Node 22.16.0 and pnpm 11.16.0 produced byte-identical artifacts with the SHA-256 above.

Guardian declares Core as a bundled runtime dependency. This tarball lets Guardian's clean-clone CI and package verification install and run without cross-repository credentials.

Regenerate from a clean detached checkout of the pinned commit (example shown in PowerShell; choose any temporary path outside both repositories):

```powershell
git clone https://github.com/Little-Boy-s-ArchSync/archsync-core.git "D:\Temp\archsync-core-1e8bbdd"
cd "D:\Temp\archsync-core-1e8bbdd"
git checkout --detach 1e8bbdd8342d833aad50e8fbcefde15d65a807e6
pnpm install --frozen-lockfile
pnpm phase1:verify
pnpm pack --pack-destination "D:\Little Boys\ArchSync\archsync-guardian\vendor"
```

Pack twice into separate empty directories and compare SHA-256 values before replacing the vendored artifact. Then run `pnpm install`, `pnpm evidence:update`, `pnpm phase3:evidence:update`, and `pnpm phase3:verify`. The compatibility verifier rejects a package/provenance/hash mismatch.
