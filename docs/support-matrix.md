# Guardian support matrix and limitations

This is the operational contract for Guardian v0.3.3 on the exact Core dependency recorded in the [Core–Guardian compatibility map](contract-compatibility.md). “Supported” means the behavior has a deterministic fixture and an enforced verification path; it does not mean arbitrary code with a similar method name will be inferred.

## Runtime and contract support

| Area | Supported | Notes |
| --- | --- | --- |
| Operating systems | Ubuntu, Windows, macOS | The pull-request matrix performs a frozen install, full verification, clean package install, and committed build/evidence check on each OS. |
| Node.js | `>=22`; CI uses Node 22 | Older Node versions are unsupported. `archsync doctor` checks the active runtime. |
| pnpm | project pin `11.16.0` | CI and reproduction commands use the pinned version and frozen lockfile. |
| Git | available on `PATH` | Required by diff mode, package provenance, demo cases, and doctor checks. Full-repository Phase 2 scans do not otherwise need Git. |
| Core package | `@archsync/core` `0.1.1` from integration commit `503b5fe97aa39a78d5e5de80b794a94508e106cc` | The package checksum is pinned; open Core integration PR #3 is not treated as released. |
| Architecture Model | current `0.1.1`, previous `0.1.0`, deprecated alias `0.1` | Current and previous replay identically. Unknown versions are rejected. |
| Core graph/finding/evidence/conformance/CLI JSON | `1.0.0` | Core-owned records remain Core-owned; Guardian source records use the Guardian versions below. |
| Guardian analyzer / observed / finding / source evidence / result | `0.2` / `0.1` / `0.1` / `0.1` / `0.1` | Source evidence is versioned by the containing observed or finding envelope. |

## Parsed source surface

Guardian scans `.ts`, `.tsx`, `.mts`, and `.cts` files with the TypeScript compiler API, skips `.d.ts`, and ignores `.git`, `coverage`, `dist`, `node_modules`, and `tmp` directories. Component IDs come from the longest architecture component ID matching the beginning of a repository-relative path; otherwise the first path segment is inferred.

Every detector below is bound to a committed source fixture and to the generated [`detector_fixture.source_evidence`](../evidence/phase-2-evidence.json) records.

| Detector | Supported signal | Direct fixture | Evidence |
| --- | --- | --- | --- |
| `component-root` | Deterministic source-component anchor when no relationship call site is available | [`utility/src/index.ts`](../test/fixtures/detectors/repository/utility/src/index.ts) | [Phase 2 manifest](../evidence/phase-2-evidence.json) |
| `typescript-fetch` | Global `fetch()` whose argument resolves to HTTP(S), a tracked URL variable, a template/binary expression, or `process.env.*_URL` | [`frontend/src/app.ts`](../test/fixtures/detectors/repository/frontend/src/app.ts) | [Phase 2 manifest](../evidence/phase-2-evidence.json) |
| `typescript-pg` | `query()` on a `Client`/`Pool` created from a tracked named, aliased, default, or namespace `pg` import with `connectionString` | [`service/src/postgres.ts`](../test/fixtures/detectors/repository/service/src/postgres.ts) | [Phase 2 manifest](../evidence/phase-2-evidence.json) |
| `typescript-redis` | Supported Redis operation on a client created from a tracked named, aliased, default, or namespace `redis` import with `url` | [`service/src/redis.ts`](../test/fixtures/detectors/repository/service/src/redis.ts) | [Phase 2 manifest](../evidence/phase-2-evidence.json) |
| `typescript-amqp-publish` | `publish()` or `sendToQueue()` on a channel derived from a tracked `amqplib` connection | [`service/src/publisher.ts`](../test/fixtures/detectors/repository/service/src/publisher.ts) | [Phase 2 manifest](../evidence/phase-2-evidence.json) |
| `typescript-amqp-consume` | `consume()` on a channel derived from a tracked `amqplib` connection; direction is queue → consumer | [`worker/src/consumer.ts`](../test/fixtures/detectors/repository/worker/src/consumer.ts) | [Phase 2 manifest](../evidence/phase-2-evidence.json) |

