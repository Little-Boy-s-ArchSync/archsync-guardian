import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const portable = value => value.replaceAll('\\', '/');
export function writeJSON(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export function inventory(root, excluded = new Set(['node_modules', 'receipts'])) {
  const files = [];
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ file: portable(relative(root, path)), sha256: hash(readFileSync(path)) });
      else throw new Error(`Unsupported inventory entry: ${path}`);
    }
  }
  walk(root);
  return files;
}
export function capture(folder, id, executable, args, cwd, timeout = 120000) {
  const prefix = resolve(folder, id);
  const started_utc = new Date().toISOString();
  const result = spawnSync(executable, args, { cwd, timeout, windowsHide: true, shell: false, maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  writeFileSync(prefix + '.stdout.txt', stdout, { flag: 'wx' });
  writeFileSync(prefix + '.stderr.txt', stderr, { flag: 'wx' });
  const receipt = {
    executable, args, cwd: portable(cwd), started_utc, ended_utc: new Date().toISOString(),
    exit_code: result.status, signal: result.signal, timeout: result.error?.code === 'ETIMEDOUT',
    launch_error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: { file: id + '.stdout.txt', sha256: hash(stdout), bytes: stdout.length },
    stderr: { file: id + '.stderr.txt', sha256: hash(stderr), bytes: stderr.length },
  };
  writeJSON(prefix + '.invocation.json', receipt);
  return { ...receipt, stdout_text: stdout.toString('utf8'), stderr_text: stderr.toString('utf8') };
}
export function newReceiptFolder(root, phase) {
  const folder = join(root, 'receipts', `${new Date().toISOString().replaceAll(':','-')}-${phase}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}
