import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArchitectureDocument } from "@archsync/core";

export function testArchitecture(): ArchitectureDocument {
  return {
    version: "0.1.1",
    metadata: { name: "guardian-test" },
    components: {
      frontend: { name: "Frontend", type: "frontend", layer: "experience" },
      gateway: { name: "Gateway", type: "gateway", layer: "edge" },
      service: { name: "Service", type: "service", layer: "domain" },
      postgres: { name: "Postgres", type: "database", layer: "data" },
    },
    relationships: [
      { from: "frontend", to: "gateway", type: "http" },
      { from: "gateway", to: "service", type: "http" },
      { from: "service", to: "postgres", type: "data" },
    ],
    rules: [
      { id: "ARCH-001", type: "deny", from: "frontend", to: "postgres", relationship_type: "data", severity: "critical" },
      { id: "ARCH-002", type: "require", from: "gateway", to: "service", relationship_type: "http", severity: "error" },
    ],
  };
}

export const baselineSources: Record<string, string> = {
  "frontend/src/app.ts": `const gatewayUrl = process.env.GATEWAY_URL ?? "http://gateway:3000";
export async function submit(): Promise<void> {
  await fetch(\`${"${gatewayUrl}"}/orders\`);
}
`,
  "gateway/src/server.ts": `const serviceUrl = process.env.SERVICE_URL ?? "http://service:3001";
export async function forward(): Promise<void> {
  await fetch(\`${"${serviceUrl}"}/orders\`);
}
`,
  "service/src/service.ts": `import { Client } from "pg";
const database = new Client({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:5432/app" });
export async function save(value: unknown): Promise<void> {
  await database.query("insert into items(payload) values ($1)", [value]);
}
`,
};

export async function writeSources(
  root: string,
  sources: Record<string, string>,
): Promise<void> {
  for (const [file, source] of Object.entries(sources)) {
    const path = join(root, ...file.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
  }
}
