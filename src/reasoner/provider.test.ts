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

  it("retries transient failures with bounded backoff", async () => {
    const provider = new FakeReasonerProvider("fake", "fixture", [
      new ProviderFailure("rate-limit", "429"),
      response,
    ]);
    const env = environment();
    const result = await executeReasonerRun(provider, "prompt", policy, env);
    expect(result.ok).toBe(true);
    expect(result.manifest.failures).toEqual([{ attempt: 1, kind: "rate-limit", message: "429" }]);
    expect(env.waits).toEqual([10]);
    expect(provider.calls[0]).not.toHaveProperty("seed");
    expect(provider.calls[0]?.temperature).toBe(0);
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
      expect(provider.calls).toHaveLength(1);
    }
  });

  it("rejects invalid retry configuration and an empty fake queue", async () => {
    await expect(executeReasonerRun(
      new FakeReasonerProvider("fake", "fixture", []),
      "prompt",
      { ...policy, max_attempts: 0 },
      environment(),
    )).rejects.toThrow("unreachable provider retry state");
    await expect(new FakeReasonerProvider("fake", "fixture", []).generate({
      prompt: "x", max_tokens: 1, timeout_ms: 1, temperature: 0,
    })).rejects.toThrow("no queued response");
  });

  it("maps an OpenAI-compatible response without exposing the credential", async () => {
    const requests: unknown[] = [];
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
    expect(await provider.generate({ prompt: "p", max_tokens: 9, timeout_ms: 20, temperature: 0 })).toEqual({
      content: "result", input_tokens: 4, output_tokens: 2, cost_usd: 0,
    });
    expect(JSON.stringify(requests)).toContain("Bearer secret-token");
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
