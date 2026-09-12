import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProviderEvidencePacket, persistProviderEvidence, providerEvidenceLimits, verifyProviderEvidencePacket } from "./provider-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const posix = { skip: process.platform === "win32" ? "Private recorder intentionally requires POSIX storage; serialization is portable." : false };

function fixture() {
  return {
    run_id: "synthetic-record-001",
    origin: "synthetic",
    provider: "synthetic-provider",
    model: "synthetic-model",
    model_version: "fixture-v1",
    prompt_version: "fixture-prompt-v1",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:02.000Z",
    outcome: "success",
    request: Buffer.from('{"prompt":"synthetic request"}\r\n'),
    attempts: [{
      attempt: 1,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      outcome: "success",
      response: Buffer.from(' {"content":"synthetic response — α"}\r\n'),
      failure: null,
      usage: { input_tokens: 10, output_tokens: 12, cost_usd: 0.125 },
    }],
  };
}

async function privateDirectory(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archsync-provider-evidence-")));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("round-trips exact supplied bytes, metadata and timestamps without asserting approval", () => {
  const input = fixture();
  const packet = createProviderEvidencePacket(input);
  const value = JSON.parse(packet.bytes);
  assert.deepEqual(Buffer.from(value.request.base64, "base64"), input.request);
  assert.deepEqual(Buffer.from(value.attempts[0].response.base64, "base64"), input.attempts[0].response);
  assert.equal(value.request.sha256, hash(input.request));
  assert.equal(value.attempts[0].response.sha256, hash(input.attempts[0].response));
  for (const name of ["run_id", "origin", "provider", "model", "model_version", "prompt_version", "started_at", "finished_at", "outcome"]) assert.equal(value[name], input[name]);
  assert.equal(value.acceptance, "UNREVIEWED_PROVIDER_EVIDENCE");
  assert.deepEqual(verifyProviderEvidencePacket(packet.bytes, packet.sha256), {
    run_id: input.run_id, origin: "synthetic", outcome: "success", attempts: 1, sha256: packet.sha256, acceptance: "UNREVIEWED_PROVIDER_EVIDENCE",
  });
  assert.deepEqual(createProviderEvidencePacket(input), packet);
});

test("preserves failed responses, unavailable measurements and every retry", () => {
  const input = fixture();
  input.outcome = "failed";
  input.attempts = [
    { ...input.attempts[0], outcome: "failed", response: null, failure: { kind: "timeout", message: "Attempt timed out" }, usage: null },
    { ...input.attempts[0], attempt: 2, started_at: "2026-01-01T00:00:01.000Z", finished_at: input.finished_at, outcome: "failed", response: Buffer.from("Received but over budget"), failure: { kind: "budget", message: "Output exceeded the configured limit" }, usage: { input_tokens: 10, output_tokens: 900, cost_usd: 1 } },
  ];
  const packet = createProviderEvidencePacket(input);
  const value = JSON.parse(packet.bytes);
  assert.equal(value.outcome, "failed");
  assert.equal(value.attempts[0].response, null);
  assert.equal(value.attempts[0].usage, null);
  assert.equal(value.attempts[1].usage.output_tokens, 900);
  assert.equal(value.attempts[1].failure.kind, "budget");
  assert.equal(Buffer.from(value.attempts[1].response.base64, "base64").toString(), "Received but over budget");
  assert.equal(verifyProviderEvidencePacket(packet.bytes, packet.sha256).outcome, "failed");
});

test("allows explicit unverified origin and a failed attempt followed by supplied success", () => {
  const input = fixture();
  input.origin = "caller-supplied-unverified";
  input.attempts.unshift({ ...input.attempts[0], outcome: "failed", response: Buffer.from("Rate limited"), failure: { kind: "rate-limit", message: "Rate limited" }, usage: null });
  input.attempts[1] = { ...input.attempts[1], attempt: 2, started_at: "2026-01-01T00:00:01.000Z", finished_at: input.finished_at };
  const packet = createProviderEvidencePacket(input);
  assert.equal(verifyProviderEvidencePacket(packet.bytes, packet.sha256).origin, "caller-supplied-unverified");
  assert.equal(JSON.parse(packet.bytes).attempts[0].outcome, "failed");
});

