# MBP-001: retained development preflight

This folder contains developer-authored synthetic fixtures, an isolated
dependency-cruiser installation manifest and raw execution records. These are
engineering observations, not D3, independently labeled data, accuracy estimates
or an accepted external-baseline experiment.

The owner approved MBP-001 v0.1.0 on 2026-09-27 in the active conversation:
"Duyệt MBP-001: chỉ kiểm thử phát triển". The corresponding paper repository
plan and authorization bind SHA-256
`1608cfb45fe1a2fd060a9aeaed02ae86bc9f8ecad7d8a1093c89ce58f3746b3e`.
Do not extend this authorization to D3, rules or publication claims.

## Execution

Node 22.16.0 on Windows x64; dependency-cruiser 18.3.0 and TypeScript 5.9.3.
The runtime package was installed with lifecycle scripts disabled into
comparator/node_modules, separate from Guardian's production dependencies.
The comparator's package-lock integrity matches the pinned plan. No subject
application was executed. M6 resolves the already installed yaml dependency;
this is not a synthesized successful package lookup.

`install.mjs <absolute npm-cli.js>` retains installation stdout/stderr and a
complete installed-file hash inventory. `run.mjs` retains a timestamped run and
refuses to overwrite individual receipt files. Node, commands, source/config
hashes, selected files, raw graph, stderr, exit code and timeout state are kept.
Use `node development/module-baseline-preflight/verify.mjs` to verify the retained
run without rerunning either tool. Future dependency reinstalls should use
`npm ci --ignore-scripts --no-audit --no-fund` with this lockfile; a new run needs
its own retained receipt and must remain within the approved development scope.

Source selection is computed from TypeScript config before either graph runs.
The same explicit file list is supplied to dependency-cruiser. Its doNotFollow
pattern prevents traversal beyond the selected sources but retains boundary
dependencies in the native graph. No includeOnly filter silently discards them.
The empty population is recorded as not executed rather than invoking the CLI
without arguments and accidentally scanning a directory.

Released option definitions were inspected in dependency-cruiser 18.3.0's
types/options.d.mts, types/filter-types.d.mts and src/cli/index.mjs. Each raw
JSON graph records effective moduleSystems=['es6'], tsPreCompilationDeps=true,
exclude.dynamic=true and its tsconfig. Options documentation alone was not
treated as an observed compatibility result.

## First run observations

Install: receipts/2026-09-27T08-03-02.950Z-install.
Extraction: receipts/2026-09-27T08-05-53.210Z-extraction.
Guardian input head: 6fb5ebef7910ccd03d6047323f554aafe8938c27.
Eight planned groups contain thirteen small configurations. Guardian was
invoked thirteen times; dependency-cruiser twelve times, with one explicit
empty-scope non-execution. No tool repair, rerun or discarded failure occurred.

| Group | Observation and interpretation |
| --- | --- |
| M1 | Static import and named/default/star re-exports produce the same three directed pairs. |
| M2 | Type-only and unused imports remain in both graphs before compilation: two pairs. |
| M3 | Both graphs deduplicate three declarations into one pair. Guardian retains lines 1, 2 and 3; the tested native comparator JSON does not expose those declaration locations. This does not establish an overall evidence-localization advantage. |
| M4 | Isolated module, two-node cycle and self-import are retained; three directed pairs match. |
| M5 | Explicit files, include/exclude plus inherited alias, and NodeNext .js substitution each yield the same selected population and one pair. This is not a proof for all resolver configurations. |
| M6 | One internal pair matches. Builtin, external yaml and local .d.ts remain separately visible outside the internal-source population. |
| M7 | Guardian exits 2 for unresolved target, out-of-scope target, syntax error and empty scope. The first three comparator invocations exit 0; native boundary/unresolved data is retained. Empty comparator scope is not executed. Equal empty pair sets are not accepted successes. |
| M8 | Guardian reports unsupported dynamic import, CommonJS/import-equals and import-type syntax. Comparator filtering leaves the static edge AND a type-expression edge. Its two-pair graph differs from Guardian's one partial pair; the case is not scored as a complete observation. |

Thus a nonempty common static-module pair unit is observed on development
inputs, but the configurations are not interchangeable for arbitrary TypeScript.
Eight complete-source configurations show pair compatibility; the five
incomplete/unsupported configurations remain unscored. This is not an accuracy
fraction and no percent or precision/recall score is reported.

dependency-cruiser was run with no architecture rules. Its exit 0 therefore
does not mean architectural conformance or even valid TypeScript. M7 does not
prove a bug in a dependency extractor that was not asked to validate syntax.
No deny/require/allow/path or PR-decision equivalence was evaluated. Service
HTTP/database relations are not file imports. Do not relabel this test as a
head-to-head evaluation of the existing service analyzer.

## Stopping point

The eight-group preflight is complete with the unsupported mapping retained.
No production analyzer behavior changed in response to comparator output.
Do not select or exclude real repositories based on these results after
examining their predictions. Before D3, separately approve and freeze the
source/syntax eligibility rule, whole-case failure accounting, semantic rule
mapping, independent role declarations, sampling and hidden labels. The owner
must decide whether the proposed narrow module experiment addresses a useful
research question; it cannot replace evidence for service-architecture claims.

Receipts contain local absolute working-directory paths and public dependency
metadata, not API keys or private reviewer labels. They are development records
and must not be copied into the manuscript's frozen historical evidence bundle.
