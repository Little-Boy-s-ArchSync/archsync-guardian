import { createHash } from "node:crypto";

import { redactProviderArtifactPath, redactProviderDiagnostic } from "./redaction.js";

export type ProviderFailureKind = "timeout" | "rate-limit" | "quota" | "budget" | "invalid-response" | "provider";

export interface ProviderRequest {
  prompt: string;
  max_tokens: number;
  timeout_ms: number;
  temperature: number;
  seed?: number;
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
  raw_response_path: string;
  now: () => string;
  wait: (milliseconds: number) => Promise<void>;
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
    run_id: environment.run_id,
    provider: redactProviderDiagnostic(provider.id),
    model: redactProviderDiagnostic(provider.model),
    prompt_version: environment.prompt_version,
    request_hash: createHash("sha256").update(request.prompt).digest("hex"),
    started_at: startedAt,
    finished_at: environment.now(),
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
  options: { temperature?: number; seed?: number } = {},
): Promise<ProviderRunResult> {
  const request: ProviderRequest = {
    prompt,
    max_tokens: policy.max_output_tokens,
    timeout_ms: policy.timeout_ms,
    temperature: options.temperature ?? 0,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };
  const startedAt = environment.now();
  const failures: RunManifest["failures"] = [];
  if (conservativeInputTokenUpperBound(prompt) > policy.max_input_tokens) {
    failures.push({
      attempt: 0,
      kind: "budget",
      message: "prompt exceeds the configured input token budget before provider execution",
    });
    return { ok: false, manifest: manifest(provider, request, environment, startedAt, 0, failures) };
  }
  for (let attempt = 1; attempt <= policy.max_attempts; attempt += 1) {
    try {
      const response = await provider.generate(request);
      if (response.input_tokens > policy.max_input_tokens || response.output_tokens > policy.max_output_tokens || response.cost_usd > policy.max_cost_usd) {
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
      if (!retryable || attempt === policy.max_attempts) {
        return { ok: false, manifest: manifest(provider, request, environment, startedAt, attempt, failures) };
      }
      await environment.wait(policy.backoff_ms * attempt);
    }
  }
  throw new Error("unreachable provider retry state");
}
