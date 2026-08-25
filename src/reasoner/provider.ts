import { createHash } from "node:crypto";

import { redactProviderArtifactPath, redactProviderDiagnostic } from "./redaction.js";

export type ProviderFailureKind =
  | "timeout"
  | "cancelled"
  | "rate-limit"
  | "quota"
  | "budget"
  | "invalid-response"
  | "provider";

export interface ProviderRequest {
  prompt: string;
  max_tokens: number;
  timeout_ms: number;
  temperature: number;
  seed?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ReasonerProvider {
  readonly id: string;
  readonly model: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export class ProviderFailure extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
  }
}

export class FakeReasonerProvider implements ReasonerProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    readonly id: string,
    readonly model: string,
    private readonly outcomes: Array<ProviderResponse | Error>,
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new ProviderFailure("provider", "fake provider has no queued response");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeout_ms: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class OpenAICompatibleProvider implements ReasonerProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly endpoint: string,
    private readonly credential: () => string,
    private readonly transport: HttpTransport,
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw new ProviderFailure("cancelled", "provider request cancelled");
    const token = this.credential();
    if (!token) throw new ProviderFailure("quota", "provider credential is unavailable");
    const result = await this.transport({
      url: this.endpoint,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        ...(request.seed === undefined ? {} : { seed: request.seed }),
      }),
      timeout_ms: request.timeout_ms,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (result.status === 429) throw new ProviderFailure("rate-limit", "provider rate limit");
    if (result.status < 200 || result.status >= 300) {
      throw new ProviderFailure("provider", `provider returned HTTP ${result.status}`);
    }
    const body = result.body as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost_usd?: unknown };
    };
    const content = body.choices?.[0]?.message?.content;
    const input = body.usage?.prompt_tokens;
    const output = body.usage?.completion_tokens;
    const cost = body.usage?.cost_usd ?? 0;
    if (
      typeof content !== "string" || typeof input !== "number" ||
      typeof output !== "number" || typeof cost !== "number"
    ) {
      throw new ProviderFailure("invalid-response", "provider response is missing content or usage");
    }
    return { content, input_tokens: input, output_tokens: output, cost_usd: cost };
  }
}

export interface ProviderReliabilityPolicy {
  max_attempts: number;
  timeout_ms: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_cost_usd: number;
  backoff_ms: number;
}

export interface RunManifest {
  schema_version: 1;
  run_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  request_hash: string;
  started_at: string;
  finished_at: string;
  temperature: number;
  seed?: number;
  attempts: number;
  tokens: { input: number; output: number };
  cost_usd: number;
  /** Integration metadata only; this preparatory runner never writes response content. */
  raw_response_path: string;
  status: "success" | "failed";
  failures: Array<{ attempt: number; kind: ProviderFailureKind; message: string }>;
}

export interface ProviderRunResult {
  ok: boolean;
  response?: ProviderResponse;
  manifest: RunManifest;
}

export interface RunEnvironment {
  run_id: string;
  prompt_version: string;
  /** Integration metadata only; this preparatory runner never writes response content. */
  raw_response_path: string;
  now: () => string;
  wait: (milliseconds: number) => Promise<void>;
}

