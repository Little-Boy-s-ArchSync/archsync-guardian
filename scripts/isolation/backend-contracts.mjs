import test from 'node:test';
import { checkedFixtureExit } from './fixture-command.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modes, hash, imagePin, labelKey, validatePolicy, validateEndpoint, validateEngine, validateImage, containerEnvironment, createArguments, validateContainer, validateOwnership, execute, classifyExecution, dockerClient, cleanupOwnedContainer } from './backend.mjs';
const policy = JSON.parse(await readFile(new URL('policy.json', import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url)));
const runId = 'a'.repeat(32), name = 'archsync-unapproved-' + runId, cid = 'b'.repeat(64);
const engine = { ID: 'authored-daemon-id', OSType: 'linux', Architecture: 'aarch64', CgroupVersion: '2', SecurityOptions: ['name=seccomp,profile=builtin'], MemoryLimit: true, SwapLimit: true, PidsLimit: true, CPUSet: true, CpuCfsQuota: true, CpuCfsPeriod: true };
const image = { Os: 'linux', Architecture: 'arm64', RepoDigests: [imagePin], Id: 'sha256:' + 'c'.repeat(64), Config: { Env: ['NODE_VERSION=22.16.0', 'PATH=/image/path'], Volumes: null } };
const environment = containerEnvironment('success', { canary: '/tmp/authored/canary', hostAddress: '192.168.1.10', port: 23456, syntheticSecret: 'd'.repeat(48) });
const result = (stdout = '', exit_code = 0, stderr = '') => ({ stdout, stderr, exit_code, reason: null });
function container() {
  return { Id: cid, Name: '/' + name, Image: image.Id, State: { Status: 'created', Running: false, Pid: 0 }, Mounts: [], NetworkSettings: { Networks: { none: {} } },
    Config: { Image: policy.image, Entrypoint: ['/usr/local/bin/node'], Cmd: ['--input-type=module', '-'], User: policy.user, WorkingDir: '/workspace', OpenStdin: true, Tty: false,
      Labels: { [labelKey]: runId }, Env: ['NODE_VERSION=22.16.0', ...Object.entries(environment).map(([k, v]) => `${k}=${v}`)], Volumes: null, ExposedPorts: null },
    HostConfig: { NetworkMode: 'none', Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges:true'], CgroupnsMode: 'private', IpcMode: 'none', PidMode: '', UTSMode: '', UsernsMode: '', Memory: policy.memory_bytes, MemorySwap: policy.memory_bytes, NanoCpus: policy.nano_cpus, PidsLimit: policy.pids_limit,
      Tmpfs: { '/workspace': policy.tmpfs }, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, LogConfig: { Type: 'local', Config: { 'max-file': '1', 'max-size': '64k', compress: 'false' } }, PublishAllPorts: false } };
}

test('normal verification binds the checked-in fixed fixture and policy bytes', async () => {
  validatePolicy(policy); assert.equal(manifest.status, 'UNAPPROVED');
  assert.deepEqual(Object.keys(manifest.files), ['policy.json', 'fixture-command.mjs', 'fixture.mjs']);
  for (const [path, digest] of Object.entries(manifest.files)) assert.equal(hash(await readFile(new URL(path, import.meta.url))), digest);

});

test('policy changes cannot silently enable privilege, a moving image, mounts or production capability', () => {
  for (const patch of [{ status: 'APPROVED' }, { image: 'node:latest' }, { user: '0:0' }, { host_mounts: 'WORKSPACE' }, { production_capability: 'ISSUED' }, { memory_bytes: 0 }, { fixture_timeout_ms: Infinity }, { privileged: true }]) {
    assert.throws(() => validatePolicy({ ...policy, ...patch }));
  }
});

test('daemon endpoints reject network transports, malformed Unix paths and traversal', () => {
  validateEndpoint('unix:///var/run/docker.sock'); validateEndpoint('unix:///tmp/owned directory/docker.sock');
  for (const value of ['tcp://localhost:2375', 'ssh://host', 'npipe:////./pipe/docker_engine', 'unix://relative', 'unix:///tmp/../docker.sock', 'unix:///tmp//docker.sock', 'unix:///tmp/docker.sock\0', null]) assert.throws(() => validateEndpoint(value));
});

