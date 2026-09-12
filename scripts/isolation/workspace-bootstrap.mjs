// Appended after the shared snapshot validator and a base64-encoded packet.
// This code executes only inside the freshly inspected container.
import { mkdir as snapshotMkdir, open as snapshotOpen, readFile as snapshotRead } from 'node:fs/promises';
import { constants as snapshotFlags } from 'node:fs';
import { spawnSync as snapshotSpawn } from 'node:child_process';
const snapshotIdentity = validateSnapshot(snapshotPacket);
snapshotAssert.equal(process.getuid(), 1000);
await snapshotMkdir('/workspace/project', { mode: 0o700 });
const snapshotDirectories = new Set();
for (const file of snapshotPacket.files) {
  const parts = file.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const path = parts.slice(0, i).join('/');
    if (!snapshotDirectories.has(path)) {
      await snapshotMkdir('/workspace/project/' + path, { mode: 0o700 });
      snapshotDirectories.add(path);
    }
  }
  const handle = await snapshotOpen('/workspace/project/' + file.path, snapshotFlags.O_WRONLY | snapshotFlags.O_CREAT | snapshotFlags.O_EXCL | snapshotFlags.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    snapshotAssert.ok(stat.isFile() && stat.nlink === 1);
    await handle.writeFile(Buffer.from(file.base64, 'base64'));
  } finally { await handle.close(); }
}
// Bind the fully materialized bytes before executing any project-controlled code.
for (const file of snapshotPacket.files) snapshotAssert.equal(snapshotDigest(await snapshotRead('/workspace/project/' + file.path)), file.sha256);
console.log(JSON.stringify({ stage: 'WORKSPACE_BOUND', ...snapshotIdentity }));
const snapshotResult = snapshotSpawn('/usr/local/bin/npm', ['test', '--offline', '--ignore-scripts=true'], {
  cwd: '/workspace/project', stdio: ['ignore', 'inherit', 'inherit'], timeout: 5000,
});
process.exit(checkedFixtureExit(snapshotResult));