export interface ProviderRunOptions {
  temperature?: number;
  seed?: number;
  signal?: AbortSignal;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

const maximumTimerDelayMilliseconds = 2_147_483_647;

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function reliabilityPolicyIssue(
  policy: ProviderReliabilityPolicy,
  options: ProviderRunOptions,
): string | undefined {
  const temperature = options.temperature ?? 0;
  const checks: readonly [boolean, string][] = [
    [isPositiveSafeInteger(policy.max_attempts), "max_attempts must be a positive safe integer"],
    [isPositiveSafeInteger(policy.timeout_ms) && policy.timeout_ms <= maximumTimerDelayMilliseconds,
      "timeout_ms must be a positive safe integer within the platform timer range"],
    [isPositiveSafeInteger(policy.max_input_tokens), "max_input_tokens must be a positive safe integer"],
    [isPositiveSafeInteger(policy.max_output_tokens), "max_output_tokens must be a positive safe integer"],
    [isNonNegativeFinite(policy.max_cost_usd), "max_cost_usd must be a non-negative finite number"],
    [isNonNegativeFinite(policy.backoff_ms), "backoff_ms must be a non-negative finite number"],
    [isNonNegativeFinite(temperature), "temperature must be a non-negative finite number"],
    [options.seed === undefined || Number.isSafeInteger(options.seed), "seed must be a safe integer when provided"],
  ];
  return checks.find(([valid]) => !valid)?.[1];
}

function providerResponseIssue(response: ProviderResponse): string | undefined {
  const checks: readonly [boolean, string][] = [
    [typeof response.content === "string", "provider response content must be a string"],
    [Number.isSafeInteger(response.input_tokens) && response.input_tokens >= 0,
      "provider input token usage must be a non-negative safe integer"],
    [Number.isSafeInteger(response.output_tokens) && response.output_tokens >= 0,
      "provider output token usage must be a non-negative safe integer"],
    [isNonNegativeFinite(response.cost_usd), "provider cost must be a non-negative finite number"],
  ];
  return checks.find(([valid]) => !valid)?.[1];
}

function cancellationFailure(): ProviderFailure {
  return new ProviderFailure("cancelled", "provider run cancelled");
}

function timeoutFailure(): ProviderFailure {
  return new ProviderFailure("timeout", "provider attempt exceeded its configured timeout");
}

async function generateWithCancellation(
  provider: ReasonerProvider,
  request: ProviderRequest,
  externalSignal: AbortSignal | undefined,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  let rejectControl!: (reason: ProviderFailure) => void;
  const control = new Promise<never>((_resolve, reject) => {
    rejectControl = reject;
  });
  const stop = (error: ProviderFailure): void => {
    rejectControl(error);
    controller.abort(error);
  };
  const timeout = setTimeout(() => { stop(timeoutFailure()); }, request.timeout_ms);
  const cancel = (): void => { stop(cancellationFailure()); };
  externalSignal?.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([
      provider.generate({ ...request, signal: controller.signal }),
      control,
    ]);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancel);
  }
}

