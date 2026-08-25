export type ProviderFailureKind = "timeout" | "cancelled" | "rate-limit" | "quota" | "budget" | "invalid-response" | "provider";
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
export declare class ProviderFailure extends Error {
    readonly kind: ProviderFailureKind;
    constructor(kind: ProviderFailureKind, message: string);
}
export declare class FakeReasonerProvider implements ReasonerProvider {
    readonly id: string;
    readonly model: string;
    private readonly outcomes;
    readonly calls: ProviderRequest[];
    constructor(id: string, model: string, outcomes: Array<ProviderResponse | Error>);
    generate(request: ProviderRequest): Promise<ProviderResponse>;
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
export declare class OpenAICompatibleProvider implements ReasonerProvider {
    readonly id: string;
    readonly model: string;
    private readonly endpoint;
    private readonly credential;
    private readonly transport;
    constructor(id: string, model: string, endpoint: string, credential: () => string, transport: HttpTransport);
    generate(request: ProviderRequest): Promise<ProviderResponse>;
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
    tokens: {
        input: number;
        output: number;
    };
    cost_usd: number;
    /** Integration metadata only; this preparatory runner never writes response content. */
    raw_response_path: string;
    status: "success" | "failed";
    failures: Array<{
        attempt: number;
        kind: ProviderFailureKind;
        message: string;
    }>;
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
/**
 * A byte is a conservative upper bound for a tokenizer token. This deliberately
 * rejects some prompts early rather than sending data before a provider reports
 * its tokenizer-specific usage.
 */
export declare function conservativeInputTokenUpperBound(prompt: string): number;
export declare function executeReasonerRun(provider: ReasonerProvider, prompt: string, policy: ProviderReliabilityPolicy, environment: RunEnvironment, options?: ProviderRunOptions): Promise<ProviderRunResult>;
//# sourceMappingURL=provider.d.ts.map