test('engine and exact image validation fail before any fixture is run', () => {
  validateEngine(engine); validateImage(image, engine);
  for (const patch of [{ OSType: 'windows' }, { Architecture: 'mips' }, { CgroupVersion: '1' }, { SecurityOptions: ['name=seccomp,profile=unconfined'] }, { ID: '' }, { MemoryLimit: false }, { SwapLimit: false }, { PidsLimit: false }, { CPUSet: false }, { CpuCfsQuota: false }]) assert.throws(() => validateEngine({ ...engine, ...patch }));
  for (const patch of [{ RepoDigests: [] }, { Os: 'windows' }, { Architecture: 'amd64' }, { Id: 'short' }, { Config: { Volumes: { '/workspace': {} } } }]) assert.throws(() => validateImage({ ...image, ...patch }, engine));
});

test('Docker invocation is fixed, uses no host mount/port/privilege and preserves no host environment', async () => {
  const args = createArguments(name, runId, environment, policy);
  for (const value of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--entrypoint=/usr/local/bin/node']) assert.ok(args.includes(value));
  for (const value of ['--mount', '--volume', '--privileged', '--publish', '--pid=host', '--network=host']) assert.ok(!args.includes(value));
  let invocation;
  const client = dockerClient('unix:///var/run/docker.sock', '/tmp/owned-config', { PATH: '/usr/bin', SECRET_TOKEN: 'secret', DOCKER_HOST: 'tcp://bad:2375', HOME: '/home/real' }, async (...values) => { invocation = values; return result(); });
  await client(['info']);
  assert.deepEqual(invocation[1], ['--config', '/tmp/owned-config', '--host', 'unix:///var/run/docker.sock', 'info']);
  assert.deepEqual(invocation[2].environment, { PATH: '/usr/bin', HOME: '/tmp/owned-config' });
  assert.throws(() => containerEnvironment('free-form', {}));
  assert.throws(() => createArguments('unowned-name', runId, environment, policy));
});

test('stopped-container validation rejects actual privilege and mount drift before start', () => {
  assert.equal(validateContainer(container(), name, runId, environment, image, policy).host_mounts, 0);
  const changes = [
    (v) => v.HostConfig.Privileged = true, (v) => v.HostConfig.ReadonlyRootfs = false,
    (v) => v.HostConfig.NetworkMode = 'host', (v) => v.HostConfig.Binds = ['/:/host'],
    (v) => v.HostConfig.Mounts = [{ Source: '/var/run/docker.sock' }], (v) => v.Mounts = [{ Type: 'volume' }],
    (v) => v.HostConfig.CapAdd = ['SYS_ADMIN'], (v) => v.HostConfig.CapDrop = [],
    (v) => v.HostConfig.SecurityOpt = ['seccomp=unconfined'], (v) => v.HostConfig.PidMode = 'host',
    (v) => v.HostConfig.IpcMode = 'host', (v) => v.HostConfig.CgroupnsMode = 'host',
    (v) => v.HostConfig.Memory = 0, (v) => v.HostConfig.MemorySwap = -1, (v) => v.HostConfig.NanoCpus = 0,
    (v) => v.HostConfig.PidsLimit = -1, (v) => v.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }],
    (v) => v.Config.Env.push('HOST_SECRET=leaked'), (v) => v.Config.User = '0:0',
    (v) => v.Config.Cmd = ['-e', 'free-form code'], (v) => v.Config.Entrypoint = ['/bin/sh'],
    (v) => v.Config.ExposedPorts = { '80/tcp': {} }, (v) => v.Config.Volumes = { '/data': {} },
    (v) => v.HostConfig.RestartPolicy.Name = 'always', (v) => v.State.Running = true,
    (v) => v.HostConfig.Tmpfs['/tmp'] = 'rw', (v) => v.Image = 'sha256:' + 'f'.repeat(64),
  ];
  for (const change of changes) { const value = container(); change(value); assert.throws(() => validateContainer(value, name, runId, environment, image, policy)); }
  assert.throws(() => validateOwnership({ ...container(), Name: '/other-container' }, name, runId));
});

test('zero, real fixture failure and Docker/client infrastructure statuses remain distinct', () => {
  assert.equal(classifyExecution(result()), 'FIXTURE_PASSED'); assert.equal(classifyExecution(result('', 23)), 'FIXTURE_FAILED');
  for (const code of [125, 126, 127, null]) assert.equal(classifyExecution(result('', code)), 'INCONCLUSIVE');
  for (const reason of ['TIMED_OUT', 'OUTPUT_LIMIT', 'CANCELLED', 'CLIENT_ERROR']) assert.equal(classifyExecution({ ...result(), reason }), 'INCONCLUSIVE');
});

