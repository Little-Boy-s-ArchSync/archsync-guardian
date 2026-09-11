import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, lstat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, networkInterfaces, platform, release } from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { sanitizeVerificationLog } from '../dist/index.js';
import { modes, hash, validatePolicy, discoverEndpoint, validateEngine, validateImage, containerEnvironment, createArguments, validateContainer, dockerClient, checked, classifyExecution, cleanupOwnedContainer } from './isolation/backend.mjs';

assert.equal(process.argv.length, 2, 'This authored probe accepts no project, command or configuration arguments');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const started = new Date().toISOString();
const manifestBytes = await readFile(join(root, 'scripts/isolation/manifest.json'));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifestBytes.toString(), JSON.stringify(manifest, null, 2) + '\n', 'noncanonical fixture manifest');
assert.deepEqual(Object.keys(manifest), ['schema_version', 'status', 'files']);
assert.equal(manifest.schema_version, '1.0.0-unapproved'); assert.equal(manifest.status, 'UNAPPROVED');
assert.deepEqual(Object.keys(manifest.files), ['policy.json', 'fixture-command.mjs', 'fixture.mjs']);
const inputs = {};
for (const [name, digest] of Object.entries(manifest.files)) {
  const path = join(root, 'scripts/isolation', name);
  assert.ok((await lstat(path)).isFile(), 'authored input must be a regular non-symlink file');
  const bytes = await readFile(path); assert.equal(hash(bytes), digest, `authored input ${name} differs from manifest`); inputs[name] = bytes;
}
const policy = JSON.parse(inputs['policy.json']); validatePolicy(policy);
const fixturePayload = Buffer.concat([inputs['fixture-command.mjs'], Buffer.from('\n'), inputs['fixture.mjs']]);
const temporary = await mkdtemp(join(tmpdir(), 'archsync-unapproved-isolation-'));
const configDirectory = join(temporary, 'docker-config'); await mkdir(configDirectory, { mode: 0o700 });
const canary = join(temporary, 'host-canary.txt'); const hostSecret = randomBytes(24).toString('hex');
await writeFile(canary, hostSecret, { mode: 0o600, flag: 'wx' });
const fixtureSecret = randomBytes(24).toString('hex');
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
let listenerHits = 0;
const sockets = new Set();
const listener = net.createServer((socket) => { listenerHits++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.end('authored-canary'); });
const udpListener = dgram.createSocket('udp4'); udpListener.on('message', () => listenerHits++);
const rows = [];
const scrub = (value) => sanitizeVerificationLog(value, temporary, [hostSecret, fixtureSecret], policy.maximum_output_bytes);
let passed = true, infrastructureError = null, environment;
const report = {
  schema_version: '1.0.0-unapproved', status: 'UNAPPROVED', production_capability: 'NOT_ISSUED',
  arbitrary_project_execution: false, host_mounts: 0, network_scope: policy.network_scope,
  loopback_exception: 'Docker network none retains container loopback; the production no-network contract is not satisfied.',
  started_at_utc: started, policy_sha256: hash(inputs['policy.json']), fixture_sha256: hash(fixturePayload), manifest_sha256: hash(manifestBytes),
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source_dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  source_files: {}, host: { platform: platform(), release: release(), node: process.version }, cases: rows,
};
for (const path of ['scripts/isolation/backend.mjs', 'scripts/isolation/backend-contracts.mjs', 'scripts/probe-repair-isolation.mjs', 'package.json', 'docs/repair-isolation-candidate.md']) report.source_files[path] = hash(await readFile(join(root, path)));
try {
  const endpoint = await discoverEndpoint();
  const client = dockerClient(endpoint, configDirectory, { ...process.env, ARCHSYNC_HOST_CANARY_SECRET: hostSecret });
  report.endpoint_sha256 = hash(endpoint);
  const info = JSON.parse(checked(await client(['info', '--format', '{{json .}}']), 'engine preflight')); validateEngine(info);
  report.engine = { version: info.ServerVersion, os: info.OSType, architecture: info.Architecture, cgroup_version: info.CgroupVersion, security_options: info.SecurityOptions, identity_sha256: hash(info.ID) };
  const image = JSON.parse(checked(await client(['image', 'inspect', policy.image, '--format', '{{json .}}']), 'pinned image preflight')); validateImage(image, info);
  report.image = { pin: policy.image, id: image.Id, architecture: image.Architecture, os: image.Os };
  const hostAddress = Object.values(networkInterfaces()).flat().find((item) => item && item.family === 'IPv4' && !item.internal)?.address;
  assert.ok(hostAddress, 'no host IPv4 interface for the authored listener control');
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '0.0.0.0', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => { udpListener.once('error', reject); udpListener.bind(port, '0.0.0.0', resolve); });
  // Positive listener controls prove the canaries were live; their connections
  // are counted separately from the subsequent isolated fixture attempts.
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostAddress, port });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('host listener positive control timed out')); });
    socket.on('data', () => {}); socket.once('end', resolve); socket.once('error', reject);
  });
  const listenerBaseline = listenerHits; assert.ok(listenerBaseline > 0);
  report.host_listener_positive_control = true;
  for (const mode of modes) {
    if (abort.signal.aborted) { passed = false; infrastructureError = 'harness interrupted'; break; }
    const runId = randomBytes(16).toString('hex'), name = `archsync-unapproved-${runId}`;
    environment = containerEnvironment(mode, { canary, port, hostAddress, syntheticSecret: fixtureSecret });
    const row = { mode, container_name: name, status: 'INCONCLUSIVE', started_at_utc: new Date().toISOString() }; rows.push(row);
    const cancel = new AbortController(); let cancelTimer;
    let startedContainer = false, createUncertain = false, knownOwnedId = null;
    try {
      const created = await client(createArguments(name, runId, environment, policy));
      createUncertain = created.reason !== null;
      const id = checked(created, 'create fixed container').trim(); assert.match(id, /^[a-f0-9]{64}$/u);
      const container = JSON.parse(checked(await client(['container', 'inspect', name, '--format', '{{json .}}']), 'pre-start inspection'));
      assert.equal(container.Id, id); row.configuration = validateContainer(container, name, runId, environment, image, policy); knownOwnedId = id;
      const currentInfo = JSON.parse(checked(await client(['info', '--format', '{{json .}}']), 'pre-start daemon identity'));
      validateEngine(currentInfo); assert.equal(currentInfo.ID, info.ID, 'daemon identity changed');
      if (mode === 'cancel') cancelTimer = setTimeout(() => cancel.abort(), policy.termination_timeout_ms);
      startedContainer = true;
      const result = await client(['container', 'start', '--attach', '--interactive', id], {
        input: fixturePayload, maximumBytes: policy.maximum_output_bytes,
        timeoutMs: mode === 'timeout' ? policy.termination_timeout_ms : policy.fixture_timeout_ms,
        signal: AbortSignal.any([abort.signal, cancel.signal]),
      });
      row.status = classifyExecution(result); row.exit_code = result.exit_code; row.termination_reason = result.reason;
      row.stdout = scrub(result.stdout); row.stderr = scrub(result.stderr);
      row.stdout_bytes = Buffer.byteLength(result.stdout); row.stderr_bytes = Buffer.byteLength(result.stderr);
      if (!result.reason && ![125, 126, 127].includes(result.exit_code)) {
        const post = JSON.parse(checked(await client(['container', 'inspect', name, '--format', '{{json .}}']), 'post-execution inspection'));
        assert.equal(post.State.Running, false); assert.equal(post.State.ExitCode, result.exit_code, 'Docker/fixture exit mismatch');
        assert.equal(post.State.OOMKilled, false, 'out-of-memory is infrastructure uncertainty');
        assert.equal(post.State.Error, '', 'container setup/runtime error');
      }
      let expected;
      if (mode === 'failure') expected = row.status === 'FIXTURE_FAILED' && JSON.parse(result.stdout.trim()).npm_test_exit === result.exit_code;
      else if (mode === 'timeout') expected = result.reason === 'TIMED_OUT';
      else if (mode === 'cancel') expected = result.reason === 'CANCELLED';
      else if (mode.endsWith('overflow')) expected = result.reason === 'OUTPUT_LIMIT';
      else expected = row.status === 'FIXTURE_PASSED';
      if (mode === 'success' && expected) assert.equal(JSON.parse(result.stdout.trim()).npm_test_exit, 0, 'authored npm test did not pass');
      if (mode === 'network' && expected) {
        const measurement = JSON.parse(result.stdout.trim());
        const denied = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM']);
        assert.ok(['tcp4', 'tcp6', 'udp4', 'udp6', 'host_listener'].every((key) => denied.has(measurement[key])), 'a timeout/refusal alone is not egress-denial evidence');
        assert.equal(measurement.loopback_available, true); row.measurements = measurement;
      }
      assert.equal(expected, true, `unexpected outcome for ${mode}`);
      row.expected_outcome_observed = true;
    } catch (error) { passed = false; row.status = 'INCONCLUSIVE'; row.error = scrub(error.message); row.expected_outcome_observed = false; }
    finally {
      clearTimeout(cancelTimer);
      row.cleanup = await cleanupOwnedContainer(client, name, runId, {
        observeDescendant: startedContainer && ['timeout', 'cancel'].includes(mode),
        observationMs: policy.post_termination_observation_ms, knownOwnedId, allowAbsent: !startedContainer && !createUncertain,
      });
      if (createUncertain) { row.cleanup.status = 'INCONCLUSIVE'; row.cleanup.reason = 'create client outcome uncertain; delayed daemon creation cannot be excluded'; }
      if (!['REMOVED', 'ABSENT'].includes(row.cleanup.status)) { passed = false; row.status = 'INCONCLUSIVE'; }
      if (row.cleanup.reason) row.cleanup.reason = scrub(row.cleanup.reason);
      row.finished_at_utc = new Date().toISOString();
    }
    assert.equal(await readFile(canary, 'utf8'), hostSecret, 'host canary was modified');
    assert.equal(listenerHits, listenerBaseline, 'isolated fixture reached the host listener');
    if (row.cleanup.status === 'INCONCLUSIVE') break;
  }
  report.host_canary_unchanged = true; report.isolated_host_listener_hits = listenerHits - listenerBaseline;
} catch (error) { passed = false; infrastructureError = scrub(error.message); }
finally {
  for (const socket of sockets) socket.destroy();
  if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  try { udpListener.close(); } catch {}
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  await rm(temporary, { recursive: true, force: true });
}
report.probe_result = passed && rows.length === modes.length ? 'PASS' : 'INCONCLUSIVE';
report.infrastructure_error = infrastructureError; report.finished_at_utc = new Date().toISOString();
report.production_ready = false;
const output = join(root, '.artifacts', 'isolation', started.replaceAll(':', '-') + '-' + randomBytes(4).toString('hex'));
await mkdir(output, { recursive: true });
const serialized = JSON.stringify(report, null, 2) + '\n';
assert.ok(!serialized.includes(hostSecret) && !serialized.includes(fixtureSecret), 'synthetic secret escaped report redaction');
report.synthetic_secret_absent_from_report = true;
await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`UNAPPROVED ISOLATION PROBES ${report.probe_result}: ${rows.filter((row) => row.expected_outcome_observed && row.cleanup.status === 'REMOVED').length}/${modes.length}; no production capability issued`);
console.log(`Evidence: ${join(output, 'result.json')}`);
if (report.probe_result !== 'PASS') process.exitCode = 1;