Endpoint protocols are HTTP/HTTPS, PostgreSQL/Postgres, Redis/Rediss, and AMQP/AMQPS. `DATABASE_URL` maps to `postgres`, `REDIS_URL` to `redis`, queue/event/AMQP URL variables to an async endpoint, and other `*_URL` variables to an HTTP service. Redis operations are `get`, `set`, `del`, `mGet`, `mSet`, `hGet`, `hSet`, `hDel`, `lPush`, `rPush`, `lPop`, `rPop`, `sAdd`, `sRem`, `zAdd`, `zRem`, and `expire`.

## Explicit limitations

The analyzer is intentionally provenance-aware and conservative. The following are unsupported unless a future detector and challenge fixture add them:

- JavaScript, Python, Java, Go, IaC, generated artifacts, runtime traces, and network observations;
- HTTP clients other than the recognized global `fetch` shape;
- PostgreSQL, Redis, or AMQP wrappers that hide the tracked package import/client/channel behind another function, class, dependency-injection container, or module;
- dynamic `require()`, computed imports, computed property names, arbitrary object spreads, or configuration loaded from an unknown helper;
- interprocedural data flow, returned clients/channels, destructured client methods, reassigned bindings, and values available only at runtime;
- custom protocols and opaque endpoint strings that cannot be resolved from the supported literal/environment expressions;
- interpreting an unrelated object's `query`, `get`, `publish`, `sendToQueue`, or `consume` method as infrastructure access.

An unsupported pattern produces no relationship, not a guessed low-confidence edge. The separate hard-negative corpus guards against method-name lookalikes. Review a repository's Observed Graph and detector challenge result before relying on the gate for a new coding style.

## CLI exits

| Exit | Source `check` / Git diff | Model commands and other commands |
| ---: | --- | --- |
| `0` | `PASS` / no-impact | successful validation, rendering, benchmark, diagnostics, or demo |
| `1` | deterministic `BLOCK` / violation | invalid model for model-only validation/check, failed benchmark, or model conformance violation |
| `2` | invalid source model, arguments, Git state, runtime, or internal error | usage error, failed doctor/demo precondition, unsupported output, or uncaught error |
| `3` | `REVIEW` / non-forbidden architecture evolution | model conformance evolution |

Expected `BLOCK` and `REVIEW` demo cases are treated as successful demonstrations; the demo exits `2` only if the measured scenario does not match its ground truth or a precondition fails.

## Configuration and precedence

Guardian has no hidden project configuration file and does not read live endpoint values from the process environment during analysis. The architecture path and repository path supplied on the command line are authoritative.

1. Explicit CLI options win (`--diff`, `--cache-dir`, `--no-cache`, `--json`, `--github`, and `--report`).
2. When `--cache-dir` is absent, diff mode uses its Git-internal cache default; `--no-cache` disables reuse regardless of the directory.
3. Environment variables are operational only: `GITHUB_STEP_SUMMARY` selects the GitHub summary destination, while `PATH` and `PNPM_HOME` are inspected by doctor/package checks. They do not override architecture or detector configuration.
4. Endpoint-like `process.env.NAME` expressions found in scanned source are static syntax signals. Guardian does not read the runtime value of `NAME`.

## Upgrade and rollback

Follow the [Core 0.1.0 → 0.1.1 guide](migrations/core-0.1.0-to-0.1.1.md). A Core change is not accepted by editing only `package.json`: re-pack the exact reviewed commit, update its provenance/checksum, frozen-install it, replay current and previous fixtures, regenerate both evidence manifests, and run the full package matrix. Roll back by restoring the previous reviewed vendored artifact, provenance, lockfile, generated build, and evidence as one commit, then rerun the same gates.
