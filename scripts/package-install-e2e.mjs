import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "archsync-install-e2e-"));
const packages = join(temporary, "packages");
const globalDirectory = join(temporary, "global");
const binDirectory = join(temporary, "bin");
const externalProject = join(temporary, "external-project");
const pnpmCli = process.env.npm_execpath;
const sourceManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const evidenceOption = process.argv.indexOf("--evidence");
const evidencePath = evidenceOption >= 0 && process.argv[evidenceOption + 1]
  ? resolve(root, process.argv[evidenceOption + 1])
  : undefined;
const pnpmCommand = pnpmCli
  ? { command: process.execPath, prefix: [pnpmCli] }
  : { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", prefix: [] };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, [
    `Command failed: ${command} ${args.join(" ")}`,
    result.stdout,
    result.stderr,
    result.error?.message,
  ].filter(Boolean).join("\n"));
  return result;
}

function runPnpm(args, options = {}) {
  return run(pnpmCommand.command, [...pnpmCommand.prefix, ...args], options);
}

function parsePackResult(stdout) {
  const start = stdout.lastIndexOf("\n{");
  const json = start >= 0 ? stdout.slice(start + 1) : stdout;
  return JSON.parse(json);
}

function runInstalled(args, environment) {
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "archsync", ...args], {
      cwd: externalProject,
      env: environment,
    });
  }
  return run("archsync", args, { cwd: externalProject, env: environment });
}

