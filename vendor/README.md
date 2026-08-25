# Vendored Core package for private-repository CI

`archsync-core-0.1.1.tgz` is the byte-reproducible `pnpm pack` output of private repository `archsync-core` at the exact commit used by this dependency PR:

```text
a1f0143aa8eb917aa0d93e28101b1893347453e2
```

SHA-256:

```text
60a00d267fc217922659b5c527067a7d7792cdf40d3e6f81219c5f7328bd6f80
```

The source commit is the head of Core pull request [#1](https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/1), not a claim that the pull request is merged or released. The machine-readable attestation is [`archsync-core-0.1.1.provenance.json`](archsync-core-0.1.1.provenance.json). Two independent clean `pnpm pack` runs under Node 26.0.0 and pnpm 11.16.0 produced byte-identical artifacts with the SHA-256 above.

Guardian declares Core as a bundled runtime dependency. This tarball lets Guardian's clean-clone CI and package verification install and run without cross-repository credentials.

Regenerate from a clean detached checkout of the pinned commit (example shown in PowerShell; choose any temporary path outside both repositories):

```powershell
git clone https://github.com/Little-Boy-s-ArchSync/archsync-core.git "D:\Temp\archsync-core-a1f0143"
cd "D:\Temp\archsync-core-a1f0143"
git checkout --detach a1f0143aa8eb917aa0d93e28101b1893347453e2
pnpm install --frozen-lockfile
pnpm phase1:verify
pnpm pack --pack-destination "D:\Little Boys\ArchSync\archsync-guardian\vendor"
```

Pack twice into separate empty directories and compare SHA-256 values before replacing the vendored artifact. Then run `pnpm install`, `pnpm evidence:update`, `pnpm phase3:evidence:update`, and `pnpm phase3:verify`. The compatibility verifier rejects a package/provenance/hash mismatch.
