import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ProviderFailure } from "../dist/reasoner/provider.js";
import { createProviderEvidencePacket, verifyProviderEvidencePacket } from "./provider-evidence.mjs";
import { executeProviderEvidenceRun } from "./provider-runner-evidence.mjs";
import { verifyProviderRunEvidence } from "./provider-run-evidence-intake.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fixture = () => ({
  run_id: "intake-fixture-001", provider: "fixture-provider", model: "fixture-model",
  model_version: "fixture-v1", prompt_version: "fixture-prompt-v1", prompt: "fixture input",
  policy: { max_attempts: 3, timeout_ms: 100, max_input_tokens: 100, max_output_tokens: 20, max_cost_usd: 0.01, backoff_ms: 1 },
  options: { temperature: 0, seed: 3 },
});
const response = (usage = { prompt_tokens: 7, completion_tokens: 3, cost_usd: 0.002 }, content = "fixture — α") =>
  Buffer.from(" " + JSON.stringify({ choices: [{ message: { content } }], usage }) + "\r\n");
async function capture(transport = async () => ({ status: 200, bytes: response() }), input = fixture(), wait = async () => {}) {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  return executeProviderEvidenceRun(input, { transport, now: () => new Date(tick++).toISOString(), wait });
}
const bindings = (output) => ({
  packet_sha256: output.evidence.sha256,
  configuration_sha256: output.binding.configuration_sha256,
  request_sha256: output.binding.request_sha256,
  context_sha256: output.binding.context_sha256,
  manifest_sha256: output.binding.manifest_sha256,
});
const intake = (output) => verifyProviderRunEvidence(output.evidence.bytes, bindings(output));

// Rebuild a structurally valid generic packet to expose semantic contradictions
// that packet-integrity verification alone cannot detect. New digests here are
// deliberately attacker-controlled and supply no transport authenticity.
function reseal(output, change) {
  const packet = JSON.parse(output.evidence.bytes);
  const context = JSON.parse(Buffer.from(packet.request.base64, "base64"));
  change(packet, context);
  const { schema_version, acceptance, ...input } = packet;
  input.request = encode(context);
  input.attempts = input.attempts.map((attempt) => ({
    ...attempt, response: attempt.response === null ? null : Buffer.from(attempt.response.base64, "base64"),
  }));
  const evidence = createProviderEvidencePacket(input);
  assert.equal(verifyProviderEvidencePacket(evidence.bytes, evidence.sha256).sha256, evidence.sha256);
  return {
    evidence,
    binding: {
      configuration_sha256: hash(encode(context.configuration)),
      request_sha256: hash(context.http_request.body),
      context_sha256: hash(input.request),
      manifest_sha256: hash(encode(context.observed_execution.manifest)),
    },
  };
}

test("intake binds exact raw response/request/configuration/journal without production authority", async () => {
  let actual;
  const bytes = response();
  const output = await capture(async (request) => { actual = request; return { status: 200, bytes }; });
  const receipt = await intake(output);
  assert.equal(receipt.outcome, "success");
  assert.equal(receipt.bindings.request_sha256, hash(actual.body));
  assert.equal(receipt.bindings.configuration_sha256, actual.configuration_sha256);
  assert.equal(receipt.bindings.manifest_sha256, hash(encode(output.result.manifest)));
  assert.equal(receipt.replayed_result_sha256, hash(encode(output.result)));
  assert.deepEqual(receipt.measured_usage, { input_tokens: 7, output_tokens: 3, cost_usd: 0.002 });
  assert.deepEqual(receipt.attempts_with_unknown_usage, []);
  assert.equal(receipt.attempts[0].response_sha256, hash(bytes));
  assert.equal(receipt.acceptance, "UNREVIEWED_PROVIDER_EVIDENCE");
  assert.equal(receipt.approval_status, "UNAPPROVED");
  assert.equal(receipt.production_ready, false);
  assert.equal(receipt.production_capability, "NOT_ISSUED");
  assert.equal(receipt.transport_authenticity, "NOT_ESTABLISHED");
  assert.equal(receipt.timing_verification, "RECORDED_ORDER_ONLY");
});

