# Vendored Core package for private-repository CI

`archsync-core-0.1.0.tgz` is the `pnpm pack` output of private repository `archsync-core` at commit:

```text
304f4ac48137e011ec5f7fd85071a89502c02ada
```

SHA-256:

```text
ea2727f9d5646b85385b67f60b83d5eed8ee39af590667722e197873b23d5a2e
```

Guardian declares Core as a peer dependency for consumers. This tarball is a reproducible package artifact used only so Guardian's own clean-clone CI can install and test without a cross-repository credential.

Regenerate from the pinned clean Core checkout:

```powershell
cd "D:\Little Boys\ArchSync\archsync-core"
pnpm phase1:verify
pnpm pack --pack-destination "D:\Little Boys\ArchSync\archsync-guardian\vendor"
```

After regeneration, update the commit/hash above, run `pnpm evidence:update` and verify both repositories.
