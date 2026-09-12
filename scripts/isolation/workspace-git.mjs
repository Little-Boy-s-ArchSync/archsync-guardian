import assert from 'node:assert/strict';
import { execFile as execFileWithCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { createSnapshot, snapshotLimits } from './workspace-snapshot.mjs';

const execFile = promisify(execFileWithCallback);
const maxGitOutput = Math.max(4 * 1024 * 1024, snapshotLimits.packetBytes * 2);
const gitCommandTimeoutMs = 7_500;
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const isGitEnvVariable = (key) => key.slice(0, 4).toUpperCase() === 'GIT_';
const safeGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isGitEnvVariable(key))); // keep process env for runtime availability, only remove inherited git controls.
Object.assign(safeGitEnvironment, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: nullDevice,
  GIT_CONFIG_GLOBAL: nullDevice,
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_PROTOCOL: '0',
});
const maxTreeBytes = Math.max(4 * 1024 * 1024, maxGitOutput);
const gitDirCache = new Map();

function getGitDir(cwd) {
  let gitDir = gitDirCache.get(cwd);
  if (!gitDir) {
    gitDir = (async () => {
      const resolved = await execFile('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: gitCommandTimeoutMs,
        env: safeGitEnvironment,
      });
      return resolved.stdout.trim();
    })();
    gitDirCache.set(cwd, gitDir);
  }
  return gitDir;
}

