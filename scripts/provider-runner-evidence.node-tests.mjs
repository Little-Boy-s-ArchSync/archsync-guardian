import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProviderFailure } from "../dist/reasoner/provider.js";
import { executeAndPersistProviderEvidenceRun, executeProviderEvidenceRun } from "./provider-runner-evidence.mjs";
import { verifyProviderEvidencePacket } from "./provider-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = { skip: process.platform === "win32" ? "Private recorder requires POSIX ownership; execution checks remain portable." : false };
const response = (overrides = {}) => Buffer.from(` ${JSON.stringify({ choices: [{ message: { content: "fixture — α" } }], usage: { prompt_tokens: 7, completion_tokens: 3, cost_usd: 0.002 }, ...overrides })}\r\n`);
const fixture = () => ({
  run_id: "fixture-run-001", provider: "fixture-provider", model: "fixture-model", model_version: "fixture-v1", prompt_version: "fixture-prompt-v1", prompt: "fixture input",
  policy: { max_attempts: 3, timeout_ms: 100, max_input_tokens: 100, max_output_tokens: 20, max_cost_usd: 0.01, backoff_ms: 1 },
  options: { temperature: 0, seed: 3 },
});
const dependencies = (transport, overrides = {}) => {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  return { transport, now: () => new Date(tick++).toISOString(), wait: async () => {}, ...overrides };
};
const packet = (result) => JSON.parse(result.evidence.bytes);

test("runner derives success and binds exact received bytes, request, configuration and IDs", async () => {
  const bytes = response();
  const requests = [];
  const output = await executeProviderEvidenceRun(fixture(), dependencies(async (request) => {
    requests.push(request);
    return { status: 200, bytes };
  }));
  assert.equal(output.result.ok, true);
  assert.equal(output.result.response.content, "fixture — α");
  const value = packet(output);
  assert.equal(value.origin, "synthetic");
  assert.equal(value.acceptance, "UNREVIEWED_PROVIDER_EVIDENCE");
  assert.deepEqual(Buffer.from(value.attempts[0].response.base64, "base64"), bytes);
  assert.equal(value.attempts[0].response.sha256, hash(bytes));
  const context = JSON.parse(Buffer.from(value.request.base64, "base64"));
  assert.equal(context.configuration.run_id, requests[0].run_id);
  assert.equal(context.configuration.model_version, "fixture-v1");
  assert.equal(context.http_request.body, requests[0].body);
  assert.equal(context.request_sha256, hash(requests[0].body));
  assert.equal(requests[0].configuration_sha256, output.binding.configuration_sha256);
  assert.deepEqual(requests[0].headers, { "content-type": "application/json" });
  assert.equal(Object.hasOwn(requests[0].headers, "authorization"), false);
  assert.deepEqual(output.binding.transport_attempts, [{ attempt: 1, http_status: 200 }]);
  assert.equal(verifyProviderEvidencePacket(output.evidence.bytes, output.evidence.sha256).outcome, "success");
});

test("records HTTP failure, thrown transport failure and a successful retry in order", async () => {
  const requests = [];
  const waits = [];
  const errorBytes = Buffer.from("fixture rate limit\r\n");
  const output = await executeProviderEvidenceRun(fixture(), dependencies(async (request) => {
    requests.push(request);
    if (request.attempt === 1) return { status: 429, bytes: errorBytes };
    if (request.attempt === 2) throw new Error("fixture transport disconnected");
    return { status: 201, bytes: response() };
  }, { wait: async (delay) => { waits.push(delay); } }));
  assert.deepEqual(waits, [1, 2]);
  assert.deepEqual(requests.map(({ attempt }) => attempt), [1, 2, 3]);
  assert.equal(new Set(requests.map(({ body }) => body)).size, 1);
  assert.equal(new Set(requests.map(({ configuration_sha256 }) => configuration_sha256)).size, 1);
  const value = packet(output);
  assert.deepEqual(value.attempts.map(({ outcome }) => outcome), ["failed", "failed", "success"]);
  assert.deepEqual(value.attempts.map(({ failure }) => failure?.kind ?? null), ["rate-limit", "provider", null]);
  assert.deepEqual(Buffer.from(value.attempts[0].response.base64, "base64"), errorBytes);
  assert.equal(value.attempts[1].response, null);
  assert.equal(value.attempts[0].usage, null);
  assert.equal(output.result.manifest.failures.length, 2);
});

