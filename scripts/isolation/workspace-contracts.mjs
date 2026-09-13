import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createSnapshot, validateSnapshot, snapshotLimits } from './workspace-snapshot.mjs';
import { networkProfile, networkProfileSha256, upstreamProfile, validateNetworkSecurityOptions } from './network-policy.mjs';

const file = (path, content = 'sample bytes\n') => ({ path, bytes: Buffer.from(content) });
const clone = (object) => JSON.parse(JSON.stringify(object));

test('snapshot binds exact explicit file bytes, paths, ordering and binary contents', () => {
  const inputs = [file('test.mjs'), file('lib/source.mjs', '\0\xff\n'), file('package.json', '{}')];
  const packet = createSnapshot(inputs);
  const identity = validateSnapshot(packet);
  assert.deepEqual(identity, validateSnapshot(createSnapshot([...inputs].reverse())));
  assert.equal(identity.file_count, 3);
  assert.equal(identity.total_bytes, inputs.reduce((n, f) => n + f.bytes.length, 0));
  assert.equal(identity.sha256, createHash('sha256').update(JSON.stringify(packet)).digest('hex'));
  inputs[0].bytes.fill(0);
  assert.deepEqual(validateSnapshot(packet), identity, 'later source-buffer mutation cannot change the packet');
});

test('snapshot refuses traversal, aliases, credentials, links and alternate file types before transfer', () => {
  for (const path of ['/absolute', '../escape', 'a/../escape', 'a/./b', 'a//b', 'a/', 'C:/x', 'a\\b', 'a\0b', '.git/config', '.GIT/config', 'a/.env.local', '.npmrc', '.ssh/id', 'a/.aws/config', '.docker/config.json', 'file.', 'aux.txt']) {
    assert.throws(() => createSnapshot([file(path)]), path);
  }
  for (const patch of [{ type: 'symlink' }, { mode: '120000' }, { linkname: '/etc/passwd' }, { type: 'fifo' }]) {
    assert.throws(() => createSnapshot([{ ...file('source'), ...patch }]));
    const packet = createSnapshot([file('source')]); Object.assign(packet.files[0], patch);
    assert.throws(() => validateSnapshot(packet));
  }
});

test('duplicate, case-colliding and file/directory snapshots fail closed', () => {
  for (const paths of [['a', 'a'], ['a', 'A'], ['a', 'a/b'], ['a/b', 'A'], ['A/b', 'a']]) {
    assert.throws(() => createSnapshot(paths.map((path) => file(path))), paths.join(','));
  }
});

test('changed digests, bytes, lengths, encoding and unexpected packet metadata are rejected', () => {
  const base = createSnapshot([file('source')]);
  for (const patch of [{ sha256: '0'.repeat(64) }, { size: 0 }, { base64: Buffer.from('tampered').toString('base64') }, { base64: base.files[0].base64 + '\n' }, { base64: 123 }]) {
    const packet = clone(base); Object.assign(packet.files[0], patch);
    assert.throws(() => validateSnapshot(packet));
  }
  for (const patch of [{ command: 'arbitrary shell' }, { schema_version: 'APPROVED' }, { files: [] }, { files: 'source' }]) assert.throws(() => validateSnapshot({ ...base, ...patch }));
});

test('snapshot count, per-file bytes, total bytes and path depth are bounded', () => {
  assert.throws(() => createSnapshot(Array.from({ length: snapshotLimits.files + 1 }, (_, i) => file('file-' + i))));
  assert.throws(() => createSnapshot([{ path: 'large', bytes: Buffer.alloc(snapshotLimits.fileBytes + 1) }]));
  assert.throws(() => createSnapshot(Array.from({ length: 9 }, (_, i) => ({ path: 'file-' + i, bytes: Buffer.alloc(snapshotLimits.fileBytes) }))));
  assert.throws(() => createSnapshot([file('a/'.repeat(17) + 'b')]));
  assert.throws(() => createSnapshot([file('a'.repeat(241))]));
});

test('restricted network profile preserves pinned upstream controls and removes socket access', async () => {
  const bytes = await readFile(new URL('vendor/moby-default-seccomp.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), upstreamProfile.sha256);
  const upstream = JSON.parse(bytes), derived = networkProfile();
  const { syscalls: originalRules, ...originalPolicy } = upstream;
  const { syscalls: derivedRules, ...derivedPolicy } = derived;
  assert.deepEqual(derivedPolicy, originalPolicy);
  assert.equal(derived.defaultAction, 'SCMP_ACT_ERRNO');
  const socketpair = derivedRules.filter((rule) => rule.names.includes('socketpair'));
  assert.deepEqual(socketpair, [{ names: ['socketpair'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 1, op: 'SCMP_CMP_EQ' }] }]);
  assert.ok(originalRules.some((rule) => rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes('socketpair') && !rule.args));
  const denied = ['socket', 'socketcall', 'connect', 'bind', 'listen', 'accept', 'accept4', 'io_uring_setup', 'io_uring_enter', 'io_uring_register'];
  for (const rule of derivedRules) {
    assert.ok(!rule.names.some((name) => denied.includes(name)));
    if (rule === socketpair[0]) continue;
    assert.ok(originalRules.some((original) => {
      const { names, ...rest } = original;
      return rule.names.every((name) => names.includes(name)) && JSON.stringify({ ...rest }) === JSON.stringify(Object.fromEntries(Object.entries(rule).filter(([key]) => key !== 'names')));
    }), 'a derived rule must only remove names from an existing upstream rule');
  }
  assert.equal(createHash('sha256').update(JSON.stringify(derived)).digest('hex'), networkProfileSha256);
});

test('container inspection refuses absent, changed or unconfined seccomp before execution', () => {
  const expected = ['no-new-privileges:true', 'seccomp=' + JSON.stringify(networkProfile())];
  validateNetworkSecurityOptions(expected);
  const weak = networkProfile(); weak.syscalls.push({ names: ['socket'], action: 'SCMP_ACT_ALLOW' });
  for (const options of [[], ['no-new-privileges:true'], ['no-new-privileges:true', 'seccomp=unconfined'], ['no-new-privileges:true', 'seccomp=' + JSON.stringify(weak)], [...expected, 'label=disable']]) assert.throws(() => validateNetworkSecurityOptions(options));
});
