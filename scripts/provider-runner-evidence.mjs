import { createHash } from "node:crypto";

import { executeReasonerRun, OpenAICompatibleProvider, ProviderFailure } from "../dist/reasoner/provider.js";
import { redactProviderDiagnostic } from "../dist/reasoner/redaction.js";
import { createProviderEvidencePacket, persistProviderEvidence, providerEvidenceLimits, snapshotProviderEvidenceContent } from "./provider-evidence.mjs";

const endpoint = "https://fixture.invalid/chat/completions";
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid provider capture: ${message}`);
}

function object(value, fields, name) {
  requireValue(value !== null && Object.getPrototypeOf(value) === Object.prototype, `${name} must be a plain object`);
  requireValue(Object.keys(value).every((key) => fields.includes(key)), `${name} has unexpected fields`);
  requireValue(Object.values(Object.getOwnPropertyDescriptors(value)).every((item) => "value" in item), `${name} must contain data properties`);
}

function clock(now) {
  let previous;
  return () => {
    const value = now();
    requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "clock must return UTC milliseconds");
    requireValue(previous === undefined || value >= previous, "clock moved backwards");
    previous = value;
    return value;
  };
}

function measuredUsage(body) {
  const value = body?.usage;
  if (!value || !Number.isSafeInteger(value.prompt_tokens) || value.prompt_tokens < 0 ||
    !Number.isSafeInteger(value.completion_tokens) || value.completion_tokens < 0 ||
    typeof value.cost_usd !== "number" || !Number.isFinite(value.cost_usd) || value.cost_usd < 0) return null;
  return { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens, cost_usd: value.cost_usd };
}

/**
 * Offline bridge: the only transport is an explicitly injected callback. It has
 * no credentials, network implementation, model default, or production approval.
 * Callback promises must represent a complete HTTP response, not parsed objects.
 */
async function capture(input, dependencies) {
  object(input, ["run_id", "provider", "model", "model_version", "prompt_version", "prompt", "policy", "options"], "input");
  object(input.policy, ["max_attempts", "timeout_ms", "max_input_tokens", "max_output_tokens", "max_cost_usd", "backoff_ms"], "policy");
  object(input.options ?? {}, ["temperature", "seed"], "options");
  object(dependencies, ["transport", "now", "wait", "signal"], "dependencies");
  for (const name of ["transport", "now", "wait"]) requireValue(typeof dependencies[name] === "function", `${name} callback is required`);
  for (const name of ["run_id", "provider", "model", "model_version", "prompt_version", "prompt"]) {
    requireValue(typeof input[name] === "string" && input[name].length > 0, `${name} is required`);
  }
  requireValue(/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.run_id), "run_id must be portable");
  for (const name of ["run_id", "provider", "model", "model_version", "prompt_version"]) {
    requireValue(Buffer.byteLength(input[name]) <= 256, `${name} exceeds the limit`);
    requireValue(!/[\u0000-\u001f\u007f]/u.test(input[name]), `${name} contains control characters`);
    requireValue(redactProviderDiagnostic(input[name]) === input[name], `${name} requires redaction`);
  }
  requireValue(Number.isSafeInteger(input.policy.max_attempts) && input.policy.max_attempts > 0 && input.policy.max_attempts <= providerEvidenceLimits.attempts, "max_attempts must be between 1 and 8");
  for (const [name, value] of Object.entries(input.policy)) requireValue(typeof value === "number" && Number.isFinite(value), `policy ${name} must be finite`);
  for (const [name, value] of Object.entries(input.options ?? {})) requireValue(typeof value === "number" && Number.isFinite(value), `option ${name} must be finite`);

  // Copy every caller-controlled configuration value before the first await.
  const config = JSON.parse(JSON.stringify({
    schema_version: "1.0.0-fixture-runner-capture",
    origin: "synthetic",
    run_id: input.run_id,
    provider: input.provider,
    model: input.model,
    model_version: input.model_version,
    prompt_version: input.prompt_version,
    policy: input.policy,
    options: { temperature: 0, ...input.options },
  }));
  const prompt = input.prompt;
  const now = clock(dependencies.now);
  const suppliedWait = dependencies.wait;
  const transport = dependencies.transport;
  const signal = dependencies.signal;
  const wait = async (milliseconds) => {
    await suppliedWait(milliseconds);
    // An immediately fulfilled wait can win Promise.race against cancellation
    // fired inside that wait. Recheck before the runner starts another attempt.
    if (signal?.aborted) throw new ProviderFailure("cancelled", "provider capture cancelled during backoff");
  };
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: config.policy.max_output_tokens,
    temperature: config.options.temperature,
    ...(config.options.seed === undefined ? {} : { seed: config.options.seed }),
  });
  const context = { configuration: config, http_request: { method: "POST", url: endpoint, body }, request_sha256: hash(body) };
  const request = encode(context);
  snapshotProviderEvidenceContent(request, "request");
  const configurationSha256 = hash(encode(config));
  const attempts = [];
  let captureIssue = null;
  let retainedBytes = 0;

  const provider = {
    id: config.provider,
    model: config.model,
    async generate(providerRequest) {
      const attempt = { attempt: attempts.length + 1, started_at: now(), finished_at: null, response: null, usage: null, http_status: null };
      attempts.push(attempt);
      const adapter = new OpenAICompatibleProvider(config.provider, config.model, endpoint, () => "fixture-placeholder", async (httpRequest) => {
        requireValue(httpRequest.body === body && httpRequest.url === endpoint, "runner request does not match the bound request");
        let ended = false;
        let onAbort;
        const abort = new Promise((_resolve, reject) => {
          onAbort = () => {
            ended = true;
            attempt.finished_at ??= now();
            reject(httpRequest.signal.reason instanceof ProviderFailure ? httpRequest.signal.reason : new ProviderFailure("cancelled", "provider capture cancelled"));
          };
          httpRequest.signal.addEventListener("abort", onAbort, { once: true });
          if (httpRequest.signal.aborted) onAbort();
        });
        try {
          if (ended) throw new ProviderFailure("cancelled", "provider capture cancelled before transport");
          const received = Promise.resolve().then(() => transport(Object.freeze({
            run_id: config.run_id,
            attempt: attempt.attempt,
            method: "POST",
            url: endpoint,
            headers: Object.freeze({ "content-type": "application/json" }),
            body: httpRequest.body,
            request_sha256: hash(httpRequest.body),
            configuration_sha256: configurationSha256,
            timeout_ms: httpRequest.timeout_ms,
            signal: httpRequest.signal,
          }))).then((response) => {
            // A transport that ignores cancellation cannot alter a closed attempt.
            if (ended) throw new ProviderFailure("cancelled", "response arrived after attempt termination");
            object(response, ["status", "bytes"], "transport response");
            requireValue(Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599, "HTTP status is invalid");
            attempt.http_status = response.status;
            try {
              const snapshot = snapshotProviderEvidenceContent(response.bytes, "response");
              retainedBytes += snapshot.bytes;
              requireValue(retainedBytes <= providerEvidenceLimits.totalResponseBytes, "total response bytes exceed the limit");
              attempt.response = Buffer.from(snapshot.base64, "base64");
            } catch {
              captureIssue = "Received bytes cannot be retained under the evidence content limits or redaction checks";
              throw new ProviderFailure("invalid-response", "response bytes fail evidence checks");
            }
            let parsed;
            try { parsed = JSON.parse(attempt.response.toString("utf8")); } catch {
              if (response.status >= 200 && response.status < 300) throw new ProviderFailure("invalid-response", "response is not valid JSON");
            }
            attempt.usage = measuredUsage(parsed);
            if (response.status >= 200 && response.status < 300 && (parsed === null || typeof parsed !== "object" || attempt.usage === null)) {
              throw new ProviderFailure("invalid-response", "response is missing measured usage including cost");
            }
            return { status: response.status, body: parsed };
          });
          return await Promise.race([received, abort]);
        } finally {
          ended = true;
          httpRequest.signal.removeEventListener("abort", onAbort);
        }
      });
      try { return await adapter.generate(providerRequest); }
      finally { attempt.finished_at ??= now(); }
    },
  };
  const result = await executeReasonerRun(provider, prompt, config.policy, {
    run_id: config.run_id,
    prompt_version: config.prompt_version,
    raw_response_path: `${config.run_id}.provider-evidence.json`,
    now,
    wait,
  }, { ...config.options, ...(signal === undefined ? {} : { signal }) });
  const binding = {
    configuration_sha256: configurationSha256,
    request_sha256: hash(body),
    context_sha256: hash(request),
    transport_attempts: attempts.map(({ attempt, http_status }) => ({ attempt, http_status })),
  };
  requireValue(result.manifest.attempts === attempts.length, "runner and capture attempt counts differ");
  if (attempts.length === 0 || captureIssue !== null) return { result, binding, evidence: null, capture_issue: captureIssue, packetInput: null };
  // The primitive has one primary failure per attempt. Preserve the complete
  // runner journal as well, including a second failure during retry backoff.
  const executionContext = encode({ ...context, observed_execution: { manifest: result.manifest, transport_attempts: binding.transport_attempts } });
  binding.context_sha256 = hash(executionContext);
  const packetInput = {
    run_id: config.run_id, origin: "synthetic", provider: config.provider, model: config.model,
    model_version: config.model_version, prompt_version: config.prompt_version,
    started_at: result.manifest.started_at, finished_at: result.manifest.finished_at,
    outcome: result.ok ? "success" : "failed", request: executionContext,
    attempts: attempts.map((attempt, index) => {
      const failures = result.manifest.failures.filter((failure) => failure.attempt === attempt.attempt);
      const successful = result.ok && index === attempts.length - 1;
      requireValue(successful || failures.length > 0, "failed attempt is missing a runner failure");
      return {
        attempt: attempt.attempt, started_at: attempt.started_at, finished_at: attempt.finished_at,
        outcome: successful ? "success" : "failed", response: attempt.response, usage: attempt.usage,
        failure: successful ? null : { kind: failures[0].kind, message: failures[0].message },
      };
    }),
  };
  try {
    return { result, binding, evidence: createProviderEvidencePacket(packetInput), capture_issue: null, packetInput };
  } catch {
    // Preserve the runner result if the full journal/context exceeds the packet
    // bounds; never discard diagnostics or publish an incomplete substitute.
    return { result, binding, evidence: null, capture_issue: "Captured run cannot be serialized under the evidence metadata or size limits", packetInput: null };
  }
}

export async function executeProviderEvidenceRun(input, dependencies) {
  const { packetInput, ...output } = await capture(input, dependencies);
  return output;
}

/** Same existing POSIX-only, exclusive publication policy; no artifact for a rejected capture. */
export async function executeAndPersistProviderEvidenceRun(directory, input, dependencies) {
  requireValue(process.platform !== "win32", "private storage requires POSIX ownership and permissions");
  const { packetInput, ...output } = await capture(input, dependencies);
  if (packetInput === null) return { ...output, persisted: null };
  return { ...output, persisted: await persistProviderEvidence(directory, packetInput) };
}
