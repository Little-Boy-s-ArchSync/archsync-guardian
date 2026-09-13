import { createHash } from "node:crypto";

import { executeReasonerRun, OpenAICompatibleProvider, ProviderFailure } from "../dist/reasoner/provider.js";
import { providerEvidenceLimits, verifyProviderEvidencePacket } from "./provider-evidence.mjs";

const endpoint = "https://fixture.invalid/chat/completions";
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (left, right) => encode(left).equals(encode(right));
const digestFields = ["packet_sha256", "configuration_sha256", "request_sha256", "context_sha256", "manifest_sha256"];
const failure = (message) => { throw new Error("Invalid provider evidence intake: " + message); };
const requireValue = (condition, message) => { if (!condition) failure(message); };

function fields(value, names, label) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, label + " must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(descriptors).every((key) => typeof key === "string" && Object.hasOwn(descriptors[key], "value")), label + " must have data properties");
  requireValue(equal(Object.keys(descriptors).sort(), [...names].sort()), label + " has unexpected or missing fields");
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function measuredUsage(body) {
  const value = body?.usage;
  if (!value || !Number.isSafeInteger(value.prompt_tokens) || value.prompt_tokens < 0 ||
    !Number.isSafeInteger(value.completion_tokens) || value.completion_tokens < 0 ||
    typeof value.cost_usd !== "number" || !Number.isFinite(value.cost_usd) || value.cost_usd < 0) return null;
  return { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens, cost_usd: value.cost_usd };
}

/**
 * Preparation-only intake of the fixed synthetic runner capture. All expected
 * digests must be retained independently; recomputing them from an incoming
 * packet supplies no authenticity. There is no transport, issuer or signer.
 */