test("all retry usage is retained, including HTTP errors and unknown transport usage", async () => {
  const output = await capture(async ({ attempt }) => {
    if (attempt === 1) return { status: 429, bytes: response({ prompt_tokens: 2, completion_tokens: 1, cost_usd: 0.001 }) };
    if (attempt === 2) throw new Error("fixture disconnected");
    return { status: 200, bytes: response() };
  });
  const receipt = await intake(output);
  assert.deepEqual(receipt.measured_usage, { input_tokens: 9, output_tokens: 4, cost_usd: 0.003 });
  assert.deepEqual(receipt.attempts_with_unknown_usage, [2]);
  assert.deepEqual(receipt.attempts.map((item) => item.outcome), ["failed", "failed", "success"]);
  assert.equal(receipt.attempts[1].response_sha256, null);
  assert.equal(receipt.replayed_result_sha256, hash(encode(output.result)));
  assert.deepEqual(output.result.manifest.tokens, { input: 7, output: 3 }, "last-attempt runner totals must not erase measured retry usage at intake");
});

test("official replay preserves budget, malformed response, HTTP and transport failures", async () => {
  const cases = [
    async () => ({ status: 200, bytes: response({ prompt_tokens: 7, completion_tokens: 99, cost_usd: 0.1 }) }),
    async () => ({ status: 200, bytes: Buffer.from("not JSON") }),
    async () => ({ status: 200, bytes: Buffer.from("null") }),
    async () => ({ status: 200, bytes: response({ prompt_tokens: 7, completion_tokens: 3 }) }),
    async () => ({ status: 200, bytes: response(undefined, 42) }),
    async () => ({ status: 429, bytes: Buffer.from("fixture rate limited") }),
    async () => ({ status: 503, bytes: response() }),
    async () => { throw new ProviderFailure("quota", "fixture exhausted"); },
    async () => { throw new ProviderFailure("timeout", "fixture timed out"); },
    async () => { throw new ProviderFailure("cancelled", "fixture cancelled"); },
  ];
  for (const transport of cases) {
    const output = await capture(transport);
    assert.equal(output.result.ok, false);
    const receipt = await intake(output);
    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.replayed_result_sha256, hash(encode(output.result)));
    assert.deepEqual(receipt.attempts.flatMap((item) => item.failures), output.result.manifest.failures);
  }
});

test("secondary retry-backoff failure remains in the complete journal", async () => {
  const output = await capture(async () => ({ status: 429, bytes: Buffer.from("fixture limit") }), fixture(),
    async () => { throw new ProviderFailure("cancelled", "fixture backoff cancelled"); });
  const receipt = await intake(output);
  assert.equal(receipt.outcome, "failed");
  assert.deepEqual(receipt.attempts[0].failures.map((item) => item.kind), ["rate-limit", "cancelled"]);
  assert.equal(receipt.replayed_result_sha256, hash(encode(output.result)));
});

test("every independent binding rejects a different run or changed packet", async () => {
  const first = await capture();
  const second = await capture(undefined, { ...fixture(), run_id: "intake-fixture-002" });
  await assert.rejects(verifyProviderRunEvidence(second.evidence.bytes, bindings(first)), /packet digest does not match/);
  for (const field of Object.keys(bindings(first))) {
    const expected = { ...bindings(first), [field]: "0".repeat(64) };
    await assert.rejects(verifyProviderRunEvidence(first.evidence.bytes, expected), /digest does not match|binding mismatch/);
  }
  const changed = Buffer.from(first.evidence.bytes);
  changed[0] = 32;
  await assert.rejects(verifyProviderRunEvidence(changed, bindings(first)), /packet digest does not match/);
});