test("retains over-budget response bytes and measured usage but cannot label them success", async () => {
  const bytes = response({ usage: { prompt_tokens: 7, completion_tokens: 99, cost_usd: 0.1 } });
  const output = await executeProviderEvidenceRun(fixture(), dependencies(async () => ({ status: 200, bytes })));
  assert.equal(output.result.ok, false);
  const value = packet(output);
  assert.equal(value.outcome, "failed");
  assert.equal(value.attempts.length, 1);
  assert.equal(value.attempts[0].failure.kind, "budget");
  assert.deepEqual(value.attempts[0].usage, { input_tokens: 7, output_tokens: 99, cost_usd: 0.1 });
  assert.deepEqual(Buffer.from(value.attempts[0].response.base64, "base64"), bytes);
});

test("HTTP success cannot fabricate valid JSON, content, usage or missing cost", async () => {
  for (const bytes of [Buffer.from("not JSON"), Buffer.from("null"), response({ choices: [] }), response({ usage: { prompt_tokens: 7, completion_tokens: 3 } }), response({ usage: { prompt_tokens: -1, completion_tokens: 3, cost_usd: 0 } })]) {
    const output = await executeProviderEvidenceRun(fixture(), dependencies(async () => ({ status: 200, bytes })));
    assert.equal(output.result.ok, false);
    assert.equal(packet(output).attempts.length, 1);
    assert.equal(packet(output).attempts[0].failure.kind, "invalid-response");
    assert.deepEqual(Buffer.from(packet(output).attempts[0].response.base64, "base64"), bytes);
  }
});

test("caller outcome flags and pre-parsed response substitutes are refused", async () => {
  for (const flag of ["outcome", "status", "attempts", "origin", "credential", "endpoint"]) {
    await assert.rejects(executeProviderEvidenceRun({ ...fixture(), [flag]: "success" }, dependencies(async () => assert.fail("must not call transport"))), /unexpected fields/u);
  }
  for (const forged of [{ status: 200, bytes: response(), outcome: "success" }, { status: 200, body: JSON.parse(response()) }, { status: 200, bytes: "parsed text" }, { status: 999, bytes: response() }]) {
    const output = await executeProviderEvidenceRun(fixture(), dependencies(async () => forged));
    assert.equal(output.result.ok, false);
    if (output.evidence) assert.equal(packet(output).outcome, "failed");
  }
});

test("unsafe, duplicate-key, non-UTF-8 and oversized received bytes fail closed without an artifact", async () => {
  for (const bytes of [Buffer.from('{"api_key":"fixture-private-value"}'), Buffer.from('{"x":1,"x":2}'), Buffer.from([0xff]), Buffer.alloc(1_048_577, 65)]) {
    const output = await executeProviderEvidenceRun(fixture(), dependencies(async () => ({ status: 200, bytes })));
    assert.equal(output.result.ok, false);
    assert.equal(output.evidence, null);
    assert.match(output.capture_issue, /cannot be retained/u);
    assert.equal(JSON.stringify(output).includes("fixture-private-value"), false);
  }
});

test("request privacy checks, attempt caps and data-only configuration apply before transport", async () => {
  for (const change of [{ prompt: "member@example.invalid" }, { run_id: "../unsafe" }, { policy: { ...fixture().policy, max_attempts: 9 } }, { options: { temperature: Infinity } }, { model: "x".repeat(257) }]) {
    await assert.rejects(executeProviderEvidenceRun({ ...fixture(), ...change }, dependencies(async () => assert.fail("preflight must prevent transport"))));
  }
  for (const field of ["provider", "model", "model_version", "prompt_version"]) {
    for (const value of ["fixture\nprovider", "fixture\u007fprovider", "member@example.invalid"]) {
      await assert.rejects(executeProviderEvidenceRun({ ...fixture(), [field]: value }, dependencies(async () => assert.fail("invalid metadata must prevent transport"))));
    }
  }
  const input = fixture();
  Object.defineProperty(input.options, "seed", { get: () => 1, enumerable: true });
  await assert.rejects(executeProviderEvidenceRun(input, dependencies(async () => assert.fail("accessor must not execute"))), /data properties/u);
});

