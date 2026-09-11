// Authored offline probe only. This file is hashed before being sent to stdin;
// there is no caller-supplied source, project path, command, mount or image.
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, mkdir, lstat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
const mode = process.env.ARCHSYNC_PROBE_MODE;
const emit = (value) => console.log(JSON.stringify(value));
assert.equal(process.version, 'v22.16.0');
assert.equal(process.getuid(), 1000);
assert.equal(process.env.ARCHSYNC_HOST_CANARY_SECRET, undefined);
await mkdir('/workspace/.npm', { recursive: true });
if (mode === 'success' || mode === 'failure') {
  await writeFile('/workspace/package.json', JSON.stringify({ private: true, scripts: { test: 'node check.cjs' } }));
  await writeFile('/workspace/check.cjs', mode === 'success' ? 'process.exit(0)\n' : 'process.exit(23)\n');
  const command = spawnSync('/usr/local/bin/npm', ['test', '--offline', '--ignore-scripts=false'], { cwd: '/workspace', stdio: 'pipe', timeout: 5000 });
  const exit = checkedFixtureExit(command);
  emit({ mode, npm_test_exit: exit, host_environment_absent: true });
  // npm standardizes the failed lifecycle result; preserve its actual exit.
  process.exit(exit);
} else if (mode === 'filesystem') {
  const canary = process.env.ARCHSYNC_PROBE_CANARY;
  const kernel = await readFile('/proc/self/status', 'utf8');
  const field = (name) => kernel.match(new RegExp('^' + name + ':\\s+(\\S+)', 'm'))?.[1];
  assert.equal(field('NoNewPrivs'), '1'); assert.equal(field('Seccomp'), '2');
  assert.equal(field('CapEff'), '0000000000000000'); assert.equal(field('CapBnd'), '0000000000000000');
  await writeFile('/workspace/result.txt', 'workspace-owned');
  assert.equal(await readFile('/workspace/result.txt', 'utf8'), 'workspace-owned');
  await symlink(canary, '/workspace/escape');
  for (const path of [canary, '/workspace/../' + canary.slice(1), '/workspace/escape', '/proc/1/root' + canary]) {
    await assert.rejects(readFile(path));
    await assert.rejects(writeFile(path, 'forbidden'));
  }
  await assert.rejects(writeFile('/rootfs-write-probe', 'forbidden'));
  // /tmp is writable to this UID in the image. EROFS therefore measures the
  // read-only root mount rather than merely Unix permissions on root's '/'.
  assert.equal((await lstat('/tmp')).mode & 0o777, 0o777);
  await assert.rejects(writeFile('/tmp/archsync-authored-rootfs-probe', 'forbidden', { flag: 'wx' }), (error) => error.code === 'EROFS');
  await assert.rejects(readFile('/var/run/docker.sock'));
  emit({ mode, workspace_write: true, host_canary_unreachable: true, root_write_denied: true, world_writable_tmp_rejected_with_erofs: true, docker_socket_absent: true, no_new_privileges: field('NoNewPrivs'), seccomp_mode: field('Seccomp'), effective_capabilities: field('CapEff'), bounding_capabilities: field('CapBnd') });
  console.log('token=' + process.env.ARCHSYNC_PROBE_SYNTHETIC_SECRET);
} else if (mode === 'network') {
  const tcp = (host) => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(process.env.ARCHSYNC_PROBE_PORT) });
    socket.setTimeout(700, () => { socket.destroy(); resolve('TIMEOUT'); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('unexpected external TCP connection')); });
    socket.once('error', (error) => { socket.destroy(); resolve(error.code); });
  });
  const udp = (type, host) => new Promise((resolve, reject) => {
    const socket = dgram.createSocket(type);
    const timer = setTimeout(() => { socket.close(); resolve('TIMEOUT'); }, 700);
    socket.once('error', (error) => { clearTimeout(timer); socket.close(); resolve(error.code); });
    socket.send('AUTHORED_EGRESS_PROBE', Number(process.env.ARCHSYNC_PROBE_PORT), host, (error) => {
      if (error) { clearTimeout(timer); socket.close(); resolve(error.code); }
      else { clearTimeout(timer); socket.close(); reject(new Error('unexpected external UDP send')); }
    });
  });
  // Documentation-only address ranges: no external service is targeted.
  const tcp4 = await tcp('192.0.2.1');
  const tcp6 = await tcp('2001:db8::1');
  const udp4 = await udp('udp4', '192.0.2.1');
  const udp6 = await udp('udp6', '2001:db8::1');
  const host_listener = await tcp(process.env.ARCHSYNC_PROBE_HOST_GATEWAY);
  const resolver = new Resolver({ timeout: 500, tries: 1 });
  resolver.setServers(['192.0.2.1']);
  let dns;
  try { await resolver.resolve4('authored-probe.invalid'); throw new Error('unexpected DNS response'); }
  catch (error) { assert.ok(error.code); dns = error.code; }
  // Report the limitation explicitly: network=none does NOT disable loopback.
  const server = net.createServer((socket) => socket.end('loopback'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
    socket.on('data', () => {}); socket.once('end', resolve); socket.once('error', reject);
  });
  await new Promise((resolve) => server.close(resolve));
  emit({ mode, tcp4, tcp6, udp4, udp6, dns, host_listener, loopback_available: true, production_network_contract_satisfied: false });
} else if (['timeout', 'cancel'].includes(mode)) {
  const child = spawn(process.execPath, ['-e', "console.log('DESCENDANT_STARTED'); setTimeout(() => console.log('LATE_DESCENDANT_MARKER'), 1500); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  child.unref();
  emit({ mode, descendant_requested: true });
  setInterval(() => {}, 1000);
} else if (mode === 'stdout-overflow' || mode === 'stderr-overflow') {
  const stream = mode === 'stdout-overflow' ? process.stdout : process.stderr;
  const flood = () => { while (stream.write('X'.repeat(8192))) {} stream.once('drain', flood); };
  flood();
} else { throw new Error('Unrecognized fixed probe mode'); }