test("rejects secret and PII patterns including escaped JSON credential keys and nested strings", () => {
  const unsafe = [
    "Bearer synthetic-token-value", "api_key=synthetic-value", "member@example.invalid", "/home/member/private.txt", "C:\\Users\\Member\\private.txt",
    '{"api_key":"synthetic-value"}', '{"api\\u005fkey":"synthetic-value"}', '{"nested":[{"message":"member@example.invalid"}]}',
    '{"authorization":"opaque-value"}', '{"cookie":"session-value"}', '{"/home/member/path":"text"}',
  ];
  for (const text of unsafe) {
    const input = fixture();
    input.attempts[0].response = Buffer.from(text);
    assert.throws(() => createProviderEvidencePacket(input), /redaction|credential field/u);
    input.attempts[0].response = fixture().attempts[0].response;
    input.request = Buffer.from(text);
    assert.throws(() => createProviderEvidencePacket(input), /redaction|credential field/u);
  }
  for (const field of ["provider", "model", "model_version", "prompt_version"]) {
    const input = fixture();
    input[field] = "secret=synthetic-value";
    assert.throws(() => createProviderEvidencePacket(input), /redaction/u);
  }
  const input = fixture();
  input.outcome = input.attempts[0].outcome = "failed";
  input.attempts[0].failure = { kind: "provider", message: "Bearer synthetic-value" };
  assert.throws(() => createProviderEvidencePacket(input), /redaction/u);
});

test("accepts explicitly redacted JSON without modifying its bytes", () => {
  const input = fixture();
  input.attempts[0].response = Buffer.from('{"api_key":"[REDACTED]","data":null}');
  const packet = createProviderEvidencePacket(input);
  assert.deepEqual(Buffer.from(JSON.parse(packet.bytes).attempts[0].response.base64, "base64"), input.attempts[0].response);
});

test("rejects original duplicate JSON members and escaped aliases during creation and verification", () => {
  const hidden = [
    '{"api_key":"synthetic-value","api_key":"[REDACTED]"}',
    '{"api\\u005fkey":"synthetic-value","api_key":"[REDACTED]"}',
    '{"note":"member@example.invalid","note":"clear"}',
    '{"nested":[{"note":"member@example.invalid","no\\u0074e":"clear"}]}',
    '{"safe":"one","safe":"two"}',
  ];
  for (const text of hidden) {
    for (const target of ["request", "response"]) {
      const input = fixture();
      const content = Buffer.from(text);
      if (target === "request") input.request = content;
      else input.attempts[0].response = content;
      assert.throws(() => createProviderEvidencePacket(input), /duplicate decoded JSON keys/u);

      const value = JSON.parse(createProviderEvidencePacket(fixture()).bytes);
      const replacement = { bytes: content.length, sha256: hash(content), base64: content.toString("base64") };
      if (target === "request") value.request = replacement;
      else value.attempts[0].response = replacement;
      const forged = encoded(value);
      assert.throws(() => verifyProviderEvidencePacket(forged, hash(forged)), /duplicate decoded JSON keys/u);
    }
  }
});

test("duplicate-key scanner handles escaped strings and independent nested object scopes", () => {
  const input = fixture();
  input.request = Buffer.from(JSON.stringify({ text: 'Quotes " commas , braces {} and backslash \\', items: [{ value: "first" }, { value: "second" }], value: { value: "third" } }));
  const packet = createProviderEvidencePacket(input);
  assert.equal(verifyProviderEvidencePacket(packet.bytes, packet.sha256).outcome, "success");
  assert.deepEqual(Buffer.from(JSON.parse(packet.bytes).request.base64, "base64"), input.request);
});

test("token-shaped run identifiers fail creation and verification", () => {
  const input = fixture();
  input.run_id = "ghp_authorednotarealsecret";
  assert.throws(() => createProviderEvidencePacket(input), /run_id requires redaction/u);
  const value = JSON.parse(createProviderEvidencePacket(fixture()).bytes);
  value.run_id = input.run_id;
  const forged = encoded(value);
  assert.throws(() => verifyProviderEvidencePacket(forged, hash(forged)), /run_id requires redaction/u);
});

test("sparse attempts cannot create a packet that its own verifier would reject", () => {
  const input = fixture();
  const second = { ...input.attempts[0], attempt: 2 };
  input.attempts = [];
  input.attempts[1] = second;
  assert.throws(() => createProviderEvidencePacket(input), /missing array entry/u);
  const inherited = [];
  inherited.length = 1;
  Object.setPrototypeOf(inherited, { 0: fixture().attempts[0] });
  input.attempts = inherited;
  assert.throws(() => createProviderEvidencePacket(input), /missing array entry/u);
  const dense = createProviderEvidencePacket(fixture());
  assert.equal(verifyProviderEvidencePacket(dense.bytes, dense.sha256).attempts, 1);
});

