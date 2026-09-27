# Module comparison preflight

Status: development implementation, not an executed external evaluation.
Adapter contract: `archsync-static-esm` 0.1.0.

## Why this is separate

The existing Guardian service analyzer detects HTTP, PostgreSQL, Redis and AMQP
relationships. Those relationships are not file imports. This adapter adds a
separate module observation for a possible capability-matched comparison; it
does not relabel the existing service graph, change its caches, or establish
an accuracy/superiority result. It is not a replacement for evaluating the
paper's service-level claims on real repositories.

The unit is an ordered pair of repository-relative TypeScript source paths,
with at least one static ESM import or re-export in the selected source scope.
An edge is counted once per pair; all declaration locations are retained.
Both explicitly type-only and unused imports are included. `type_only` describes
explicit source syntax, not whether TypeScript will erase the dependency.

## Running the development preflight

```powershell
pnpm install --frozen-lockfile
pnpm build
node scripts/module-preflight.mjs test/module-preflight/tsconfig.json test/module-preflight
node --test scripts/module-preflight.node-tests.mjs
node scripts/verify-module-development.mjs
```

The command emits JSON with the source graph, file/configuration input hashes,
exclusions, issues, and (only for complete observations) a separate Core model
whose relationship type is `dependency`. Exit 0 means the observation is complete
**within this static scope**, not that architecture rules pass or that the
repository is correct. Incomplete/invalid input exits 2; no conformance success
is emitted. `moduleArchitecture()` rejects incomplete observations.

The public API exports `analyzeModuleProject`, `moduleId` and
`moduleArchitecture`. Consumers can use Core's conformance API with a separately
authored expected model. An observed graph must never be used as independent
ground truth for the same tool.

The development verification runner captures the actual commands, exit codes,
stdout/stderr hashes, source hashes, platform and test JSON under
`.artifacts/module-development/`. It does not create accepted research evidence
or human approval. Its receipt must be retained together with the referenced
logs; a success boolean alone is not evidence of the reported checks.

## Source and failure contract

- Source population: non-declaration TypeScript/TSX/MTS/CTS files selected by
  the supplied tsconfig, with real paths contained in the specified repository.
- Resolver: the installed TypeScript version and supplied compiler options,
  including config inheritance, aliases and NodeNext usage conditions.
- Isolated modules, cycles and self-imports are retained.
- Builtins, resolved external packages and declaration-only targets are listed
  explicitly outside the internal-source population. Missing packages remain
  unresolved issues, not assumed exclusions.
- Syntax errors, unreadable source, unresolved imports, resolved targets outside
  the frozen source scope, duplicate physical source aliases, JavaScript inputs,
  empty scopes and project references cause an incomplete observation.
- Recognized dynamic imports, import-type expressions, import-equals and
  require-shaped calls are reported as unsupported. A shadowed `require` may
  conservatively cause an incomplete observation; no dependency is invented.
- Arbitrary loaders, framework injection, reflection, implicit JSX-runtime
  dependencies and runtime calls are not observed. Completeness within the
  static contract does not imply completeness of a running system.
- Analysis reads configuration/source but does not execute repository code,
  package scripts or compiler plugins. A missing file can still raise an I/O
  error, which the CLI reports with exit 2 rather than an empty success.

Input hashes bind the exact bytes read during analysis, including inherited
configs, resolution metadata, sources and loaded declarations. Paths outside
the supplied root (for example compiler libraries) can appear as `../` paths;
review these before publication. This receipt is **not** a complete frozen
repository/environment manifest: absent resolution candidates and unread files
are not captured. A research run additionally requires the full tree, lockfile,
installed package versions/hashes, OS/runtime and approval records.

## Proposed dependency-cruiser alignment and bounded development execution

Official options documentation was read on 2026-09-27:
https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md

Its documented module-system filter supports ESM; pre-compilation dependencies
must be enabled to include type/unused imports. Its tsconfig option reads
compiler options but does not adopt the tsconfig files/include/exclude scope.
Consequently a candidate configuration needs all of the following, verified
against a pinned release before use:

- ESM only, pre-compilation dependencies included, dynamic imports excluded.
- The exact same source-file population supplied separately to both tools;
  no implicit directory crawl or filter that silently loses edges.
- A common directed source/target pair definition and explicit deduplication.
- Separate accounting of unresolved, unsupported, excluded and failed cases.
- Frozen, equivalent deny/require semantics; Core's allow/require-path or
  dependency-cruiser's additional rules are not automatically equivalent.

Documentation establishes a candidate mapping, not proven tool equivalence.
No dependency-cruiser output was inspected when the initial adapter was written.
After the owner's explicit MBP-001 approval, the separate development preflight
in development/module-baseline-preflight/ executed the eight approved groups
on dependency-cruiser 18.3.0. Its first outputs and unsupported/failure mapping
are retained; no production adapter behavior was changed to match those outputs.
In particular import-type expressions are not filtered like dynamic runtime
imports, and comparator exit 0 is not conformance or syntactic validity.
The formal protocol's approval and frozen-common-subset gates still apply
before an official research execution.
Do not reject D3 repositories after seeing adapter failures: retain those cases
in execution accounting, and define exclusions before looking at predictions.

## Scientific and delivery boundary

The module tests and example here are developer-authored synthetic regression
fixtures, explicitly outside D3. Bounded comparator development outputs now
exist separately, but there is no independent label set, selected D3 repository,
official comparative experiment, effect estimate or publication-ready table.
The existing service benchmark's historical results remain unchanged.

Current engineering receipts under `evidence/phase-*-evidence.json` are rebuilt
for the changed source/package hashes by their existing generators. Their prior
versions remain at parent `7ebbd35e94ee0e5dd6ab6d4fc61d45c69a93b695` and are not
reinterpreted as measurements of this new adapter. The paper's frozen benchmark
data is separate and is not regenerated by this work.

Before an accepted external comparison: review and freeze this adapter and
the comparator version/configuration on development data; approve the sampling
and scoring plan; have the accepted independent reviewers label previously
unexposed source snapshots; freeze truth before predictions; retain both tools'
raw failures and outputs; and report per-repository outcomes and uncertainty.

The first Windows all-suite run exposed four POSIX-only filename creation tests
and one genuine Git path normalization bug in the parent hardening branch.
The fix preserves literal backslashes in Git records and Git object lookups.
Two additional filesystem regressions cover literal backslashes. These six
filesystem tests are explicitly skipped on Windows only; parser coverage still
runs everywhere, and the filesystem cases remain enabled on POSIX. A skip is
not a passed test.