test("generic byte-valid packets cannot splice identities, config, prompts or success claims", async () => {
  const original = await capture();
  const cases = [
    (_packet, context) => { context.configuration.run_id = "other-run"; },
    (packet) => { packet.model_version = "other-model-version"; },
    (_packet, context) => { context.http_request.url = "https://other.invalid/chat/completions"; },
    (_packet, context) => { context.configuration.policy.max_cost_usd = 0; },
    (_packet, context) => { context.observed_execution.manifest.tokens.input += 1; },
    (_packet, context) => { context.observed_execution.transport_attempts[0].http_status = 429; },
    (packet) => { packet.attempts[0].usage.output_tokens += 1; },
    (_packet, context) => { context.observed_execution.manifest.raw_response_path = "another-run.provider-evidence.json"; },
    (_packet, context) => { context.observed_execution.manifest.seed = 4; },
    (_packet, context) => {
      const request = JSON.parse(context.http_request.body);
      request.messages[0].content = "different prompt";
      context.http_request.body = JSON.stringify(request);
      context.request_sha256 = hash(context.http_request.body);
    },
  ];
  for (const change of cases) await assert.rejects(intake(reseal(original, change)), /Invalid provider evidence intake/);
});

test("failed attempt histories cannot be erased or changed under retained external bindings", async () => {
  const original = await capture(async ({ attempt }) => attempt === 1 ?
    { status: 429, bytes: Buffer.from("fixture limit") } : { status: 200, bytes: response() });
  const changed = reseal(original, (packet, context) => {
    packet.attempts.shift();
    packet.attempts[0].attempt = 1;
    context.observed_execution.manifest.attempts = 1;
    context.observed_execution.manifest.failures = [];
    context.observed_execution.transport_attempts = [{ attempt: 1, http_status: 200 }];
  });
  await assert.rejects(verifyProviderRunEvidence(changed.evidence.bytes, { ...bindings(original), packet_sha256: changed.evidence.sha256 }), /context binding mismatch/);
  await assert.rejects(intake(reseal(original, (packet) => { packet.attempts[0].failure.kind = "quota"; })), /complete runner journal/);
});

test("unsupported envelopes and unbounded replay policy fail closed", async () => {
  const original = await capture();
  for (const change of [
    (packet) => { packet.origin = "caller-supplied-unverified"; },
    (_packet, context) => { context.configuration.schema_version = "production"; },
    (_packet, context) => { context.configuration.policy.max_attempts = 1_000_000; },
    (_packet, context) => { context.configuration.options.approved = true; },
    (_packet, context) => { context.observed_execution.approved = true; },
  ]) await assert.rejects(intake(reseal(original, change)), /Invalid provider evidence intake/);
  await assert.rejects(verifyProviderRunEvidence(null, bindings(original)), /bounded bytes/);
  await assert.rejects(verifyProviderRunEvidence(Buffer.alloc(6_500_001), bindings(original)), /bounded bytes/);
  const expected = bindings(original);
  Object.defineProperty(expected, "manifest_sha256", { get: () => assert.fail("must not read binding accessor") });
  await assert.rejects(verifyProviderRunEvidence(original.evidence.bytes, expected), /data properties/);
});

test("input buffers and expected bindings are snapshotted; returned receipt is deeply immutable", async () => {
  const output = await capture();
  const expected = bindings(output);
  const pending = verifyProviderRunEvidence(output.evidence.bytes, expected);
  expected.manifest_sha256 = "0".repeat(64);
  output.evidence.bytes.fill(65);
  const receipt = await pending;
  assert.notEqual(receipt.bindings.manifest_sha256, expected.manifest_sha256);
  assert.throws(() => { receipt.attempts[0].usage.input_tokens = 0; }, TypeError);
  assert.throws(() => { receipt.bindings.packet_sha256 = "0".repeat(64); }, TypeError);
});