test("rejects invalid shape, identifiers, controls, UTF-8 and excessive content", () => {
  const mutations = [
    (x) => { x.run_id = "../escape"; },
    (x) => { x.run_id = "CON"; },
    (x) => { x.origin = "approved"; },
    (x) => { x.provider = ""; },
    (x) => { x.provider = "x\nprivate"; },
    (x) => { x.model_version = "x".repeat(257); },
    (x) => { x.provider_headers = {}; },
    (x) => { delete x.model_version; },
    (x) => { x.request = Buffer.from([0xff]); },
    (x) => { x.request = Buffer.from([0]); },
    (x) => { x.request = "not bytes"; },
    (x) => { x.request = Buffer.alloc(providerEvidenceLimits.requestBytes + 1, 120); },
    (x) => { x.attempts[0].response = Buffer.alloc(providerEvidenceLimits.responseBytes + 1, 120); },
    (x) => { x.attempts[0].response = Buffer.from(`${"[".repeat(34)}0${"]".repeat(34)}`); },
    (x) => { x.attempts[0].response = Buffer.from(`prefix_${"x".repeat(4096)}`); },
    (x) => { x.attempts[0].extra = "unbounded"; },
    (x) => { x.attempts[0].usage = { input_tokens: -1, output_tokens: 1, cost_usd: 0 }; },
    (x) => { x.attempts[0].usage.output_tokens = NaN; },
    (x) => { x.attempts[0].usage.cost_usd = Infinity; },
    (x) => { x.attempts[0].usage.extra = 1; },
    (x) => { x.attempts[0].response = null; },
    (x) => { x.attempts[0].usage = null; },
    (x) => { x.attempts[0].failure = { kind: "provider", message: "Failure" }; },
    (x) => { x.outcome = x.attempts[0].outcome = "failed"; },
    (x) => { x.outcome = x.attempts[0].outcome = "failed"; x.attempts[0].failure = { kind: "unknown", message: "Failure" }; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => createProviderEvidencePacket(input), /Invalid provider evidence/u);
  }
  assert.throws(() => createProviderEvidencePacket(Object.create(null)), /plain object/u);
  assert.throws(() => createProviderEvidencePacket(null), /object/u);
});

test("rejects incomplete retries, fabricated outcomes and inconsistent timestamps", () => {
  const mutations = [
    (x) => { x.attempts = []; },
    (x) => { x.attempts = Array(9).fill(x.attempts[0]); },
    (x) => { x.attempts[0].attempt = 2; },
    (x) => { x.attempts.push({ ...x.attempts[0], attempt: 2 }); },
    (x) => { x.started_at = "2026-02-30T00:00:00.000Z"; },
    (x) => { x.started_at = "2026-01-01"; },
    (x) => { x.finished_at = "2025-01-01T00:00:00.000Z"; },
    (x) => { x.attempts[0].started_at = "2025-01-01T00:00:00.000Z"; },
    (x) => { x.attempts[0].finished_at = "2027-01-01T00:00:00.000Z"; },
    (x) => { x.attempts[0].outcome = "verified"; },
    (x) => { x.outcome = "verified"; },
    (x) => { x.outcome = "failed"; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => createProviderEvidencePacket(input), /Invalid provider evidence/u);
  }
});

test("enforces aggregate response limits across failed attempts", () => {
  const input = fixture();
  input.outcome = "failed";
  input.attempts = Array.from({ length: 5 }, (_, index) => ({ ...input.attempts[0], attempt: index + 1, started_at: input.started_at, finished_at: input.started_at, outcome: "failed", response: Buffer.alloc(providerEvidenceLimits.responseBytes, 120), failure: { kind: "provider", message: "Synthetic failure" } }));
  assert.throws(() => createProviderEvidencePacket(input), /total response bytes/u);
});

test("requires the externally retained digest and rejects internally rewritten metadata", () => {
  const packet = createProviderEvidencePacket(fixture());
  const value = JSON.parse(packet.bytes);
  value.model_version = "different-version";
  const changed = encoded(value);
  assert.throws(() => verifyProviderEvidencePacket(changed, packet.sha256), /packet digest/u);
  assert.throws(() => verifyProviderEvidencePacket(packet.bytes, undefined), /packet digest/u);
  const whitespace = Buffer.concat([packet.bytes, Buffer.from(" ")]);
  assert.throws(() => verifyProviderEvidencePacket(whitespace, hash(whitespace)), /not canonical/u);
  const nonJson = Buffer.from("not JSON");
  assert.throws(() => verifyProviderEvidencePacket(nonJson, hash(nonJson)), /not JSON/u);
});