function gitOutput(cwd, args, { encoding = 'utf8', maxBuffer = maxGitOutput } = {}) {
  return getGitDir(cwd).then((gitDir) => execFile('git', ['-C', cwd, `--git-dir=${gitDir}`, `--work-tree=${cwd}`, '--no-replace-objects', '--no-optional-locks', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice}`, ...args], {
    encoding,
    windowsHide: true,
    maxBuffer,
    timeout: gitCommandTimeoutMs,
    env: safeGitEnvironment,
  }).then((result) => result.stdout));
}

const reservedPathSegment = /^(?:\.git|\.env|\.ssh|\.aws|\.azure|\.config|\.npm|\.yarn|\.pnpm|\.docker|\.netrc|\.pypirc|\.archsync|\.artifacts|coverage$)/iu;
const platformReservedPathSegment = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu;

function validateSnapshotPath(path) {
  assert.match(path, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u, 'unsafe snapshot path');
  assert.equal(path.length <= 240, true, 'snapshot path too long');
  assert.equal(path.split('/').length <= 16, true, 'snapshot path depth exceeds limit');
  const parts = path.split('/');
  for (const part of parts) {
    assert.ok(!['.', '..'].includes(part), 'ambiguous path segment');
    assert.ok(!part.endsWith('.'), 'ambiguous path segment');
    assert.ok(!reservedPathSegment.test(part), 'reserved or credential path');
    assert.ok(!platformReservedPathSegment.test(part), 'platform-reserved path');
  }
}

function hashObject(type, bytes) {
  const header = `${type} ${bytes.length}\0`;
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function parseTreeEntries(rawTree) {
  const entries = [];
  const names = Object.create(null);
  let cursor = 0;
  while (cursor < rawTree.length) {
    const space = rawTree.indexOf(0x20, cursor);
    assert.ok(space > cursor, 'malformed tree entry');
    const nul = rawTree.indexOf(0x00, space + 1);
    assert.ok(nul > space, 'malformed tree entry');
    const mode = rawTree.slice(cursor, space).toString('ascii');
    const name = rawTree.slice(space + 1, nul).toString('utf8');
    assert.ok(!Object.hasOwn(names, name), `duplicate tree entry name: ${name}`);
    names[name] = true;
    const objectStart = nul + 1;
    const objectEnd = objectStart + 20;
    assert.ok(objectEnd <= rawTree.length, 'malformed tree object');
    const object = rawTree.slice(objectStart, objectEnd).toString('hex');
    assert.match(object, /^[0-9a-f]{40}$/u);
    entries.push({ mode, name, object });
    cursor = objectEnd;
  }
  assert.equal(cursor, rawTree.length);
  return entries;
}

function parseCommitTree(rawCommit) {
  const content = rawCommit.toString('utf8');
  const match = content.match(/^tree ([0-9a-f]{40})\n/iu);
  assert.ok(match, 'malformed commit object');
  return match[1];
}

async function readObject(repository, oid, type, { maxBuffer } = {}) {
  const raw = await gitOutput(repository, ['cat-file', type, oid], { encoding: 'buffer', maxBuffer });
  assert.equal(hashObject(type, raw), oid, `${type} object hash mismatch for ${oid}`);
  return raw;
}

async function readObjectSize(repository, oid) {
  const size = await gitOutput(repository, ['cat-file', '-s', oid], { encoding: 'utf8' });
  const parsed = Number.parseInt(size, 10);
  assert.ok(Number.isInteger(parsed), 'malformed object size');
  assert.ok(parsed >= 0);
  return parsed;
}

async function resolveCommittedBlob(repository, rootTree, path, verifiedTrees) {
  const segments = path.split('/');
  let currentTree = rootTree;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLeaf = index === segments.length - 1;
    let entries = verifiedTrees.get(currentTree);
    if (!entries) {
      const treeSize = await readObjectSize(repository, currentTree);
      assert.ok(treeSize <= maxTreeBytes, 'committed tree is too large');
      const rawTree = await readObject(repository, currentTree, 'tree', { maxBuffer: Math.max(treeSize + 1024, 64 * 1024) });
      entries = parseTreeEntries(rawTree);
      verifiedTrees.set(currentTree, entries);
    }
    const found = entries.find((entry) => entry.name === segment);
    assert.ok(found, `path ${path} missing from committed snapshot`);
    if (isLeaf) {
      assert.ok(found.mode === '100644' || found.mode === '100755', `path resolves to non-regular blob: ${path}`);
      return found;
    }
    assert.equal(found.mode, '40000', `path has non-tree segment: ${path}`);
    currentTree = found.object;
  }
  throw new Error('unreachable');
}

export async function collectGitSnapshot({ repository, commit, allowlist, paths = allowlist }) {
  assert.equal(typeof repository, 'string');
  assert.equal(typeof commit, 'string');
  assert.ok(Array.isArray(allowlist) && allowlist.length > 0);
  assert.ok(Array.isArray(paths) && paths.length > 0);
  const committed = commit.toLowerCase().trim();
  assert.match(committed, /^[0-9a-f]{40}$/u, 'malformed commit identifier');
  const commitType = (await gitOutput(repository, ['cat-file', '-t', committed], { encoding: 'utf8' })).trim();
  assert.equal(commitType, 'commit', 'commit reference not a commit object');
  const commitObject = await readObject(repository, committed, 'commit', { maxBuffer: Math.max(maxGitOutput, 64 * 1024) });
  const rootTree = parseCommitTree(commitObject);
  const allow = new Set(allowlist);
  for (const path of paths) {
    validateSnapshotPath(path);
    assert.ok(allow.has(path), `path ${path} is not allowlisted`);
  }
  assert.ok(paths.length <= snapshotLimits.files, 'too many requested files');
  const normalizedPaths = [...new Set(paths)].sort();
  const files = Object.create(null);
  const objects = Object.create(null);
  const entries = [];
  const verifiedTrees = new Map();
  let totalBytes = 0;
  for (const path of normalizedPaths) {
    const selected = await resolveCommittedBlob(repository, rootTree, path, verifiedTrees);
    const size = await readObjectSize(repository, selected.object);
    assert.ok(size <= snapshotLimits.fileBytes, 'committed file is too large');
    totalBytes += size;
    assert.ok(totalBytes <= snapshotLimits.totalBytes);
    const blob = await readObject(repository, selected.object, 'blob', { maxBuffer: Math.max(size + 1024, 64 * 1024) });
    assert.equal(blob.length, size, 'snapshot blob changed between lookup and read');
    entries.push({ path, bytes: blob });
    files[path] = blob;
    objects[path] = { object: selected.object, mode: selected.mode, size };
  }
  const snapshot = createSnapshot(entries);
  return { sourceCommit: committed, snapshot, files, objects };
}