async function waitWithCancellation(
  environment: RunEnvironment,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await environment.wait(milliseconds);
    return;
  }
  if (signal.aborted) throw cancellationFailure();
  let rejectCancellation!: (reason: ProviderFailure) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => { rejectCancellation(cancellationFailure()); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await Promise.race([environment.wait(milliseconds), cancellation]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function failure(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) {
    return new ProviderFailure(error.kind, redactProviderDiagnostic(error.message));
  }
  const message = redactProviderDiagnostic(error instanceof Error ? error.message : String(error));
  return new ProviderFailure(/timeout/iu.test(message) ? "timeout" : "provider", message);
}

/**
 * A byte is a conservative upper bound for a tokenizer token. This deliberately
 * rejects some prompts early rather than sending data before a provider reports
 * its tokenizer-specific usage.
 */
export function conservativeInputTokenUpperBound(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

function manifest(
  provider: ReasonerProvider,
  request: ProviderRequest,
  environment: RunEnvironment,
  startedAt: string,
  attempts: number,
  failures: RunManifest["failures"],
  response?: ProviderResponse,
  status: RunManifest["status"] = response ? "success" : "failed",
): RunManifest {
  return {
    schema_version: 1,
    run_id: redactProviderDiagnostic(environment.run_id),
    provider: redactProviderDiagnostic(provider.id),
    model: redactProviderDiagnostic(provider.model),
    prompt_version: redactProviderDiagnostic(environment.prompt_version),
    request_hash: createHash("sha256").update(request.prompt).digest("hex"),
    started_at: redactProviderDiagnostic(startedAt),
    finished_at: redactProviderDiagnostic(environment.now()),
    temperature: request.temperature,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    attempts,
    tokens: { input: response?.input_tokens ?? 0, output: response?.output_tokens ?? 0 },
    cost_usd: response?.cost_usd ?? 0,
    raw_response_path: redactProviderArtifactPath(environment.raw_response_path),
    status,
    failures,
  };
}

export async function executeReasonerRun(
  provider: ReasonerProvider,
  prompt: string,
  policy: ProviderReliabilityPolicy,
  environment: RunEnvironment,
  options: ProviderRunOptions = {},
): Promise<ProviderRunResult> {
  const startedAt = environment.now();
  const failures: RunManifest["failures"] = [];
  const effectivePolicy: ProviderReliabilityPolicy = { ...policy };
  const policyIssue = reliabilityPolicyIssue(effectivePolicy, options);
  if (policyIssue !== undefined) {
    const safeRequest: ProviderRequest = {
      prompt,
      max_tokens: 0,
      timeout_ms: 0,
      temperature: 0,
    };
    failures.push({ attempt: 0, kind: "budget", message: `invalid provider reliability policy: ${policyIssue}` });
    return { ok: false, manifest: manifest(provider, safeRequest, environment, startedAt, 0, failures) };
  }
  const request: ProviderRequest = {
    prompt,
    max_tokens: effectivePolicy.max_output_tokens,
    timeout_ms: effectivePolicy.timeout_ms,
    temperature: options.temperature ?? 0,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };
  if (conservativeInputTokenUpperBound(prompt) > effectivePolicy.max_input_tokens) {
    failures.push({
      attempt: 0,
      kind: "budget",
      message: "prompt exceeds the configured input token budget before provider execution",
    });
    return { ok: false, manifest: manifest(provider, request, environment, startedAt, 0, failures) };
  }
  if (options.signal?.aborted) {
    const item = cancellationFailure();
    failures.push({ attempt: 0, kind: item.kind, message: item.message });
    return { ok: false, manifest: manifest(provider, request, environment, startedAt, 0, failures) };
  }
  const runAttempt = async (attempt: number): Promise<ProviderRunResult> => {
    try {
      const response = await generateWithCancellation(provider, request, options.signal);
      const responseIssue = providerResponseIssue(response);
      if (responseIssue !== undefined) {
        failures.push({ attempt, kind: "invalid-response", message: responseIssue });
        return { ok: false, manifest: manifest(provider, request, environment, startedAt, attempt, failures) };
      }
      if (response.input_tokens > effectivePolicy.max_input_tokens || response.output_tokens > effectivePolicy.max_output_tokens || response.cost_usd > effectivePolicy.max_cost_usd) {
        failures.push({
          attempt,
          kind: "budget",
          message: "provider response exceeded the configured token or cost budget",
        });
        return {
          ok: false,
          manifest: manifest(provider, request, environment, startedAt, attempt, failures, response, "failed"),
        };
      }
      return {
        ok: true,
        response,
        manifest: manifest(provider, request, environment, startedAt, attempt, failures, response),
      };
    } catch (error) {
      const item = failure(error);
      failures.push({ attempt, kind: item.kind, message: item.message });
      const retryable = ["timeout", "rate-limit", "provider"].includes(item.kind);
      if (!retryable || attempt === effectivePolicy.max_attempts) {
        return { ok: false, manifest: manifest(provider, request, environment, startedAt, attempt, failures) };
      }
      try {
        await waitWithCancellation(environment, effectivePolicy.backoff_ms * attempt, options.signal);
      } catch (backoffError) {
        const backoffFailure = failure(backoffError);
        failures.push({ attempt, kind: backoffFailure.kind, message: backoffFailure.message });
        return { ok: false, manifest: manifest(provider, request, environment, startedAt, attempt, failures) };
      }
      return runAttempt(attempt + 1);
    }
  };
  return runAttempt(1);
}
