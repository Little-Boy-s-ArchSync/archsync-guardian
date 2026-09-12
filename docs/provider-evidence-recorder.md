# Preparatory provider evidence recorder

Status: **UNREVIEWED — no provider execution or storage approval**.

P4-106 currently has an in-memory run manifest and an artifact-path metadata
field, but no response persistence in its provider runner. The separate
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

The primitive requires 1–8 attempts numbered consecutively from 1; it refuses a
retry after success, an outcome inconsistent with the final attempt, reversed or
overlapping timestamps, unknown fields, non-finite usage, or unsafe run IDs.
Requests are limited to 256 KiB, each response to 1 MiB, total responses to 4 MiB,
and the serialized packet to 6.5 MB. These are implementation bounds, not approved
experiment budgets. Pre-call failures with zero attempts are outside this
received-attempt artifact format and remain in the existing runner manifest.

Only valid UTF-8 content is accepted. Known credential, email and absolute-path
patterns are checked with the existing diagnostic redactor. JSON content is also
checked recursively after decoding escapes, including credential-key rejection
unless the value is exactly `[REDACTED]`. Input is rejected rather than silently
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

Before P4-106 can close, named reviewers must approve the provider and retention
policy, model/configuration and dataset freezes, storage/access/deletion controls,
and a real adapter integration that captures every attempt at the transport
boundary. Synthetic tests and supplied caller metadata cannot replace those
requirements. The privacy/security checklist remains NOT APPROVED.

Run `pnpm provider:evidence:verify` for the regression checks. They are also part
of `pnpm phase4:assets`, `pnpm phase4:verify` and the normal `pnpm verify` gate.
