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
        if (request.signal?.aborted)
            throw new ProviderFailure("cancelled", "provider request cancelled");
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
            ...(request.signal === undefined ? {} : { signal: request.signal }),
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
function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
const maximumTimerDelayMilliseconds = 2_147_483_647;
function isNonNegativeFinite(value) {
    return Number.isFinite(value) && value >= 0;
}
function reliabilityPolicyIssue(policy, options) {
    const temperature = options.temperature ?? 0;
    const checks = [
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
function providerResponseIssue(response) {
    const checks = [
        [typeof response.content === "string", "provider response content must be a string"],
        [Number.isSafeInteger(response.input_tokens) && response.input_tokens >= 0,
            "provider input token usage must be a non-negative safe integer"],
        [Number.isSafeInteger(response.output_tokens) && response.output_tokens >= 0,
            "provider output token usage must be a non-negative safe integer"],
        [isNonNegativeFinite(response.cost_usd), "provider cost must be a non-negative finite number"],
    ];
    return checks.find(([valid]) => !valid)?.[1];
}
function cancellationFailure() {
    return new ProviderFailure("cancelled", "provider run cancelled");
}
function timeoutFailure() {
    return new ProviderFailure("timeout", "provider attempt exceeded its configured timeout");
}
async function generateWithCancellation(provider, request, externalSignal) {
    const controller = new AbortController();
    let rejectControl;
    const control = new Promise((_resolve, reject) => {
        rejectControl = reject;
    });
    const stop = (error) => {
        rejectControl(error);
        controller.abort(error);
    };
    const timeout = setTimeout(() => { stop(timeoutFailure()); }, request.timeout_ms);
    const cancel = () => { stop(cancellationFailure()); };
    externalSignal?.addEventListener("abort", cancel, { once: true });
    try {
        return await Promise.race([
            provider.generate({ ...request, signal: controller.signal }),
            control,
        ]);
    }
    finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", cancel);
    }
}
async function waitWithCancellation(environment, milliseconds, signal) {
    if (signal === undefined) {
        await environment.wait(milliseconds);
        return;
    }
    if (signal.aborted)
        throw cancellationFailure();
    let rejectCancellation;
    const cancellation = new Promise((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const cancel = () => { rejectCancellation(cancellationFailure()); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        await Promise.race([environment.wait(milliseconds), cancellation]);
    }
    finally {
        signal.removeEventListener("abort", cancel);
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
export async function executeReasonerRun(provider, prompt, policy, environment, options = {}) {
    const startedAt = environment.now();
    const failures = [];
    const effectivePolicy = { ...policy };
    const policyIssue = reliabilityPolicyIssue(effectivePolicy, options);
    if (policyIssue !== undefined) {
        const safeRequest = {
            prompt,
            max_tokens: 0,
            timeout_ms: 0,
            temperature: 0,
        };
        failures.push({ attempt: 0, kind: "budget", message: `invalid provider reliability policy: ${policyIssue}` });
        return { ok: false, manifest: manifest(provider, safeRequest, environment, startedAt, 0, failures) };
    }
    const request = {
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
    const runAttempt = async (attempt) => {
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
        }
        catch (error) {
            const item = failure(error);
            failures.push({ attempt, kind: item.kind, message: item.message });
            const retryable = ["timeout", "rate-limit", "provider"].includes(item.kind);
            if (!retryable || attempt === effectivePolicy.max_attempts) {
                return { ok: false, manifest: manifest(provider, request, environment, startedAt, attempt, failures) };
            }
            try {
                await waitWithCancellation(environment, effectivePolicy.backoff_ms * attempt, options.signal);
            }
            catch (backoffError) {
                const backoffFailure = failure(backoffError);
                failures.push({ attempt, kind: backoffFailure.kind, message: backoffFailure.message });
                return { ok: false, manifest: manifest(provider, request, environment, startedAt, attempt, failures) };
            }
            return runAttempt(attempt + 1);
        }
    };
    return runAttempt(1);
}
//# sourceMappingURL=provider.js.map