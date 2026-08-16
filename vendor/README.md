# Vendored Core package for private-repository CI

`archsync-core-0.1.1.tgz` is the `pnpm pack` output of private repository `archsync-core` at commit:

```text
f7812c471887029951b5e5ad4105a72f0b29d0ed
```

SHA-256:

```text
900e5f9347b41eace9568ad5fd930ac67ebccb4cefe27ed6a5bd31ec8dbb0c42
```

Guardian declares Core as a bundled runtime dependency. This tarball is a reproducible package artifact so Guardian's clean-clone CI and published package can install and run without a cross-repository credential.

Regenerate from the pinned clean Core checkout:

```powershell
cd "D:\Little Boys\ArchSync\archsync-core"
pnpm phase1:verify
pnpm pack --pack-destination "D:\Little Boys\ArchSync\archsync-guardian\vendor"
```

After regeneration, update the commit/hash above, run `pnpm evidence:update` and verify both repositories.