test("rejects tampered byte digests, encodings and schema even with a recalculated outer digest", () => {
  const mutations = [
    (x) => { x.request.sha256 = "0".repeat(64); },
    (x) => { x.attempts[0].response.bytes += 1; },
    (x) => { x.attempts[0].response.base64 += "\n"; },
    (x) => { x.attempts[0].response.bytes = -1; },
    (x) => { x.attempts[0].response.base64 = 12; },
    (x) => { x.attempts[0].response.extra = "hidden"; },
    (x) => { x.attempts[0].extra = 1; },
    (x) => { x.attempts = null; },
    (x) => { x.acceptance = "APPROVED"; },
    (x) => { x.schema_version = "1.0.0"; },
    (x) => { x.extra = true; },
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(createProviderEvidencePacket(fixture()).bytes);
    mutate(value);
    const changed = encoded(value);
    assert.throws(() => verifyProviderEvidencePacket(changed, hash(changed)), /Invalid provider evidence/u);
  }
});

test("publishes a read-only owner-only artifact and snapshots mutable input before awaiting", posix, async (t) => {
  const root = await privateDirectory(t);
  const input = fixture();
  const expected = createProviderEvidencePacket(input);
  const pending = persistProviderEvidence(root, input);
  input.run_id = "changed-id";
  input.model_version = "changed-version";
  input.request.fill(120);
  input.attempts[0].response.fill(120);
  const result = await pending;
  assert.equal(result.path, join(root, "synthetic-record-001.provider-evidence.json"));
  assert.deepEqual(await readFile(result.path), expected.bytes);
  const stat = await lstat(result.path);
  assert.equal(stat.mode & 0o777, 0o400);
  assert.equal(stat.nlink, 1);
  assert.equal(stat.uid, process.getuid());
  assert.equal(result.sha256, expected.sha256);
  assert.deepEqual(await readdir(root), ["synthetic-record-001.provider-evidence.json"]);
});

test("never overwrites an existing run and cleans unpublished temporary files", posix, async (t) => {
  const root = await privateDirectory(t);
  const first = await persistProviderEvidence(root, fixture());
  const original = await readFile(first.path);
  const second = fixture();
  second.model_version = "different-version";
  await assert.rejects(persistProviderEvidence(root, second), { code: "EEXIST" });
  assert.deepEqual(await readFile(first.path), original);
  assert.deepEqual(await readdir(root), ["synthetic-record-001.provider-evidence.json"]);
});

test("concurrent writers publish exactly one complete artifact", posix, async (t) => {
  const root = await privateDirectory(t);
  const first = fixture();
  const second = fixture();
  second.model_version = "second-version";
  const results = await Promise.allSettled([persistProviderEvidence(root, first), persistProviderEvidence(root, second)]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected")[0].reason.code, "EEXIST");
  const winner = results.find(({ status }) => status === "fulfilled").value;
  const bytes = await readFile(winner.path);
  assert.equal(verifyProviderEvidencePacket(bytes, winner.sha256).run_id, first.run_id);
  assert.deepEqual(await readdir(root), ["synthetic-record-001.provider-evidence.json"]);
});

test("refuses unsafe directories and existing destination symlinks without touching their targets", posix, async (t) => {
  const root = await privateDirectory(t);
  const unsafe = join(root, "shared");
  await mkdir(unsafe, { mode: 0o755 });
  await chmod(unsafe, 0o755);
  await assert.rejects(persistProviderEvidence(unsafe, fixture()), /owner-only directory/u);
  const alias = join(root, "alias");
  await symlink(unsafe, alias);
  await assert.rejects(persistProviderEvidence(alias, fixture()), /symlink aliases/u);
  const target = join(root, "unchanged.txt");
  await writeFile(target, "Do not replace");
  const destination = join(root, "synthetic-record-001.provider-evidence.json");
  await symlink(target, destination);
  await assert.rejects(persistProviderEvidence(root, fixture()), { code: "EEXIST" });
  assert.equal(await readFile(target, "utf8"), "Do not replace");
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("invalid or unsafe inputs create no files", posix, async (t) => {
  const root = await privateDirectory(t);
  const input = fixture();
  input.request = Buffer.from('{"password":"synthetic-value"}');
  await assert.rejects(persistProviderEvidence(root, input), /credential field/u);
  const token = fixture();
  token.run_id = "ghp_authorednotarealsecret";
  await assert.rejects(persistProviderEvidence(root, token), /run_id requires redaction/u);
  const sparse = fixture();
  sparse.attempts[1] = { ...sparse.attempts[0], attempt: 2 };
  delete sparse.attempts[0];
  await assert.rejects(persistProviderEvidence(root, sparse), /missing array entry/u);
  assert.deepEqual(await readdir(root), []);
});
