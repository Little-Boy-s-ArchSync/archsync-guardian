# Vendored Core package for private-repository CI

`archsync-core-0.1.0.tgz` is the `pnpm pack` output of private repository `archsync-core` at commit:

```text
f2ffb1ae72f02822b2f8d39c5c6a8d5c0acf98c6
```

SHA-256:

```text
967c2fe1d93ac370276d0aa18d0a3c69f79ee53b02bd67946f45fbf1a1dfd69b
```

Guardian declares Core as a peer dependency for consumers. This tarball is a reproducible package artifact used only so Guardian's own clean-clone CI can install and test without a cross-repository credential.

Regenerate from the pinned clean Core checkout:

```powershell
cd "D:\Little Boys\ArchSync\archsync-core"
pnpm phase1:verify
pnpm pack --pack-destination "D:\Little Boys\ArchSync\archsync-guardian\vendor"
```

After regeneration, update the commit/hash above, run `pnpm evidence:update` and verify both repositories.
