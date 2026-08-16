import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "archsync-install-e2e-"));
const packages = join(temporary, "packages");
const globalDirectory = join(temporary, "global");
const binDirectory = join(temporary, "bin");
const externalProject = join(temporary, "external-project");
const pnpmCli = process.env.npm_execpath;
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
  assert.equal(packResult.version, "0.3.1");
  const packedFiles = packResult.files.map(({ path }) => path);
  assert.ok(packedFiles.includes("package.json"));
  assert.ok(packedFiles.includes("README.md"));
  assert.ok(packedFiles.includes("dist/bin.js"));
  assert.ok(packedFiles.includes("dist/provenance.json"));
  assert.ok(packedFiles.includes("dist/version.js"));
  assert.equal(
    packedFiles.every((path) => path === "package.json" || path === "README.md" || path.startsWith("dist/")),
    true,
    `Unexpected package files: ${packedFiles.join(", ")}`,
  );

  const guardianTarball = join(packages, packResult.filename);
  const coreTarball = join(root, "vendor", "archsync-core-0.1.0.tgz");
  const installEnvironment = {
    ...process.env,
    PNPM_HOME: binDirectory,
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
  };
  runPnpm([
    "add",
    "--global",
    `--global-dir=${globalDirectory}`,
    `--global-bin-dir=${binDirectory}`,
    coreTarball,
    guardianTarball,
  ], { env: installEnvironment });

  await copyFile(join(root, "test", "fixtures", "architecture.yaml"), join(externalProject, "architecture.yaml"));

  const version = JSON.parse(runInstalled(["version", "--json"], installEnvironment).stdout);
  assert.equal(version.cli.package, "@archsync/guardian");
  assert.equal(version.cli.version, packResult.version);
  assert.equal(version.provenance.mode, "package");
  assert.equal(version.provenance.integrity, "verified");
  assert.match(version.provenance.source_commit, /^[0-9a-f]{40}$/);
  assert.match(version.provenance.package_content_sha256, /^[0-9a-f]{64}$/);

  const doctor = JSON.parse(runInstalled(["doctor", "--json"], installEnvironment).stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find(({ name }) => name === "CLI on PATH")?.status, "PASS");

  const validation = runInstalled(["model", "validate", "architecture.yaml"], installEnvironment);
  assert.match(validation.stdout, /RESULT: VALID/);
  assert.match(validation.stdout, /SUMMARY: 4 components, 3 relationships/);

  const installedManifest = JSON.parse(await readFile(
    join(globalDirectory, "5", "node_modules", "@archsync", "guardian", "package.json"),
    "utf8",
  ).catch(async () => {
    const candidates = await readdir(globalDirectory, { recursive: true });
    const manifest = candidates.find((path) => path.replaceAll("\\", "/").endsWith("node_modules/@archsync/guardian/package.json"));
    assert.ok(manifest, "Installed Guardian package.json was not found");
    return readFile(join(globalDirectory, manifest), "utf8");
  }));
  assert.deepEqual(installedManifest.files, ["dist", "README.md"]);

  console.log(
    `PASS CLEAN PACKAGE INSTALL (${process.platform}: packed whitelist, isolated pnpm prefix, PATH, ` +
    "version provenance, doctor and external-project model validation)",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
