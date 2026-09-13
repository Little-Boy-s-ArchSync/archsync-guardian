import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { posix } from 'node:path';

import { collectGitSnapshot } from './workspace-git.mjs';
import { createSnapshot, snapshotLimits, validateSnapshot } from './workspace-snapshot.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...expected].sort(), 'unexpected repaired snapshot fields');
  for (const key of expected) assert.ok(Object.getOwnPropertyDescriptor(value, key)?.value !== undefined, 'plain data fields required');
};
const hash = (value) => assert.match(value, /^[0-9a-f]{64}$/u, 'canonical SHA-256 required');

function request(options, byteReplacements) {
  keys(options, byteReplacements ? ['repository', 'commit', 'allowlist', 'replacements'] : ['repository', 'workspace', 'commit', 'allowlist', 'replacements']);
  assert.equal(typeof options.repository, 'string');
  assert.ok(options.repository.length > 0);
  assert.match(options.commit, /^[0-9a-f]{40}$/u, 'full canonical base commit required');
  assert.ok(Array.isArray(options.allowlist) && options.allowlist.length > 0 && options.allowlist.length <= snapshotLimits.files);
  // Validate the complete request before Git or host file I/O. This also rejects
  // sparse arrays, duplicate/case aliases, prefix collisions and control paths.
  const allowlist = Array.from(options.allowlist);
  createSnapshot(allowlist.map((path) => ({ path, bytes: Buffer.alloc(0) })));
  const allow = new Set(allowlist);
  assert.ok(Array.isArray(options.replacements) && options.replacements.length > 0 && options.replacements.length <= allowlist.length);
  let total = 0;
  const replacements = Array.from(options.replacements, (replacement) => {
    keys(replacement, byteReplacements ? ['path', 'baseSha256', 'bytes'] : ['path', 'baseSha256', 'sha256']);
    const path = replacement.path;
    assert.ok(allow.has(path), 'replacement is not allowlisted');
    hash(replacement.baseSha256);
    if (!byteReplacements) {
      hash(replacement.sha256);
      return { path, baseSha256: replacement.baseSha256, sha256: replacement.sha256 };
    }
    assert.ok(Buffer.isBuffer(replacement.bytes) && !(replacement.bytes.buffer instanceof SharedArrayBuffer), 'owned Buffer bytes required');
    assert.ok(replacement.bytes.length <= snapshotLimits.fileBytes, 'repaired file too large');
    total += replacement.bytes.length;
    assert.ok(total <= snapshotLimits.totalBytes, 'repair bytes exceed total limit');
    // Copy synchronously before the first await: caller edits cannot alter the
    // replacement between validation, Git collection and packet creation.
    return { path, baseSha256: replacement.baseSha256, bytes: Buffer.from(replacement.bytes) };
  });
  assert.equal(new Set(replacements.map(({ path }) => path)).size, replacements.length, 'duplicate replacement');
  replacements.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { repository: options.repository, commit: options.commit, allowlist, replacements };
}

function bind(base, replacements, collection) {
  const files = new Map(base.snapshot.files.map((file) => [file.path, Buffer.from(file.base64, 'base64')]));
  const changes = replacements.map(({ path, baseSha256, bytes }) => {
    assert.equal(digest(files.get(path)), baseSha256, 'replacement base digest mismatch');
    const repairedSha256 = digest(bytes);
    assert.notEqual(repairedSha256, baseSha256, 'replacement must change the base bytes');
    files.set(path, bytes);
    return { path, base_object: base.objects[path].object, base_mode: base.objects[path].mode, base_sha256: baseSha256, repaired_sha256: repairedSha256, size: bytes.length };
  });
  const snapshot = createSnapshot([...files].map(([path, bytes]) => ({ path, bytes })));
  const binding = {
    schema_version: '1.0.0-unapproved', status: 'UNAPPROVED', production_capability: 'NOT_ISSUED',
    source_commit: base.sourceCommit, base_snapshot: validateSnapshot(base.snapshot),
    source_objects: base.objects, repaired_snapshot: validateSnapshot(snapshot), changes, collection,
  };
  return { snapshot, binding, bindingSha256: digest(Buffer.from(JSON.stringify(binding))) };
}

// Portable integration point for an editor/repair runner that owns the bytes.
// No repaired host file is opened, and the Git index/working tree are not changed.
export async function collectRepairedSnapshot(options) {
  const input = request(options, true);
  const base = await collectGitSnapshot(input);
  return bind(base, input.replacements, { kind: 'CALLER_OWNED_BYTES', live_workspace_read: false });
}

