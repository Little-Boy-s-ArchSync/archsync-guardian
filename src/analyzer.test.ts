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

  it("redacts credentials and PII from persisted source evidence", async () => {
    await writeSources(repository, {
      "service/src/remote.ts": `export async function call(): Promise<void> {
  await fetch("https://member:super-secret@remote-service:443/path?token=github_pat_abcdefghijkl"); // member@example.com
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());
    const serialized = JSON.stringify(observed);

    expect(observed.relationships[0]).toMatchObject({ from: "service", to: "remote-service" });
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("github_pat_abcdefghijkl");
    expect(serialized).not.toContain("member@example.com");
    expect(serialized).toContain("[REDACTED]");
  });

  it("tracks aliased and namespace client bindings", async () => {
    await writeSources(repository, {
      "service/src/postgres.ts": `import { Pool as PgPool } from "pg";
const database = new PgPool({ connectionString: "postgres://postgres:5432/orders" });
export async function read(): Promise<void> { await database.query("select 1"); }
`,
      "service/src/cache.ts": `import * as redis from "redis";
const cache = redis.createClient({ url: "redis://redis:6379" });
export async function write(): Promise<void> { await cache.hSet("orders", "1", "ok"); }
`,
      "service/src/events.ts": `import * as amqp from "amqplib";
const eventsUrl = "amqp://order-events:5672";
export async function publish(): Promise<void> {
  const connection = await amqp.connect(eventsUrl);
  const channel = await connection.createChannel();
  channel.sendToQueue("orders", Buffer.from("{}"));
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships.map(({ from, type, to }) => `${from}|${type}|${to}`)).toEqual([
      "service|async|order-events",
      "service|data|postgres",
      "service|data|redis",
    ]);
  });

  it("does not treat unrelated query, cache or publish methods as infrastructure access", async () => {
    await writeSources(repository, {
      "service/src/lookalikes.ts": `import { Client } from "pg";
import { createClient } from "redis";
import { connect } from "amqplib";

const fakeDatabase = new CustomClient({ connectionString: "postgres://postgres:5432/orders" });
const localCache = { get: async (_key: string) => "value" };
const logger = { publish: (_message: string) => undefined };

export async function run(): Promise<void> {
  await fakeDatabase.query("select 1");
  await localCache.get("key");
  logger.publish("amqp://order-events:5672");
  void Client;
  void createClient;
  void connect;
}

declare class CustomClient {
  constructor(options: { connectionString: string });
  query(statement: string): Promise<void>;
}
`,
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());

    expect(observed.relationships).toEqual([]);
  });

  it("covers default, namespace and side-effect imports plus defensive endpoint syntax", async () => {
    await writeSources(repository, {
      "api-gateway/src/main.tsx": `import defaultPg from "pg";
import * as pgNamespace from "pg";
import defaultRedis from "redis";
import defaultAmqp from "amqplib";
import "pg";
import ignored from "node:fs";

const [destructured] = ["value"];
let unset;
const suffix = "v1";
const config = { connectionString: "postgres://ignored:5432/db" };
const spreadConfig = { url: "redis://ignored:6379" };
const noOptions = new defaultPg.Client;
const ignoredDatabase = new defaultPg.Client(config);
const database = new pgNamespace.Pool({ connectionString: "postgresql://secure-postgres:5432/db" });
const ignoredCache = defaultRedis.createClient(spreadConfig);
const spreadCache = defaultRedis.createClient({ ...spreadConfig });
const cache = defaultRedis.createClient({ url: process.env.REDIS_URL });
const connection = defaultAmqp.connect("amqps://secure-events:5671");
const channel = connection.createChannel();

export async function exercise(): Promise<void> {
  await fetch("not a URL");
  await fetch("file:///tmp/no-host");
  await fetch(process.env.UNRELATED);
  await fetch("http://binary-left:3000" + suffix);
  await fetch(\`https://template-service/\${suffix}\`);
  await database.query("select 1");
  await cache.get("key");
  channel.publish("events", "created", Buffer.from("{}"));
  factory().query("select 1");
  factory().get("key");
  factory().publish("event");
  void destructured;
  void unset;
  void noOptions;
  void ignoredDatabase;
  void ignoredCache;
  void spreadCache;
  void ignored;
}

declare function factory(): { query(value: string): void; get(value: string): void; publish(value: string): void };
`,
      "api-gateway/src/index.ts": "export const index = true;\n",
      "api-gateway/src/helper.ts": "export const helper = true;\n",
      "empty-service/src/empty.ts": "",
      "root.ts": "export const root = true;\n",
    });

    const observed = await analyzeTypeScriptRepository(repository, testArchitecture());
    const edges = observed.relationships.map(({ from, type, to }) => `${from}|${type}|${to}`);

    expect(observed.components["api-gateway"]?.component).toMatchObject({ type: "gateway", layer: "edge" });
    expect(observed.metadata.scanned_files).toBe(5);
    expect(edges).toEqual(expect.arrayContaining([
      "api-gateway|http|binary-left",
      "api-gateway|http|template-service",
      "api-gateway|data|secure-postgres",
      "api-gateway|data|redis",
      "api-gateway|async|secure-events",
    ]));
    expect(edges).not.toContain("api-gateway|http|unrelated");
  });
});
