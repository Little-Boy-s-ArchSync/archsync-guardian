# Preparatory provider evidence recorder

Status: **UNREVIEWED — no provider execution or storage approval**.

P4-106 has an in-memory run manifest and an artifact-path metadata
field. The opt-in fixture bridge described below connects that runner to byte
capture; the product runner still performs no filesystem writes. The separate
`scripts/provider-evidence.mjs` primitive prepares the recording boundary using
explicitly supplied, already received bytes. It does not call a provider, read
credentials, choose a model, collect source files, import a transport, or change
the runner's existing no-filesystem-write contract.

`createProviderEvidencePacket(input)` snapshots the supplied request and each
response Buffer into a canonical JSON packet. The packet preserves byte count,
SHA-256 and base64, so whitespace, CRLF and Unicode bytes survive unchanged. The
caller must supply provider, model, model version, prompt version, run ID, origin,
UTC timestamps, ordered attempts, explicit outcomes, failure reasons and measured
usage. No clock, model version, successful outcome, cost or missing measurement
is inferred. Unknown usage remains null. Failure records can retain received
response bytes and usage, including rejected over-budget responses. A response
alone cannot become success. Supplied success means only the caller's attempt
outcome; it is not contract validation, correctness, research acceptance, or a
claim of provider authenticity.

The primitive requires 1–8 populated attempts numbered consecutively from 1; it refuses a
retry after success, an outcome inconsistent with the final attempt, reversed or
overlapping timestamps, unknown fields, non-finite usage, or unsafe run IDs.
Requests are limited to 256 KiB, each response to 1 MiB, total responses to 4 MiB,
and the serialized packet to 6.5 MB. These are implementation bounds, not approved
experiment budgets. Pre-call failures with zero attempts are outside this
received-attempt artifact format and remain in the existing runner manifest.

Only valid UTF-8 content is accepted. Known credential, email and absolute-path
patterns are checked with the existing diagnostic redactor. JSON content is also
checked recursively after decoding escapes, including credential-key rejection
unless the value is exactly `[REDACTED]`. Duplicate decoded JSON object keys are
rejected before last-key-wins parsing can conceal the original retained content.
Run IDs receive both portable syntax and diagnostic-redaction checks before use
in a packet or filename. Input is rejected rather than silently
modified. JSON nesting is bounded at 32 levels; text with diagnostic markers must
have physical lines no longer than 4096 characters before the regex scanner is
used. These finite checks are not a guarantee that every secret or form of PII is
detected. The caller must apply the separately approved data-minimization and
redaction process before supplying actual content. Retaining original unredacted
responses would require its own reviewed, governed storage boundary.

`persistProviderEvidence(directory, input)` accepts an existing owner-only POSIX
directory selected by the caller. It rejects symlink aliases and unsuitable
permissions. A random exclusive temporary file is written, synced and made 0400;
an atomic hard link publishes `<run_id>.provider-evidence.json` only if that name
does not exist. The temporary link is removed. Repeated and simultaneous writers
cannot overwrite an earlier artifact, and no partial final artifact is visible.
The function snapshots input before filesystem awaits and checks the directory's
identity and permissions again before publication.

This is an append-only API and an owner-read-only file, not tamper-proof storage:
the trusted directory owner or an administrator can still change files or replace
the directory. A concurrently hostile storage owner is outside the boundary.
Publication is atomic, but crash recovery and durable directory-entry syncing
are not supplied; a crash may leave a private temporary file or require operator
recovery. Cleanup errors are surfaced. Windows storage is explicitly refused
until a reviewed ACL implementation exists; portable serialization checks still
run on Windows.

`verifyProviderEvidencePacket(bytes, expectedSha256)` requires a digest retained
separately by the caller, checks exact artifact hashes and canonical serialization,
and reruns the structural checks. A hash obtained from the same untrusted file
does not authenticate it. Every packet remains `UNREVIEWED_PROVIDER_EVIDENCE` and
uses either `synthetic` or `caller-supplied-unverified` origin. This schema is a
preparatory artifact envelope, not a replacement for the runner or Benchmark run
manifest. Those integrations must preserve their own exact configuration and
request bindings before real execution.

