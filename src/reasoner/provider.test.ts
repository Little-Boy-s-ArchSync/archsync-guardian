import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeReasonerRun,
  FakeReasonerProvider,
  OpenAICompatibleProvider,
  ProviderFailure,
  type ProviderReliabilityPolicy,
  type ProviderResponse,
  type ReasonerProvider,
  type RunEnvironment,
} from "./provider.js";

const response: ProviderResponse = { content: "{}", input_tokens: 10, output_tokens: 5, cost_usd: 0.01 };
const policy: ProviderReliabilityPolicy = {
  max_attempts: 2,
  timeout_ms: 500,
  max_input_tokens: 100,
  max_output_tokens: 50,
  max_cost_usd: 0.1,
  backoff_ms: 10,
};

function environment(): RunEnvironment & { waits: number[] } {
  const timestamps = ["2026-08-26T00:00:00Z", "2026-08-26T00:00:01Z"];
  const waits: number[] = [];
  return {
    run_id: "run-1",
    prompt_version: "prompt-v1",
    raw_response_path: "raw/run-1.json",
    now: () => timestamps.shift() ?? "2026-08-26T00:00:02Z",
    wait: async (milliseconds) => { waits.push(milliseconds); },
    waits,
  };
}

describe("reasoner providers", () => {
  it("runs a fake provider and records complete provenance without raw content", async () => {
    const provider = new FakeReasonerProvider("fake", "fixture", [response]);
    const env = environment();
    const result = await executeReasonerRun(provider, "prompt", policy, env, { temperature: 0.2, seed: 7 });
    expect(result.ok).toBe(true);
    expect(result.response).toEqual(response);
    expect(provider.calls[0]).toMatchObject({ max_tokens: 50, timeout_ms: 500, temperature: 0.2, seed: 7 });
    expect(result.manifest).toMatchObject({
      status: "success",
      attempts: 1,
      provider: "fake",
      model: "fixture",
      prompt_version: "prompt-v1",
      tokens: { input: 10, output: 5 },
      cost_usd: 0.01,
      seed: 7,
    });
    expect(JSON.stringify(result.manifest)).not.toContain(response.content);
    expect(result.manifest.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats raw response paths as metadata and never writes fake-provider content", async () => {
    const root = await mkdtemp(join(tmpdir(), "archsync-provider-contract-"));
    const rawPath = join(root, "raw", "run.json");
    try {
      for (const outcome of [response, { ...response, output_tokens: policy.max_output_tokens + 1 }]) {
        const provider = new FakeReasonerProvider("fake", "fixture", [outcome]);
        await executeReasonerRun(provider, "prompt", policy, {
          ...environment(),
          raw_response_path: rawPath,
        });
        await expect(access(rawPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries transient failures with bounded backoff", async () => {
    const controller = new AbortController();
    const provider = new FakeReasonerProvider("fake", "fixture", [
      new ProviderFailure("rate-limit", "429"),
      response,
    ]);
    const env = environment();
    const result = await executeReasonerRun(provider, "prompt", policy, env, { signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(result.manifest.failures).toEqual([{ attempt: 1, kind: "rate-limit", message: "429" }]);
    expect(env.waits).toEqual([10]);
    expect(provider.calls[0]).not.toHaveProperty("seed");
    expect(provider.calls[0]?.temperature).toBe(0);
  });

  it("fails closed if cancellation lands between an attempt and retry backoff", async () => {
    const controller = new AbortController();
    const failure = new ProviderFailure("rate-limit", "429");
    Object.defineProperty(failure, "message", {
      configurable: true,
      get: () => {
        controller.abort();
        return "429";
      },
    });
    const provider = new FakeReasonerProvider("fake", "fixture", [failure, response]);
    const result = await executeReasonerRun(provider, "prompt", policy, environment(), {
      signal: controller.signal,
    });
    expect(provider.calls).toHaveLength(1);
    expect(result.manifest.attempts).toBe(1);
    expect(result.manifest.failures.map(({ kind }) => kind)).toEqual(["rate-limit", "cancelled"]);
  });

  it("fails closed before transport when externally cancelled in advance", async () => {
    const controller = new AbortController();
    controller.abort("Bearer cancellation-reason-must-not-leak");
    let transportCalls = 0;
    const provider = new OpenAICompatibleProvider("fake", "fixture", "https://provider.invalid", () => "key", async () => {
      transportCalls += 1;
      return { status: 200, body: {} };
    });
    const result = await executeReasonerRun(provider, "prompt", policy, environment(), { signal: controller.signal });
    expect(result).toMatchObject({
      ok: false,
      manifest: {
        attempts: 0,
        status: "failed",
        failures: [{ attempt: 0, kind: "cancelled", message: "provider run cancelled" }],
      },
    });
    expect(transportCalls).toBe(0);
    expect(JSON.stringify(result.manifest)).not.toContain("cancellation-reason-must-not-leak");
  });

  it("owns the per-attempt timeout and aborts the injected transport", async () => {
    let transportSignal: AbortSignal | undefined;
    const provider = new OpenAICompatibleProvider("fake", "fixture", "https://provider.invalid", () => "key", async (request) => {
      transportSignal = request.signal;
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => { reject(request.signal?.reason); }, { once: true });
      });
    });
    const result = await executeReasonerRun(
      provider,
      "prompt",
      { ...policy, max_attempts: 1, timeout_ms: 10 },
      environment(),
    );
    expect(transportSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      manifest: {
        attempts: 1,
        failures: [{ attempt: 1, kind: "timeout", message: "provider attempt exceeded its configured timeout" }],
      },
    });
  });

  it("aborts an in-flight transport on external cancellation", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let transportSignal: AbortSignal | undefined;
    const provider = new OpenAICompatibleProvider("fake", "fixture", "https://provider.invalid", () => "key", async (request) => {
      transportSignal = request.signal;
      markStarted();
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => { reject(request.signal?.reason); }, { once: true });
      });
    });
    const running = executeReasonerRun(provider, "prompt", policy, environment(), { signal: controller.signal });
    await started;
    controller.abort("password=external-reason-must-not-leak");
    const result = await running;
    expect(transportSignal?.aborted).toBe(true);
    expect(result.manifest.failures).toEqual([{
      attempt: 1,
      kind: "cancelled",
      message: "provider run cancelled",
    }]);
    expect(JSON.stringify(result.manifest)).not.toContain("external-reason-must-not-leak");
  });

  it("cancels retry backoff before another transport attempt", async () => {
    const controller = new AbortController();
    let transportCalls = 0;
    const provider = new OpenAICompatibleProvider("fake", "fixture", "https://provider.invalid", () => "key", async () => {
      transportCalls += 1;
      return { status: 429, body: {} };
    });
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const env = environment();
    env.wait = async (milliseconds) => {
      env.waits.push(milliseconds);
      markWaiting();
      await new Promise<void>(() => {});
    };
    const running = executeReasonerRun(provider, "prompt", policy, env, { signal: controller.signal });
    await waiting;
    controller.abort();
    const result = await running;
    expect(transportCalls).toBe(1);
    expect(env.waits).toEqual([10]);
    expect(result.manifest.attempts).toBe(1);
    expect(result.manifest.failures.map(({ kind }) => kind)).toEqual(["rate-limit", "cancelled"]);
  });

  it("classifies timeouts, exhausts retries, and preserves failed attempts", async () => {
    const provider = new FakeReasonerProvider("fake", "fixture", [
      new Error("request timeout"),
      new Error("network unavailable"),
    ]);
    const result = await executeReasonerRun(provider, "prompt", policy, environment());
    expect(result.ok).toBe(false);
    expect(result.manifest.status).toBe("failed");
    expect(result.manifest.tokens).toEqual({ input: 0, output: 0 });
    expect(result.manifest.failures.map(({ kind }) => kind)).toEqual(["timeout", "provider"]);
  });

  it("fails closed without retry for quota and response budgets", async () => {
    const quota = new FakeReasonerProvider("fake", "fixture", [new ProviderFailure("quota", "no key")]);
    expect((await executeReasonerRun(quota, "prompt", policy, environment())).manifest.attempts).toBe(1);

    for (const over of [
      { ...response, input_tokens: 101 },
      { ...response, output_tokens: 51 },
      { ...response, cost_usd: 0.11 },
    ]) {
      const provider = new FakeReasonerProvider("fake", "fixture", [over]);
      const result = await executeReasonerRun(provider, "prompt", policy, environment());
      expect(result.ok).toBe(false);
      expect(result.manifest.failures[0]?.kind).toBe("budget");
      expect(result.manifest.tokens).toEqual({ input: over.input_tokens, output: over.output_tokens });
      expect(result.manifest.cost_usd).toBe(over.cost_usd);
      expect(provider.calls).toHaveLength(1);
    }
  });

  it("rejects an oversized prompt before provider execution", async () => {
    const provider = new FakeReasonerProvider("fake", "fixture", [response]);
    const result = await executeReasonerRun(provider, "x".repeat(101), policy, environment());
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(result.manifest.attempts).toBe(0);
    expect(result.manifest.failures).toEqual([{
      attempt: 0,
      kind: "budget",
      message: "prompt exceeds the configured input token budget before provider execution",
    }]);
  });

  it("redacts provider diagnostics and raw artifact paths in failed manifests", async () => {
    const provider = new FakeReasonerProvider("api_key=provider-private", "secret=model-private", [
      new ProviderFailure("provider", "Bearer private.token /var/member/private/error.txt"),
    ]);
    const env = {
      ...environment(),
      run_id: "token=run-private",
      prompt_version: "password=prompt-private",
      raw_response_path: "/opt/member/private/raw.json",
      now: () => "api_key=time-private /tmp/private/clock.txt",
    };
    const result = await executeReasonerRun(provider, "prompt", { ...policy, max_attempts: 1 }, env);
    const serialized = JSON.stringify(result.manifest);
    for (const leaked of [
      "private.token",
      "provider-private",
      "model-private",
      "run-private",
      "prompt-private",
      "time-private",
      "/var/member",
      "/opt/member",
      "/tmp/private",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(result.manifest.raw_response_path).toBe("[REDACTED_PATH]");
  });

  it("rejects non-finite, negative, and structurally invalid limits before a provider call", async () => {
    const cases: Array<{
      policy?: Partial<ProviderReliabilityPolicy>;
      options?: { temperature?: number; seed?: number };
      field: string;
    }> = [
      { policy: { max_attempts: 0 }, field: "max_attempts" },
      { policy: { max_attempts: -1 }, field: "max_attempts" },
      { policy: { timeout_ms: -1 }, field: "timeout_ms" },
      { policy: { timeout_ms: 2_147_483_648 }, field: "timeout_ms" },
      { policy: { max_input_tokens: Number.NaN }, field: "max_input_tokens" },
      { policy: { max_output_tokens: Number.POSITIVE_INFINITY }, field: "max_output_tokens" },
      { policy: { max_cost_usd: -1 }, field: "max_cost_usd" },
      { policy: { max_cost_usd: Number.POSITIVE_INFINITY }, field: "max_cost_usd" },
      { policy: { backoff_ms: Number.NaN }, field: "backoff_ms" },
      { options: { temperature: -1 }, field: "temperature" },
      { options: { temperature: Number.POSITIVE_INFINITY }, field: "temperature" },
      { options: { seed: Number.NaN }, field: "seed" },
    ];
    for (const item of cases) {
      const provider = new FakeReasonerProvider("fake", "fixture", [response]);
      const result = await executeReasonerRun(
        provider,
        "oversized".repeat(20),
        { ...policy, ...item.policy },
        environment(),
        item.options,
      );
      expect(result.ok).toBe(false);
      expect(provider.calls).toHaveLength(0);
      expect(result.manifest.attempts).toBe(0);
      expect(result.manifest.failures).toHaveLength(1);
      expect(result.manifest.failures[0]).toMatchObject({ attempt: 0, kind: "budget" });
      expect(result.manifest.failures[0]?.message).toContain(item.field);
    }
  });

  it("rejects non-finite, negative, and malformed provider usage without persisting it", async () => {
    const cases: Array<[ProviderResponse, string]> = [
      [{ ...response, content: 17 as unknown as string }, "content"],
      [{ ...response, input_tokens: -1 }, "input token"],
      [{ ...response, input_tokens: Number.NaN }, "input token"],
      [{ ...response, input_tokens: Number.POSITIVE_INFINITY }, "input token"],
      [{ ...response, output_tokens: -1 }, "output token"],
      [{ ...response, output_tokens: Number.NaN }, "output token"],
      [{ ...response, output_tokens: Number.POSITIVE_INFINITY }, "output token"],
      [{ ...response, cost_usd: -1 }, "cost"],
      [{ ...response, cost_usd: Number.NaN }, "cost"],
      [{ ...response, cost_usd: Number.POSITIVE_INFINITY }, "cost"],
    ];
    for (const [invalidResponse, message] of cases) {
      const provider = new FakeReasonerProvider("fake", "fixture", [invalidResponse]);
      const result = await executeReasonerRun(provider, "prompt", policy, environment());
      expect(result.ok).toBe(false);
      expect(provider.calls).toHaveLength(1);
      expect(result.manifest).toMatchObject({
        status: "failed",
        attempts: 1,
        tokens: { input: 0, output: 0 },
        cost_usd: 0,
        failures: [{ attempt: 1, kind: "invalid-response" }],
      });
      expect(result.manifest.failures[0]?.message).toContain(message);
    }
  });

  it("rejects an empty fake queue", async () => {
    await expect(new FakeReasonerProvider("fake", "fixture", []).generate({
      prompt: "x", max_tokens: 1, timeout_ms: 1, temperature: 0,
    })).rejects.toThrow("no queued response");
  });

  it("maps an OpenAI-compatible response without exposing the credential", async () => {
    const requests: unknown[] = [];
    const controller = new AbortController();
    const provider = new OpenAICompatibleProvider(
      "openai-compatible",
      "model-1",
      "https://provider.invalid/v1/chat/completions",
      () => "secret-token",
      async (request) => {
        requests.push(request);
        return {
          status: 200,
          body: {
            choices: [{ message: { content: "result" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          },
        };
      },
    );
    expect(await provider.generate({
      prompt: "p", max_tokens: 9, timeout_ms: 20, temperature: 0, signal: controller.signal,
    })).toEqual({
      content: "result", input_tokens: 4, output_tokens: 2, cost_usd: 0,
    });
    expect(JSON.stringify(requests)).toContain("Bearer secret-token");
    expect((requests[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
    expect(JSON.parse((requests[0] as { body: string }).body)).not.toHaveProperty("seed");
  });

  it("maps seed, HTTP failures, missing credentials, and malformed bodies", async () => {
    const bodies: unknown[] = [];
    const transport = async () => ({ status: 200, body: bodies.shift() });
    const provider = new OpenAICompatibleProvider("p", "m", "https://p.invalid", () => "key", transport);
    bodies.push({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.02 } });
    expect(await provider.generate({ prompt: "p", max_tokens: 1, timeout_ms: 1, temperature: 0, seed: 3 })).toMatchObject({ cost_usd: 0.02 });

    const statusProvider = (status: number) => new OpenAICompatibleProvider("p", "m", "x", () => "key", async () => ({ status, body: {} }));
    await expect(statusProvider(429).generate({ prompt: "p", max_tokens: 1, timeout_ms: 1, temperature: 0 })).rejects.toMatchObject({ kind: "rate-limit" });
    await expect(statusProvider(500).generate({ prompt: "p", max_tokens: 1, timeout_ms: 1, temperature: 0 })).rejects.toMatchObject({ kind: "provider" });
    await expect(new OpenAICompatibleProvider("p", "m", "x", () => "", transport).generate({ prompt: "p", max_tokens: 1, timeout_ms: 1, temperature: 0 })).rejects.toMatchObject({ kind: "quota" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(provider.generate({
      prompt: "p", max_tokens: 1, timeout_ms: 1, temperature: 0, signal: cancelled.signal,
    })).rejects.toMatchObject({ kind: "cancelled" });

    for (const body of [
      { usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ message: { content: "x" } }], usage: { completion_tokens: 1 } },
      { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1 } },
      { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost_usd: "x" } },
    ]) {
      bodies.push(body);
      await expect(provider.generate({ prompt: "p", max_tokens: 1, timeout_ms: 1, temperature: 0 })).rejects.toMatchObject({ kind: "invalid-response" });
    }
  });

  it("classifies non-Error provider throws", async () => {
    const provider: ReasonerProvider = { id: "p", model: "m", generate: async () => { throw 17; } };
    const result = await executeReasonerRun(provider, "prompt", { ...policy, max_attempts: 1 }, environment());
    expect(result.manifest.failures[0]).toEqual({ attempt: 1, kind: "provider", message: "17" });
  });
});
