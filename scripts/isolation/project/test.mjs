import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { add } from './lib/add.mjs';
import net from 'node:net';

test('transferred project executes the exact nested source', () => {
  assert.equal(add(19, 23), process.env.ARCHSYNC_PROBE_MODE === 'workspace-failure' ? -1 : 42);
});
test('project-created symlinks never lead to host files or a host recheck', async () => {
  const target = process.env.ARCHSYNC_PROBE_CANARY;
  await symlink(target, 'generated-link');
  await assert.rejects(readFile('generated-link'));
  await assert.rejects(writeFile('generated-link', 'forbidden'));
  await writeFile('generated-result.txt', 'container-owned output remains in the container');
});
test('socket denial remains enforced in the spawned project test process', async () => {
  const server = net.createServer();
  await assert.rejects(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => server.close(resolve));
  }), (error) => ['EPERM', 'EACCES'].includes(error.code));
});
