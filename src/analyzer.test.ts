import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "./analyzer.js";
import { baselineSources, testArchitecture, writeSources } from "./test-helpers.js";

let repository: string;

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "archsync-analyzer-test-"));
});

afterEach(async () => {
  await rm(repository, { recursive: true, force: true });
});

describe("TypeScript repository analyzer", () => {
  it("reconstructs deterministic HTTP and PostgreSQL relationships", async () => {
    await writeSources(repository, baselineSources);

    const first = await analyzeTypeScriptRepository(repository, testArchitecture());
    const second = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.keys(first.components)).toEqual(["frontend", "gateway", "postgres", "service"]);
    expect(first.metadata.scanned_files).toBe(3);
    expect(first.relationships.map(({ from, type, to }) => `${from}|${type}|${to}`)).toEqual([
      "frontend|http|gateway",
      "gateway|http|service",
      "service|data|postgres",
    ]);
    expect(first.relationships[0]?.evidence[0]).toMatchObject({
      file: "frontend/src/app.ts",
      line: 3,
      detector: "typescript-fetch",
    });
  });

  it("resolves DATABASE_URL without a fallback for a pg client", async () => {
    await writeSources(repository, {
      "frontend/src/app.ts": `import { Client } from "pg";
const database = new Client({ connectionString: process.env.DATABASE_URL });
export async function load(): Promise<void> {
  await database.query("select 1");
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships).toContainEqual(expect.objectContaining({
      from: "frontend",
      to: "postgres",
      type: "data",
    }));
  });

  it("detects Redis cache access and de-duplicates repeated calls", async () => {
    await writeSources(repository, {
      "service/src/cache.ts": `import { createClient } from "redis";
const redis = createClient({ url: process.env.REDIS_URL ?? "redis://redis:6379" });
export async function cache(): Promise<void> {
  await redis.get("key");
  await redis.set("key", "value");
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());
    const relationship = observed.relationships[0];

    expect(relationship).toMatchObject({ from: "service", to: "redis", type: "data" });
    expect(relationship?.evidence).toHaveLength(2);
    expect(observed.components.redis?.component).toMatchObject({ type: "cache", layer: "data" });
  });

  it("detects AMQP producer and consumer directions", async () => {
    await writeSources(repository, {
      "service/src/events.ts": `import { connect } from "amqplib";
const eventsUrl = process.env.ORDER_EVENTS_URL ?? "amqp://order-events:5672";
export async function publish(): Promise<void> {
  const connection = await connect(eventsUrl);
  const channel = await connection.createChannel();
  channel.publish("orders", "created", Buffer.from("{}"));
}
`,
      "order-worker/src/worker.ts": `import { connect } from "amqplib";
const eventsUrl = process.env.ORDER_EVENTS_URL ?? "amqp://order-events:5672";
export async function consume(): Promise<void> {
  const connection = await connect(eventsUrl);
  const channel = await connection.createChannel();
  await channel.consume("orders", () => undefined);
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships.map(({ from, type, to }) => `${from}|${type}|${to}`)).toEqual([
      "order-events|async|order-worker",
      "service|async|order-events",
    ]);
    expect(observed.components["order-worker"]?.component.type).toBe("worker");
    expect(observed.components["order-events"]?.component.type).toBe("queue");
  });

  it("ignores generated folders and self-references", async () => {
    await writeSources(repository, {
      "service/src/app.ts": `const url = "http://service:3000";
export async function call(): Promise<void> { await fetch(url); }
`,
    });
    await mkdir(join(repository, "node_modules", "fake"), { recursive: true });
    await writeFile(join(repository, "node_modules", "fake", "index.ts"), "fetch('http://unknown');", "utf8");

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.metadata.scanned_files).toBe(1);
    expect(observed.relationships).toEqual([]);
  });

  it("does not infer unsupported literal protocols", async () => {
    await writeSources(repository, {
      "service/src/app.ts": `const socket = "ftp://legacy:21";
export async function call(): Promise<void> { await fetch(socket); }
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships).toEqual([]);
  });

  it("resolves generic service and queue environment variables", async () => {
    await writeSources(repository, {
      "web-client/src/app.ts": `export async function call(): Promise<void> {
  await fetch((process.env.PAYMENT_SERVICE_URL));
}
`,
      "job-worker/src/worker.ts": `import { connect } from "amqplib";
const eventsUrl = process.env.ORDER_EVENTS_URL;
export async function consume(): Promise<void> {
  const connection = await connect(eventsUrl);
  const channel = await connection.createChannel();
  await channel.consume("orders", () => undefined);
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships.map(({ from, type, to }) => `${from}|${type}|${to}`)).toEqual([
      "order-events|async|job-worker",
      "web-client|http|payment-service",
    ]);
    expect(observed.components["web-client"]?.component.type).toBe("frontend");
    expect(observed.components["job-worker"]?.component.type).toBe("worker");
  });

  it("supports secure URL protocol variants", async () => {
    await writeSources(repository, {
      "utility/src/app.ts": `const api = "https://remote-service:443";
export async function call(): Promise<void> { await fetch(api); }
`,
      "utility/src/data.ts": `import { createClient } from "redis";
const redis = createClient({ url: "rediss://secure-cache:6380" });
export async function read(): Promise<void> { await redis.get("key"); }
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships.map(({ to }) => to)).toEqual(["secure-cache", "remote-service"]);
    expect(observed.components.utility?.component.type).toBe("service");
  });
});