## Injected fixture runner bridge

`scripts/provider-runner-evidence.mjs` connects `executeReasonerRun` and
`OpenAICompatibleProvider` to the recorder. `executeProviderEvidenceRun(input,
dependencies)` requires an explicit transport callback, clock and retry wait;
there is no default network implementation or credential loader. The endpoint
is fixed to `https://fixture.invalid/chat/completions`, authorization headers are
not passed to the injected callback, and every artifact is marked `synthetic`.
This implements and tests the capture boundary with offline fixtures. It is not
a deployed provider adapter, proof of remote provider identity or authorization
for live traffic. An injected callback is trusted executable code; this function
is not an OS network sandbox for a hostile callback.

Input contains the run ID, explicit provider/model/model version/prompt version,
prompt, reliability policy and optional temperature/seed. Callers cannot supply
attempts, success flags, parsed responses, credentials or a replacement endpoint.
Configuration and request content are checked and copied before execution. The
transport receives the actual immutable request body string from the existing
provider adapter, request/configuration hashes, run ID, attempt number, timeout,
and cancellation signal. It returns only `{ status, bytes }`, where `bytes` is a
Buffer containing the complete original response. The bridge snapshots those
bytes before parsing them; it retains HTTP errors, malformed responses and
over-budget responses as failed attempts. Valid measured usage, including
explicit cost, is required for success; missing cost is not inferred to be zero.
The runner's validation and budget checks determine outcomes.

The packet's `request` field is a canonical capture-context envelope. Its
`http_request.body` is the exact HTTP request string, accompanied by its SHA-256
and a snapshot of the full configuration. `observed_execution` binds the entire
returned runner manifest and each observed HTTP status. This preserves secondary
failures during retry backoff as well as the primary `attempt.failure` recorded
by the existing packet format. Packet verification checks this envelope's bytes
and hash; it does not independently replay the runner or authenticate a provider.
Keep the returned packet digest separately as with the underlying primitive.

Timeout/cancellation closes the current attempt and signals the callback. A late
callback result cannot mutate a finished attempt or manufacture success. Only
complete responses received before termination are captured; streaming chunks
and bytes arriving after termination are outside this complete-response callback
contract. The bridge does not claim an ignored abort stopped remote computation.
Every actual callback invocation must represent one attempt without hidden
internal retries; a future transport must expose any lower-level retries or
streaming through a separately reviewed interface.

Content which violates the existing size, UTF-8, duplicate-key or redaction
checks fails closed: the result is failed, `capture_issue` explains the rejection,
and `evidence` is null. No sanitized substitute is presented as original bytes.
If the complete journal/context exceeds packet metadata or size limits, the
runner result is returned with `capture_issue` and no packet. `result.ok` is the
runner outcome; it alone does not mean that capture or persistence succeeded.
Pre-call failures have zero attempts and return the original runner manifest
with no packet. The existing 1–8 attempt and byte limits still apply, including
the additional capture context in the request limit.

`executeAndPersistProviderEvidenceRun(directory, input, dependencies)` executes
the same bridge and publishes its generated packet through the existing POSIX
exclusive writer. It accepts no caller-supplied outcome or packet. Failed capture
and zero-attempt runs publish nothing. Those cases retain the runner result in
memory only; this bridge does not durably retain their complete raw responses or
all failure evidence. A real integration needs approved storage/retention for
that gap. Persistence does not change retention authority: callers must retain
the returned manifest for those cases. Windows
persistence is refused before invoking the callback; portable execution and
serialization tests still run. Existing directory permissions, append-only
publication and storage-owner trust limitations apply unchanged.

Before P4-106 can close, named reviewers must approve the provider and retention
policy, model/configuration and dataset freezes, storage/access/deletion controls,
and a deployed adapter integration that captures every attempt at the transport
boundary under those approvals. The fixture bridge prepares that integration;
synthetic tests and supplied caller metadata cannot replace those
requirements. The privacy/security checklist remains NOT APPROVED.

Run `pnpm provider:evidence:verify` for the regression checks. They are also part
of `pnpm phase4:assets`, `pnpm phase4:verify` and the normal `pnpm verify` gate.
