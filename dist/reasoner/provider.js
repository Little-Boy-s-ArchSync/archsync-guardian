import { createHash } from "node:crypto";
import { redactProviderArtifactPath, redactProviderDiagnostic } from "./redaction.js";
export class ProviderFailure extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}
export class FakeReasonerProvider {
    id;
    model;
    outcomes;
    calls = [];
    constructor(id, model, outcomes) {
        this.id = id;
        this.model = model;
        this.outcomes = outcomes;
    }
    async generate(request) {
        this.calls.push(request);
        const outcome = this.outcomes.shift();
        if (!outcome)
            throw new ProviderFailure("provider", "fake provider has no queued response");
        if (outcome instanceof Error)
            throw outcome;
        return outcome;
    }
}
export class OpenAICompatibleProvider {
    id;
    model;
    endpoint;
    credential;
    transport;
    constructor(id, model, endpoint, credential, transport) {
        this.id = id;
        this.model = model;
        this.endpoint = endpoint;
        this.credential = credential;
        this.transport = transport;
    }
    async generate(request) {
        const token = this.credential();
        if (!token)
            throw new ProviderFailure("quota", "provider credential is unavailable");
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
        if (result.status === 429)
            throw new ProviderFailure("rate-limit", "provider rate limit");
        if (result.status < 200 || result.status >= 300) {
            throw new ProviderFailure("provider", `provider returned HTTP ${result.status}`);
        }
        const body = result.body;
        const content = body.choices?.[0]?.message?.content;
        const input = body.usage?.prompt_tokens;
        const output = body.usage?.completion_tokens;
        const cost = body.usage?.cost_usd ?? 0;
        if (typeof content !== "string" || typeof input !== "number" ||
            typeof output !== "number" || typeof cost !== "number") {
            throw new ProviderFailure("invalid-response", "provider response is missing content or usage");
        }
        return { content, input_tokens: input, output_tokens: output, cost_usd: cost };
    }
}
function failure(error) {
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
export function conservativeInputTokenUpperBound(prompt) {
    return Buffer.byteLength(prompt, "utf8");
}
function manifest(provider, request, environment, startedAt, attempts, failures, response, status = response ? "success" : "failed") {
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
export async function executeReasonerRun(provider, prompt, policy, environment, options = {}) {
    const request = {
        prompt,
        max_tokens: policy.max_output_tokens,
        timeout_ms: policy.timeout_ms,
        temperature: options.temperature ?? 0,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
    };
    const startedAt = environment.now();
    const failures = [];
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
        }
        catch (error) {
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
//# sourceMappingURL=provider.js.map