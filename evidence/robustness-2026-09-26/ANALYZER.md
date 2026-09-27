# Analyzer adversarial regression evidence — 2026-09-26

This is developer-authored regression evidence, not an independent held-out evaluation or a claim of population precision/recall. No paper retrieval was required.

## Intervention and result

The new `src/analyzer-adversarial.test.ts` contains 18 cases. Against the repository HEAD analyzer (before this intervention), **15 failed and 3 passed**. Against the modified analyzer, **18 passed**, and the existing analyzer suite also passed (**12 cases**, 30 total). See `analyzer-before.txt` and `analyzer-after.txt`. The before run used the exact same final test file as the after run; an initial development run with an incorrectly selected self-edge positive control was discarded, and both runs were repeated after correcting the control.

Confirmed and repaired failure classes:

- Type-only default, namespace, and named imports were incorrectly treated as runtime client bindings.
- PostgreSQL and Redis detectors accepted incompatible URL protocols, and fetch accepted non-HTTP targets.
- Comparison and subtraction expressions could be mistaken for URL strings.
- Bare identifier maps confused imported constructors, resource receivers, endpoints, `fetch`, and `process` with local shadowing bindings.
- Same-named endpoint variables in sibling functions overwrote each other; block-local variables leaked outside their scope.

The implementation binds each source file using the installed TypeScript compiler's symbol checker with dependency resolution and library loading disabled. Identifier identity is based on its bound declaration, not spelling. It does not execute source code or access imported packages. Supported alias imports, captured resources, unshadowed fetch, and existing protocol/fallback fixtures remain detected.

## Reproduction

Working directory: `archsync-guardian`. Runtime: Node.js 22.16.0, supplied by adding `/Users/andytran/.npm/_npx/2ad0c2d1aba2dd61/node_modules/node/bin` to PATH.

- Before: repository HEAD `src/analyzer.ts`, then `pnpm test src/analyzer-adversarial.test.ts` (exit 1, expected).
- After: modified `src/analyzer.ts`, then `pnpm test src/analyzer-adversarial.test.ts src/analyzer.test.ts` (exit 0).
- Static check: `pnpm typecheck` (exit 0; `analyzer-typecheck.txt`). This builds tracked distribution artifacts as part of the repository's existing command.

The parent integration run owns the final full-suite result; this record does not claim a full-suite run.

## Limits and residual threats

This improvement does not make the analyzer sound or complete. It still uses a bounded, flow-insensitive four-pass variable propagation, environment-variable naming conventions, heuristic URL concatenation/template handling, and a single chosen fallback target. Runtime reassignment, conditional control flow, alternative fallback destinations, malformed/dynamic URL composition, inter-file aliases, custom wrappers, and unsupported syntax can cause omissions or misleading edges. Declared local/ambient fetch or process names are conservatively treated as bindings, not assumed to be the platform global. Type-only runtime-use cases deliberately include invalid TypeScript because the analyzer accepts source files without a prior compilation gate; these are robustness checks, not representative production samples.

The symbol checker adds per-file program construction work. This run measures correctness, not a representative performance distribution. The deterministic numeric evidence confidence values remain heuristic labels and must not be interpreted as calibrated probabilities. Additional independent real-project ground truth and independent human adjudication are still needed for external-validity claims.

## Semantic version and cache compatibility

The hardened analyzer is now version **0.3** (observed graph schema remains 0.1). Current version/compatibility metadata and tests use this version; the Git gate incorporates the analyzer version in its cache key and validates cached graph version identity. This prevents reuse of pre-hardening 0.2 graphs. Frozen historical evidence and vendored packages were not rewritten. `VersionResult` now derives its analyzer version type from the shared constant to avoid duplicate literals. Current README documents the transition.

After this version change: `pnpm typecheck`, the targeted version/compatibility/Guardian/repair-verification suites, and `pnpm core:compatibility:verify` all exit 0. See `analyzer-version-*.txt` for exact output. The incremental-test owner updated its fixture to use the shared version constant.

## Compiler-host coverage boundary

The source and text lookups use native in-memory Map bindings; the unused optional directory callback was removed. The two TypeScript-required adapters `writeFile` and `getNewLine` carry individual `v8 ignore next` comments because this program only binds symbols, never emits output, and never formats diagnostics. These exclusions cover only those inert adapters, not endpoint inference, binding decisions, or any detector logic. No tests invoke unused adapters artificially. Focused analyzer coverage including the incremental component-filter exercise passes **100% statements, branches, functions, and lines**; see `analyzer-focused-coverage.txt`. Command: `pnpm test src/analyzer.test.ts src/analyzer-adversarial.test.ts src/phase3.test.ts --coverage --coverage.include=src/analyzer.ts`. Final typecheck also passes. Full-project coverage remains the integration owner's responsibility.

## Second adversarial intervention: URL concatenation and stale assignments

Review identified two additional faults: choosing the URL-looking right operand of addition changed `https://actual/` + `https://wrong/` into an edge to `wrong`; a reassigned client retained its old resource provenance. Eight new tests were run before the fix: the cumulative 26-case suite had **7 failures, 19 passes** (`analyzer-concat-mutation-before.txt`). After implementation, three further boundary/control tests were added for cyclic aliases, parenthesized concatenation, and the retained fallback heuristic. The cumulative adversarial suite now has **29 tests**, all passing. Together with the original analyzer and Phase 3 suites, **53/53 pass**, with focused analyzer coverage **100%** on all four measures (`analyzer-concat-mutation-after.txt`). This before/after pair has different test counts because the three controls were added after the intervention; the seven original failing cases are retained unchanged.

Addition is now interpreted only when every operand resolves to a static string literal or constant string alias. The complete result is parsed as a URL; cyclic aliases and unknown/non-string operands cause abstention. The old positive fixture `http://binary-left:3000` + `v1` actually contains an invalid port. Its suffix was corrected to `/v1`, and the exact invalid-port case is now a separate negative regression. Previously frozen results are not reclassified as valid evidence by this fixture correction.

Any direct identifier assignment (including compound assignment) conservatively invalidates that variable's inferred endpoint/resource throughout the file. This also suppresses legitimate uses *before* the assignment: a deliberate precision/recall tradeoff, explicitly tested. Unaffected sibling bindings retain detection. This is not full flow-sensitive mutation analysis: property writes, destructuring writes, unary updates, imported constructor rebinding and dynamically composed templates/fallbacks remain outside this repair. Unknown does not mean the architecture lacks the relationship. Static concatenation may miss runtime-computed valid URLs, and the remaining environment/fallback/template heuristics retain their documented limitations.

Final `pnpm typecheck` passes (`analyzer-concat-mutation-typecheck.txt`). Source hashes below were refreshed after this intervention. The analyzer remains the unreleased current version 0.3, covering both interventions; the parent integration run must regenerate current evidence after these final changes.