test("configuration and response snapshots survive later caller mutation", async () => {
  const input = fixture();
  const bytes = response();
  const original = Buffer.from(bytes);
  const output = await executeProviderEvidenceRun(input, dependencies(async () => {
    input.model = "tampered-model";
    input.options.temperature = 99;
    input.policy.max_cost_usd = 0;
    setImmediate(() => bytes.fill(65));
    return { status: 200, bytes };
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.result.ok, true);
  assert.equal(packet(output).model, "fixture-model");
  assert.deepEqual(Buffer.from(packet(output).attempts[0].response.base64, "base64"), original);
});

test("timeout aborts the attempt, preserves its retry and ignores a late response", async () => {
  const input = fixture();
  input.policy.timeout_ms = 10;
  let lateResolve;
  const signals = [];
  const output = await executeProviderEvidenceRun(input, dependencies((request) => {
    signals.push(request.signal);
    if (request.attempt === 1) return new Promise((resolve) => { lateResolve = resolve; });
    return Promise.resolve({ status: 200, bytes: response() });
  }));
  assert.equal(output.result.ok, true);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(packet(output).attempts.map(({ failure }) => failure?.kind ?? null), ["timeout", null]);
  assert.equal(packet(output).attempts[0].response, null);
  const retained = Buffer.from(output.evidence.bytes);
  lateResolve({ status: 200, bytes: response({ choices: [{ message: { content: "late fixture" } }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output.evidence.bytes, retained);
});

test("cancellation during transport and retry backoff preserves failures without extra transport", async () => {
  for (const when of ["transport", "backoff"]) {
    const controller = new AbortController();
    let calls = 0;
    const output = await executeProviderEvidenceRun(fixture(), dependencies(async () => {
      calls += 1;
      if (when === "transport") {
        controller.abort();
        return new Promise(() => {});
      }
      return { status: 429, bytes: Buffer.from("fixture rate limit") };
    }, { signal: controller.signal, wait: async () => { controller.abort(); } }));
    assert.equal(output.result.ok, false);
    assert.equal(calls, 1);
    assert.equal(output.result.manifest.failures.at(-1).kind, "cancelled");
    assert.equal(packet(output).attempts.length, 1);
    assert.equal(packet(output).outcome, "failed");
    const context = JSON.parse(Buffer.from(packet(output).request.base64, "base64"));
    assert.deepEqual(context.observed_execution.manifest, output.result.manifest);
    assert.equal(context.observed_execution.manifest.failures.at(-1).kind, "cancelled");
    assert.equal(packet(output).request.sha256, output.binding.context_sha256);
  }
});

test("zero-attempt preflight failures retain the runner manifest without inventing an attempt", async () => {
  const controller = new AbortController();
  controller.abort();
  for (const [input, signal] of [[fixture(), controller.signal], [{ ...fixture(), policy: { ...fixture().policy, max_input_tokens: 1 } }, undefined]]) {
    const output = await executeProviderEvidenceRun(input, dependencies(async () => assert.fail("pre-call rejection must not execute transport"), { signal }));
    assert.equal(output.result.ok, false);
    assert.equal(output.result.manifest.attempts, 0);
    assert.equal(output.evidence, null);
    assert.deepEqual(output.binding.transport_attempts, []);
  }
});

test("transport diagnostics are redacted in failed evidence", async () => {
  const output = await executeProviderEvidenceRun(fixture(), dependencies(async () => { throw new ProviderFailure("quota", "Bearer fixture-sensitive-value"); }));
  assert.equal(output.result.ok, false);
  assert.equal(output.evidence.bytes.toString().includes("fixture-sensitive-value"), false);
  assert.match(packet(output).attempts[0].failure.message, /REDACTED/u);
  const longDiagnostic = await executeProviderEvidenceRun(fixture(), dependencies(async () => { throw new ProviderFailure("quota", "x".repeat(2_049)); }));
  assert.equal(longDiagnostic.result.ok, false);
  assert.equal(longDiagnostic.result.manifest.failures[0].message.length, 2_049);
  assert.equal(longDiagnostic.evidence, null);
  assert.match(longDiagnostic.capture_issue, /metadata or size limits/u);
});

test("persistence uses the existing immutable POSIX packet boundary and cannot overwrite", posix, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "archsync-runner-capture-")));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await executeAndPersistProviderEvidenceRun(directory, fixture(), dependencies(async () => ({ status: 200, bytes: response() })));
  const bytes = await readFile(output.persisted.path);
  assert.deepEqual(bytes, output.evidence.bytes);
  assert.equal(verifyProviderEvidencePacket(bytes, output.persisted.sha256).outcome, "success");
  await assert.rejects(executeAndPersistProviderEvidenceRun(directory, fixture(), dependencies(async () => ({ status: 200, bytes: response() }))), /EEXIST/u);
  assert.deepEqual(await readdir(directory), ["fixture-run-001.provider-evidence.json"]);
});

test("rejected capture never publishes a partial or successful packet", posix, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "archsync-runner-rejected-")));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await executeAndPersistProviderEvidenceRun(directory, fixture(), dependencies(async () => ({ status: 200, bytes: Buffer.from('{"password":"fixture-value"}') })));
  assert.equal(output.persisted, null);
  assert.deepEqual(await readdir(directory), []);
});
