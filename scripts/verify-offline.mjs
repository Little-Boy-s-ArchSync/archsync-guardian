import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "src");
const forbidden = new Set([
  "node:dgram", "node:dns", "node:http", "node:http2", "node:https",
  "node:net", "node:tls", "node:quic",
]);

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  }))).flat();
}

const violations = [];
for (const path of await files(sourceRoot)) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)) {
    if (forbidden.has(match[1])) violations.push(`${relative(root, path)} imports ${match[1]}`);
  }
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.deepEqual(
  Object.keys(manifest.dependencies).sort(),
  ["@archsync/core", "typescript", "yaml"],
  "production dependency allowlist changed; review outbound/offline behavior explicitly",
);
assert.deepEqual(violations, [], `runtime network modules are forbidden by default:\n${violations.join("\n")}`);
console.log("PASS OFFLINE CONTRACT (no runtime network modules; production dependencies allowlisted)");
