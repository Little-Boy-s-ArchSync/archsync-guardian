import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPackageProvenance } from "../dist/version.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "provenance.json");
const operation = process.argv[2];

if (operation === "write") {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "."], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (status.status !== 0 || status.stdout.trim()) {
    throw new Error("refusing to package a dirty tracked source tree");
  }
  const sourceCommit = process.env.ARCHSYNC_SOURCE_COMMIT;
  const provenance = await createPackageProvenance(root, sourceCommit || undefined);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  console.log(`WROTE package provenance ${provenance.source_commit.slice(0, 12)}`);
} else if (operation === "clean") {
  await rm(output, { force: true });
} else {
  console.error("Usage: node scripts/package-provenance.mjs write|clean");
  process.exitCode = 2;
}
