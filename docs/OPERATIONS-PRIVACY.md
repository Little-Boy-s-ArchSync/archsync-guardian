# Operational privacy and diagnostics contract

ArchSync's deterministic model, scan, check, Git-diff, doctor, version, and demo paths are offline by default. The packaged runtime contains no telemetry client and imports no network transport module. It reads only the paths and Git references explicitly supplied by the operator. AI/provider integrations are outside this package and must be an explicit, separately reviewed boundary.

## Data handling

- Source files are parsed locally. No source, architecture model, finding, or metric is transmitted.
- Evidence paths are repository-relative. Machine-specific workspace and home roots in diagnostics are rendered as `$WORKSPACE` and `$HOME`.
- Common API tokens, bearer values, URL passwords, secrets, and email addresses are replaced before evidence snippets or unexpected errors reach terminal output.
- Evidence snippets remain part of JSON output because they are necessary to audit a finding. The snippet is capped at 180 characters and credential-redacted. Treat requested JSON/report files as project data.
- Preparatory provider prompts redact every untrusted string field in the finding/evidence envelope, including IDs, kinds, rule IDs, messages, evidence text and file paths. Arbitrary POSIX, Windows-drive and UNC absolute paths are removed from free text as well as path fields. Provider errors, identifiers, timestamps and raw-artifact paths are redacted before entering a persisted run manifest; raw response content never enters that manifest. Each provider attempt has a runner-owned timeout and abort signal, and an optional caller signal cancels both an in-flight transport and retry backoff with a fixed, redacted failure. The current fake-provider scaffold treats `raw_response_path` as metadata and never writes response content to the filesystem. A future real-provider adapter must implement governed retention only after named privacy and security reviewers approve the provider, storage location, access controls, retention period, and deletion route.
- `--verbose` is opt-in and adds deterministic finding detail only; it does not enable network access or telemetry.

## Temporary data and cache

- Demo, benchmark, package-install, and Git-baseline workspaces use the operating system temporary directory and are removed in `finally` blocks on success and failure.
- The Git baseline cache defaults to Git's private metadata area (`.git/archsync-cache`). A custom `--cache-dir` is resolved inside the requested repository. Cache entries contain normalized observations, not credentials, and may be deleted at any time.
- Reports are persisted only when the operator supplies an output path. ArchSync never chooses a long-lived report directory on its own.
- `ARCHSYNC_KEEP_TEST_TEMP=1` is a test-only diagnostic escape hatch and must not be enabled in CI or routine use.

## Mechanical gates

`pnpm privacy:verify` rejects new runtime network imports or unreviewed production dependencies. The allowlist contains Core, TypeScript and the local-only YAML parser used for architecture and Kubernetes documents; none is an outbound transport. Tests exercise token, PII, URL credential, local-path, source-snippet, and error redaction. `pnpm repo:verify-clean` runs the complete verification suite and proves that it leaves the worktree unchanged.

Any change that introduces outbound access, telemetry, a new persistent cache, or less redaction is a breaking operational-policy change and requires a security review.