test('real controller subprocess output, deadline and cancellation are bounded', async () => {
  const regular = await execute(process.execPath, ['-e', 'process.exit(23)'], { timeoutMs: 3000 }); assert.equal(regular.exit_code, 23);
  for (const stream of ['stdout', 'stderr']) {
    const over = await execute(process.execPath, ['-e', `process.${stream}.write('X'.repeat(10000))`], { maximumBytes: 128, timeoutMs: 3000 });
    assert.equal(over.reason, 'OUTPUT_LIMIT'); assert.ok(Buffer.byteLength(over[stream]) <= 128);
  }
  const slow = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150 }); assert.equal(slow.reason, 'TIMED_OUT');
  const controller = new AbortController(); setTimeout(() => controller.abort(), 150);
  const cancelled = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 3000, signal: controller.signal }); assert.equal(cancelled.reason, 'CANCELLED');
  const missing = await execute('archsync-authored-missing-executable', [], { timeoutMs: 3000 }); assert.equal(missing.reason, 'CLIENT_ERROR');
});

function cleanupClient({ ownership = true, late = false, marker = true, removeFails = false, daemonFails = false } = {}) {
  const calls = []; let inspections = 0;
  const client = async (args) => {
    calls.push(args);
    if (args[1] === 'inspect') {
      if (daemonFails) return result('', 1, 'Cannot connect to the Docker daemon');
      inspections++;
      if (inspections >= 3) return result('', 1, `Error response from daemon: No such container: ${name}\n`);
      const value = container(); value.State.Running = inspections === 1; value.State.Pid = inspections === 1 ? 123 : 0;
      if (!ownership) value.Config.Labels[labelKey] = 'someone-else';
      return result(JSON.stringify(value));
    }
    if (args[1] === 'logs') return result((marker ? 'DESCENDANT_STARTED\n' : '') + (late ? 'LATE_DESCENDANT_MARKER\n' : ''));
    if (args[1] === 'rm' && removeFails) return result('', 1, 'remove failed');
    return result();
  };
  return { calls, client };
}

test('timeout cleanup kills the owned container and descendants, observes no late marker, removes and verifies absence', async () => {
  const { client, calls } = cleanupClient();
  const outcome = await cleanupOwnedContainer(client, name, runId, { observeDescendant: true, observationMs: 0 });
  assert.equal(outcome.status, 'REMOVED'); assert.equal(outcome.stopped, true); assert.equal(outcome.post_termination_no_late_marker, true);
  assert.ok(calls.some((a) => a[1] === 'kill' && a[3] === cid)); assert.ok(calls.some((a) => a[1] === 'rm' && a[3] === cid));
  assert.ok(calls.some((a) => a[1] === 'ls' && a.at(-1) === `label=${labelKey}=${runId}`));
});

test('cleanup never deletes an unowned container or treats daemon errors as absence', async () => {
  for (const options of [{ ownership: false }, { daemonFails: true }]) {
    const { client, calls } = cleanupClient(options); const outcome = await cleanupOwnedContainer(client, name, runId);
    assert.equal(outcome.status, 'INCONCLUSIVE'); assert.ok(!calls.some((a) => ['kill', 'rm'].includes(a[1])));
  }
});

test('missing/late descendant evidence and failed removal remain inconclusive', async () => {
  for (const options of [{ late: true }, { marker: false }, { removeFails: true }]) {
    const { client, calls } = cleanupClient(options);
    const outcome = await cleanupOwnedContainer(client, name, runId, { observeDescendant: true, observationMs: 0 });
    assert.equal(outcome.status, 'INCONCLUSIVE'); assert.ok(calls.some((a) => a[1] === 'rm'));
  }
});

test('authored npm timeout, signal and spawn error never become a passing fixture', () => {
  assert.equal(checkedFixtureExit({ status: 0, signal: null }), 0);
  assert.equal(checkedFixtureExit({ status: 23, signal: null }), 23);
  for (const result of [null, { status: null }, { status: null, signal: 'SIGTERM' }, { status: 0, error: { code: 'ETIMEDOUT' } }, { status: 0, signal: 'SIGKILL' }, { status: -1 }, { status: 256 }]) assert.equal(checkedFixtureExit(result), 125);
});

test('a failed later inspect still attempts narrow cleanup of a previously verified immutable CID', async () => {
  const calls = [];
  const client = async (args) => { calls.push(args); return args[1] === 'inspect' ? result('', 1, 'Cannot connect to daemon') : result(); };
  const outcome = await cleanupOwnedContainer(client, name, runId, { knownOwnedId: cid });
  assert.equal(outcome.status, 'INCONCLUSIVE');
  assert.ok(calls.some((args) => args[1] === 'rm' && args[3] === cid));
  assert.ok(!calls.some((args) => args.includes('--all') && args[1] === 'rm'));
});