export async function verifyProviderRunEvidence(bytes, expected) {
  fields(expected, digestFields, "expected bindings");
  for (const name of digestFields) requireValue(typeof expected[name] === "string" && /^[a-f0-9]{64}$/u.test(expected[name]), name + " must be SHA-256");
  const binding = { ...expected };
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= providerEvidenceLimits.packetBytes, "packet must be bounded bytes");
  const snapshot = Buffer.from(bytes);
  verifyProviderEvidencePacket(snapshot, binding.packet_sha256);
  const packet = JSON.parse(snapshot);
  requireValue(packet.origin === "synthetic", "only synthetic runner capture is supported");
  const requestBytes = Buffer.from(packet.request.base64, "base64");
  let context;
  try { context = JSON.parse(requestBytes); } catch { failure("runner capture context must be JSON"); }
  fields(context, ["configuration", "http_request", "request_sha256", "observed_execution"], "capture context");
  requireValue(encode(context).equals(requestBytes), "capture context must be canonical");
  requireValue(hash(requestBytes) === binding.context_sha256, "context binding mismatch");
  const config = context.configuration;
  fields(config, ["schema_version", "origin", "run_id", "provider", "model", "model_version", "prompt_version", "policy", "options"], "configuration");
  requireValue(config.schema_version === "1.0.0-fixture-runner-capture" && config.origin === "synthetic", "unsupported capture configuration");
  requireValue(hash(encode(config)) === binding.configuration_sha256, "configuration binding mismatch");
  fields(config.policy, ["max_attempts", "timeout_ms", "max_input_tokens", "max_output_tokens", "max_cost_usd", "backoff_ms"], "policy");
  fields(config.options, Object.hasOwn(config.options, "seed") ? ["temperature", "seed"] : ["temperature"], "options");
  requireValue(Number.isSafeInteger(config.policy.max_attempts) && config.policy.max_attempts >= 1 && config.policy.max_attempts <= providerEvidenceLimits.attempts, "bounded replay attempts required");
  for (const name of ["run_id", "provider", "model", "model_version", "prompt_version"]) {
    requireValue(config[name] === packet[name], "packet and configuration identity mismatch");
  }
  fields(context.http_request, ["method", "url", "body"], "HTTP request");
  requireValue(context.http_request.method === "POST" && context.http_request.url === endpoint, "unsupported fixture request");
  const body = context.http_request.body;
  requireValue(typeof body === "string" && hash(body) === binding.request_sha256 && context.request_sha256 === binding.request_sha256, "HTTP request binding mismatch");
  let parsedRequest;
  try { parsedRequest = JSON.parse(body); } catch { failure("HTTP request must be JSON"); }
  const prompt = parsedRequest?.messages?.[0]?.content;
  requireValue(typeof prompt === "string" && prompt.length > 0, "prompt is missing");
  const expectedBody = JSON.stringify({
    model: config.model, messages: [{ role: "user", content: prompt }],
    max_tokens: config.policy.max_output_tokens, temperature: config.options.temperature,
    ...(config.options.seed === undefined ? {} : { seed: config.options.seed }),
  });
  requireValue(body === expectedBody, "request bytes disagree with configuration");
  fields(context.observed_execution, ["manifest", "transport_attempts"], "observed execution");
  const manifest = context.observed_execution.manifest;
  requireValue(hash(encode(manifest)) === binding.manifest_sha256, "runner manifest binding mismatch");
  requireValue(manifest?.attempts === packet.attempts.length &&
    manifest?.status === packet.outcome &&
    manifest?.started_at === packet.started_at && manifest?.finished_at === packet.finished_at,
  "packet and runner outcome or chronology disagree");
  requireValue(Array.isArray(manifest.failures), "runner failures are missing");
  const transport = context.observed_execution.transport_attempts;
  requireValue(Array.isArray(transport) && transport.length === packet.attempts.length, "transport attempt sequence disagrees");
  const observed = packet.attempts.map((attempt, index) => {
    const item = transport[index];
    fields(item, ["attempt", "http_status"], "transport attempt");
    requireValue(item.attempt === attempt.attempt, "transport attempt order disagrees");
    requireValue(item.http_status === null || (Number.isSafeInteger(item.http_status) && item.http_status >= 100 && item.http_status <= 599), "invalid HTTP status");
    requireValue((item.http_status === null) === (attempt.response === null), "response and HTTP observation disagree");
    let parsed;
    let jsonValid = false;
    if (attempt.response !== null) {
      try { parsed = JSON.parse(Buffer.from(attempt.response.base64, "base64")); jsonValid = true; } catch { /* Failed HTTP attempts may retain non-JSON bytes. */ }
    }
    const usage = measuredUsage(parsed);
    requireValue(equal(usage, attempt.usage), "measured usage disagrees with retained response bytes");
    const journal = manifest.failures.filter((entry) => entry?.attempt === attempt.attempt);
    requireValue(attempt.outcome === "success" ? journal.length === 0 :
      journal.length >= 1 && equal({ kind: journal[0]?.kind, message: journal[0]?.message }, attempt.failure),
    "attempt failure disagrees with complete runner journal");
    return { attempt, http_status: item.http_status, parsed, jsonValid, usage, journal };
  });

  // Replay the existing adapter/runner entirely from captured values. Timing,
  // no-response failures and backoff failures remain recorded observations,
  // never claims that this intake performed or authenticated remote execution.
  let index = 0;
  let clockCalls = 0;
  const provider = {
    id: config.provider,
    model: config.model,
    async generate(request) {
      const current = observed[index++];
      requireValue(current !== undefined, "runner requested an unrecorded attempt");
      if (current.attempt.response === null) {
        throw new ProviderFailure(current.attempt.failure.kind, current.attempt.failure.message);
      }
      const adapter = new OpenAICompatibleProvider(config.provider, config.model, endpoint, () => "fixture-placeholder", async (actual) => {
        requireValue(actual.body === body && actual.url === endpoint, "replayed request differs from captured bytes");
        if (current.http_status >= 200 && current.http_status < 300) {
          if (!current.jsonValid) throw new ProviderFailure("invalid-response", "response is not valid JSON");
          if (current.parsed === null || typeof current.parsed !== "object" || current.usage === null) {
            throw new ProviderFailure("invalid-response", "response is missing measured usage including cost");
          }
        }
        return { status: current.http_status, body: current.parsed };
      });
      return adapter.generate(request);
    },
  };
  const replay = await executeReasonerRun(provider, prompt, config.policy, {
    run_id: config.run_id,
    prompt_version: config.prompt_version,
    raw_response_path: config.run_id + ".provider-evidence.json",
    now: () => {
      clockCalls += 1;
      requireValue(clockCalls <= 2, "unexpected replay clock access");
      return clockCalls === 1 ? packet.started_at : packet.finished_at;
    },
    wait: async () => {
      const current = observed[index - 1];
      if (current.journal.length > 1) {
        throw new ProviderFailure(current.journal[1].kind, current.journal[1].message);
      }
    },
  }, config.options);
  requireValue(index === observed.length && equal(replay.manifest, manifest), "runner replay disagrees with the recorded manifest");
  requireValue(replay.ok === (packet.outcome === "success"), "runner replay outcome disagrees");

  const measured = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  for (const item of observed) {
    if (item.usage === null) continue;
    for (const name of Object.keys(measured)) measured[name] += item.usage[name];
  }
  requireValue(Number.isSafeInteger(measured.input_tokens) && Number.isSafeInteger(measured.output_tokens) && Number.isFinite(measured.cost_usd), "aggregate measured usage exceeds numeric limits");
  return freeze({
    schema_version: "1.0.0-preparatory",
    status: "CONSISTENT_SYNTHETIC_CAPTURE",
    acceptance: "UNREVIEWED_PROVIDER_EVIDENCE",
    approval_status: "UNAPPROVED",
    production_ready: false,
    production_capability: "NOT_ISSUED",
    origin: "synthetic",
    run_id: packet.run_id,
    outcome: packet.outcome,
    bindings: binding,
    replayed_result_sha256: hash(encode(replay)),
    measured_usage: measured,
    attempts_with_unknown_usage: observed.filter((item) => item.usage === null).map((item) => item.attempt.attempt),
    timing_verification: "RECORDED_ORDER_ONLY",
    transport_authenticity: "NOT_ESTABLISHED",
    attempts: observed.map((item) => ({
      attempt: item.attempt.attempt,
      outcome: item.attempt.outcome,
      http_status: item.http_status,
      response_sha256: item.attempt.response?.sha256 ?? null,
      usage: item.usage,
      failures: item.journal,
    })),
  });
}