const statIdentity = (stat) => Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, stat[key].toString()]));
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const fdPath = (fd, name) => `/proc/self/fd/${fd}/${name}`;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function captureLinuxWorkspace(workspace, expected) {
  const descriptors = [];
  const links = [];
  const directories = new Map();
  const identities = new Set();
  const observations = [];
  const files = [];
  let total = 0;
  const openDirectory = (parent, name) => {
    const fd = openSync(parent === null ? '/' : fdPath(parent, name), directoryFlags);
    descriptors.push(fd);
    const stat = fstatSync(fd, { bigint: true });
    assert.ok(stat.isDirectory(), 'workspace component must be a directory');
    if (parent !== null) links.push({ parent, name, stat });
    return { fd, stat };
  };
  const validateLinks = () => {
    for (const { parent, name, stat } of links) {
      const current = lstatSync(fdPath(parent, name), { bigint: true });
      assert.ok(current.isDirectory() && sameInode(current, stat), 'workspace directory identity changed');
    }
  };
  try {
    let root = openDirectory(null);
    for (const part of workspace.split('/').slice(1)) root = openDirectory(root.fd, part);
    directories.set('', root);
    for (const item of expected) {
      const parts = item.path.split('/');
      let parent = root;
      for (let index = 0; index < parts.length - 1; index++) {
        const prefix = parts.slice(0, index + 1).join('/');
        let directory = directories.get(prefix);
        if (!directory) {
          assert.ok(directories.size < 256, 'too many workspace directories');
          directory = openDirectory(parent.fd, parts[index]);
          assert.equal(directory.stat.dev, root.stat.dev, 'workspace mount crossing refused');
          directories.set(prefix, directory);
        }
        parent = directory;
      }
      validateLinks();
      const leaf = parts.at(-1);
      // Nonblocking prevents FIFOs from hanging before fstat can reject them.
      // Only the trusted /proc/self/fd prefix is followed; each user component
      // is a single O_NOFOLLOW open relative to a held directory descriptor.
      const fd = openSync(fdPath(parent.fd, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      descriptors.push(fd);
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile() && before.nlink === 1n, 'single-link regular workspace file required');
      assert.equal((before.mode & 0o111n) !== 0n, item.mode === '100755', 'workspace executable mode changed');
      assert.equal(before.mode & 0o7000n, 0n, 'special permission bits refused');
      assert.equal(before.dev, root.stat.dev, 'workspace mount crossing refused');
      const inode = `${before.dev}:${before.ino}`;
      assert.ok(!identities.has(inode), 'workspace file alias refused');
      identities.add(inode);
      assert.ok(before.size <= BigInt(snapshotLimits.fileBytes), 'repaired file too large');
      total += Number(before.size);
      assert.ok(total <= snapshotLimits.totalBytes, 'workspace total limit exceeded');
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        length += count;
      }
      assert.equal(length, Number(before.size), 'workspace file changed length');
      const bytes = buffer.subarray(0, length);
      assert.equal(digest(bytes), item.sha256, 'unexpected workspace bytes');
      assert.deepEqual(statIdentity(fstatSync(fd, { bigint: true })), statIdentity(before), 'workspace file changed during read');
      const current = lstatSync(fdPath(parent.fd, leaf), { bigint: true });
      assert.deepEqual(statIdentity(current), statIdentity(before), 'workspace file identity changed');
      validateLinks();
      files.push({ path: item.path, bytes });
      observations.push({ path: item.path, identity: statIdentity(before), sha256: item.sha256, fd, parent: parent.fd, leaf });
    }
    // Retain file descriptors until every input has been read and checked.
    for (const observation of observations) {
      assert.deepEqual(statIdentity(fstatSync(observation.fd, { bigint: true })), observation.identity, 'workspace file changed after read');
      assert.deepEqual(statIdentity(lstatSync(fdPath(observation.parent, observation.leaf), { bigint: true })), observation.identity, 'workspace file identity changed after read');
    }
    validateLinks();
    return { files, rootIdentity: { dev: root.stat.dev.toString(), ino: root.stat.ino.toString() }, observations: observations.map(({ path, identity, sha256 }) => ({ path, identity, sha256 })) };
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

// Linux only: Node exposes no portable openat/dirfd equivalent. Refusing other
// hosts is preferable to a check-then-open traversal through mutable parents.
export async function collectRepairedWorkspaceSnapshot(options) {
  const input = request(options, false);
  const workspace = options.workspace;
  assert.equal(typeof workspace, 'string');
  assert.ok(workspace.startsWith('/') && workspace !== '/' && workspace.length <= 4096 && workspace.split('/').length <= 33 && !workspace.includes('\0') && posix.normalize(workspace) === workspace && !workspace.endsWith('/'), 'canonical absolute workspace path required');
  assert.equal(process.platform, 'linux', 'live workspace collection requires Linux descriptor-relative opens; use collectRepairedSnapshot with owned bytes on this host');
  assert.ok(constants.O_NOFOLLOW && constants.O_DIRECTORY && constants.O_NONBLOCK, 'required open flags unavailable');
  const base = await collectGitSnapshot(input);
  const changes = new Map(input.replacements.map((replacement) => [replacement.path, replacement]));
  // Validate trusted expected base hashes before opening the live workspace.
  for (const replacement of input.replacements) {
    assert.equal(base.snapshot.files.find((file) => file.path === replacement.path).sha256, replacement.baseSha256, 'replacement base digest mismatch');
    assert.notEqual(replacement.sha256, replacement.baseSha256, 'replacement must change the base bytes');
  }
  const expected = base.snapshot.files.map(({ path, sha256 }) => ({ path, sha256: changes.get(path)?.sha256 ?? sha256, mode: base.objects[path].mode }));
  const captured = captureLinuxWorkspace(workspace, expected);
  const replacementBytes = captured.files.filter(({ path }) => changes.has(path)).map(({ path, bytes }) => ({ ...changes.get(path), bytes }));
  return bind(base, replacementBytes, {
    kind: 'LINUX_DESCRIPTOR_RELATIVE_WORKSPACE', live_workspace_read: true,
    root_identity: captured.rootIdentity, observed_files: captured.observations,
    consistency: 'EXPECTED_DIGEST_BOUND_COPY_WITH_OBSERVED_IDENTITY_CHECKS; not an atomic filesystem snapshot or a lock against future edits',
  });
}
