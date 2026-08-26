import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function gitStatus() {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
assert.ok(command.length > 0, "usage: node scripts/verify-clean-worktree.mjs -- <command> [args...]");

const before = gitStatus();
const result = spawnSync(command[0], command.slice(1), {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, ARCHSYNC_OFFLINE: "1" },
  // Package-manager launchers are .cmd shims on Windows and require cmd.exe.
  shell: process.platform === "win32",
  stdio: "inherit",
  windowsHide: true,
});
assert.equal(result.status, 0, result.error?.message ?? `${command.join(" ")} failed with status ${result.status}`);
const after = gitStatus();
assert.equal(after, before, "verification/demo changed the worktree; generated output must stay in temp or ignored paths");
console.log("PASS CLEAN WORKTREE CONTRACT");
