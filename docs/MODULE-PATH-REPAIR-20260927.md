# Module adapter directory-alias repair

The first hosted PR #16 run found five real failing module-adapter tests on
macOS: [run 36307472139](https://github.com/Little-Boy-s-ArchSync/archsync-guardian/actions/runs/36307472139),
job 108586814973, head `fa67715b82a63e94fffc5ad01440596623bfc40e`.
Root paths were canonicalized but configuration paths were not. The macOS
`/var` to `/private/var` alias then generated incorrect relative module IDs
and caused conformance rules referring to the intended paths not to match.

Adapter 0.1.1 canonicalizes both paths before parsing/resolution. A regression
uses a real directory symlink (Windows junction) and compares complete graphs,
IDs, hashes and evidence through original and aliased entry points. It also
checks that contained inputs do not acquire escaping relative paths. Existing
outside-repository and duplicate-source-alias rejection remains enforced.

The MBP-001 raw records remain historical 0.1.0 development evidence; they are
not rewritten as a 0.1.1 execution or cross-platform success. The original
macOS failure remains available above. Hosted validation of the repaired
head must pass before merge. This repair is not a D3 run or accuracy result.