try {
  await Promise.all([
    mkdir(packages, { recursive: true }),
    mkdir(globalDirectory, { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
    mkdir(externalProject, { recursive: true }),
  ]);
  const pack = runPnpm(["pack", "--json", "--pack-destination", packages]);
  const packResult = parsePackResult(pack.stdout);
  assert.equal(packResult.name, "@archsync/guardian");
  assert.equal(packResult.version, sourceManifest.version);
  const packedFiles = packResult.files.map(({ path }) => path);
  assert.ok(packedFiles.includes("package.json"));
  assert.ok(packedFiles.includes("README.md"));
  assert.ok(packedFiles.includes("dist/bin.js"));
  assert.ok(packedFiles.includes("dist/provenance.json"));
  assert.ok(packedFiles.includes("dist/version.js"));
  assert.ok(packedFiles.includes("specs/explanation.schema.json"));
  assert.ok(packedFiles.includes("specs/repair-candidate.schema.json"));
  assert.ok(packedFiles.includes("node_modules/@archsync/core/package.json"));
  assert.ok(packedFiles.includes("node_modules/yaml/bin.mjs"));
  const allowedBundleRoots = new Set([
    "@archsync/core",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
    "yaml",
  ]);
  const bundledRoots = new Set(packedFiles.filter((path) => path.startsWith("node_modules/")).map((path) => {
    const parts = path.split("/");
    return parts[1].startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1];
  }));
  assert.deepEqual(bundledRoots, allowedBundleRoots);
  assert.equal(
    packedFiles.every((path) =>
      path === "package.json" || path === "README.md" || path.startsWith("dist/") || path.startsWith("specs/") ||
      path.startsWith("node_modules/"),
    ),
    true,
    `Unexpected package files: ${packedFiles.join(", ")}`,
  );

  const guardianTarball = isAbsolute(packResult.filename)
    ? packResult.filename
    : join(packages, packResult.filename);
  const installEnvironment = {
    ...process.env,
    // pnpm may expose shims from PNPM_HOME/bin (not PNPM_HOME itself),
    // particularly in a configured Windows user environment.
    PNPM_HOME: temporary,
    // pnpm dlx otherwise shares a process-external cache. Concurrent verification
    // worktrees can race while populating the same entry, so every package test
    // gets an isolated cache on Unix and Windows.
    XDG_CACHE_HOME: join(temporary, "cache"),
    LOCALAPPDATA: join(temporary, "local-app-data"),
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
  };
  const installation = runPnpm([
    "add",
    "--global",
    `--global-dir=${globalDirectory}`,
    `--global-bin-dir=${binDirectory}`,
    guardianTarball,
  ], { env: installEnvironment });
  assert.doesNotMatch(`${installation.stdout}\n${installation.stderr}`, /Failed to create bin/);

  await copyFile(join(root, "test", "fixtures", "architecture.yaml"), join(externalProject, "architecture.yaml"));
  await cp(join(root, "test", "fixtures"), join(externalProject, "benchmark"), { recursive: true });

  const version = JSON.parse(runInstalled(["version", "--json"], installEnvironment).stdout);
  assert.equal(version.cli.package, "@archsync/guardian");
  assert.equal(version.cli.version, packResult.version);
  assert.equal(version.contracts.core_model, "0.1.1");
  assert.equal(version.contracts.core_model_previous, "0.1.0");
  assert.equal(version.contracts.core_cli_json, "1.0.0");
  assert.equal(version.contracts.guardian_result, "0.1");
  assert.equal(
    version.dependencies.core.source_commit,
    "503b5fe97aa39a78d5e5de80b794a94508e106cc",
  );
  assert.equal(
    version.dependencies.core.vendored_sha256,
    "7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9",
  );
  assert.equal(version.provenance.mode, "package");
  assert.equal(version.provenance.integrity, "verified");
  assert.match(version.provenance.source_commit, /^[0-9a-f]{40}$/);
  assert.match(version.provenance.package_content_sha256, /^[0-9a-f]{64}$/);

  const doctor = JSON.parse(runInstalled(["doctor", "--json"], installEnvironment).stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find(({ name }) => name === "CLI on PATH")?.status, "PASS");
  assert.equal(doctor.checks.find(({ name }) => name === "PNPM_HOME / PATH")?.status, "PASS");

  const validation = runInstalled(["model", "validate", "architecture.yaml"], installEnvironment);
  assert.match(validation.stdout, /RESULT: VALID/);
  assert.match(validation.stdout, /SUMMARY: 4 components, 3 relationships/);
  const graph = JSON.parse(runInstalled(["model", "graph", "architecture.yaml"], installEnvironment).stdout);
  assert.equal(graph.schema_version, "1.0.0");
  assert.equal(graph.kind, "archsync.graph");
  assert.deepEqual(graph.contracts, { architecture_model: "0.1.1", graph: "1.0.0" });

  const demo = JSON.parse(runInstalled([
    "demo",
    "--benchmark",
    "benchmark",
    "--scenario",
    "all",
    "--json",
  ], installEnvironment).stdout);
  assert.equal(demo.ok, true);
  assert.deepEqual(demo.cases.map(({ actual_decision }) => actual_decision), ["PASS", "BLOCK", "REVIEW"]);
  assert.equal(demo.cases.every(({ match }) => match), true);

  const fallbackResult = runPnpm([
    "dlx",
    "--package",
    guardianTarball,
    "archsync",
    "version",
    "--json",
  ], { cwd: externalProject, env: installEnvironment });
  assert.doesNotMatch(`${fallbackResult.stdout}\n${fallbackResult.stderr}`, /Failed to create bin/);
  const fallback = JSON.parse(fallbackResult.stdout);
  assert.equal(fallback.provenance.integrity, "verified");
  assert.equal(fallback.provenance.source_commit, version.provenance.source_commit);

  const installedManifest = JSON.parse(await readFile(
    join(globalDirectory, "5", "node_modules", "@archsync", "guardian", "package.json"),
    "utf8",
  ).catch(async () => {
    const candidates = await readdir(globalDirectory, { recursive: true });
    const manifest = candidates.find((path) => path.replaceAll("\\", "/").endsWith("node_modules/@archsync/guardian/package.json"));
    assert.ok(manifest, "Installed Guardian package.json was not found");
    return readFile(join(globalDirectory, manifest), "utf8");
  }));
  assert.deepEqual(installedManifest.files, ["dist", "specs", "README.md"]);

  if (evidencePath) {
    const pnpmVersion = runPnpm(["--version"]).stdout.trim();
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify({
      schema_version: 1,
      platform: process.platform,
      architecture: process.arch,
      node_version: process.versions.node,
      pnpm_version: pnpmVersion,
      package: version.cli,
      provenance: version.provenance,
      checks: [
        "package-file-allowlist",
        "bundled-core-runtime",
        "bundled-cli-entrypoints",
        "warning-free-install",
        "isolated-global-prefix",
        "binary-on-path",
        "version-provenance",
        "exact-core-dependency-provenance",
        "core-cli-json-envelope",
        "doctor",
        "external-project-model-validation",
        "installed-pass-block-review-demo",
        "no-global-dlx-fallback",
      ],
    }, null, 2)}\n`, "utf8");
  }

  console.log(
    `PASS CLEAN PACKAGE INSTALL (${process.platform}: packed whitelist, isolated pnpm prefix, PATH, ` +
    "version provenance, doctor, external-project validation, demo, dlx fallback and evidence)",
  );
} finally {
  if (process.env.ARCHSYNC_KEEP_TEST_TEMP === "1") {
    console.error(`KEPT TEST DIRECTORY ${temporary}`);
  } else {
    await rm(temporary, { recursive: true, force: true });
  }
}
