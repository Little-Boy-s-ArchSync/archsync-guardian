import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, networkInterfaces, platform, release } from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { sanitizeVerificationLog } from '../dist/index.js';
import { modes, fixtureFiles, hash, validatePolicy, discoverEndpoint, validateEngine, validateImage, containerEnvironment, createArguments, validateContainer, dockerClient, checked, classifyExecution, cleanupOwnedContainer } from './isolation/backend.mjs';
import { networkProfile, networkProfileSha256 } from './isolation/network-policy.mjs';
import { createSnapshot, validateSnapshot } from './isolation/workspace-snapshot.mjs';
import { collectGitSnapshot } from './isolation/workspace-git.mjs';
import { repositoryDirty, repositoryHead } from './isolation/repository-git.mjs';

assert.equal(process.argv.length, 2, 'This authored probe accepts no project, command or configuration arguments');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const started = new Date().toISOString();
const sourceCommit = repositoryHead(root);
const sourcePaths = fixtureFiles.map((path) => `scripts/isolation/${path}`).concat('scripts/isolation/manifest.json');
const collectedInputs = await collectGitSnapshot({ repository: root, commit: sourceCommit, allowlist: sourcePaths });
const manifest = JSON.parse(collectedInputs.files['scripts/isolation/manifest.json']);
assert.equal(collectedInputs.files['scripts/isolation/manifest.json'].toString(), JSON.stringify(manifest, null, 2) + '\n', 'noncanonical fixture manifest');
assert.deepEqual(Object.keys(manifest), ['schema_version', 'status', 'files']);
assert.equal(manifest.schema_version, '1.0.0-unapproved'); assert.equal(manifest.status, 'UNAPPROVED');
assert.deepEqual(Object.keys(manifest.files), fixtureFiles);
for (const [name, digest] of Object.entries(manifest.files)) {
  const bytes = collectedInputs.files[`scripts/isolation/${name}`];
  assert.equal(hash(bytes), digest, `authored input ${name} differs from manifest`);
}
const policy = JSON.parse(collectedInputs.files['scripts/isolation/policy.json']);
validatePolicy(policy);
const fixturePayload = Buffer.concat([collectedInputs.files['scripts/isolation/fixture-command.mjs'], Buffer.from('\n'), collectedInputs.files['scripts/isolation/fixture.mjs']]);
const snapshot = createSnapshot(fixtureFiles.filter((path) => path.startsWith('project/')).map((path) => ({ path: path.slice(8), bytes: collectedInputs.files[`scripts/isolation/${path}`] })));
const snapshotIdentity = validateSnapshot(snapshot);
const workspacePayload = Buffer.concat([
  collectedInputs.files['scripts/isolation/fixture-command.mjs'], Buffer.from('\n'), collectedInputs.files['scripts/isolation/workspace-snapshot.mjs'],
  Buffer.from('\nconst snapshotPacket = JSON.parse(Buffer.from(' + JSON.stringify(Buffer.from(JSON.stringify(snapshot)).toString('base64')) + ', "base64").toString("utf8"));\n'),
  collectedInputs.files['scripts/isolation/workspace-bootstrap.mjs'],
]);
const temporary = await mkdtemp(join(tmpdir(), 'archsync-unapproved-isolation-'));
const configDirectory = join(temporary, 'docker-config'); await mkdir(configDirectory, { mode: 0o700 });
const profilePath = join(temporary, 'seccomp.json');
await writeFile(profilePath, JSON.stringify(networkProfile()), { mode: 0o600, flag: 'wx' });
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
  private_ipc_exception: 'AF_UNIX socketpair is allowed for subprocess stdio; socket, bind, connect and listen are denied, including loopback and named Unix sockets.',
  seccomp_sha256: networkProfileSha256, workspace_snapshot: snapshotIdentity, workspace_payload_sha256: hash(workspacePayload),
  workspace_returned_to_host: false,
  started_at_utc: started, policy_sha256: hash(collectedInputs.files['scripts/isolation/policy.json']), fixture_sha256: hash(fixturePayload), manifest_sha256: hash(collectedInputs.files['scripts/isolation/manifest.json']),
  source_snapshot: { source_commit: collectedInputs.sourceCommit, objects: collectedInputs.objects },
  source_commit: sourceCommit,
  source_dirty: repositoryDirty(root),
  source_files: {}, host: { platform: platform(), release: release(), node: process.version }, cases: rows,
};
for (const path of ['scripts/isolation/backend.mjs', 'scripts/isolation/backend-contracts.mjs', 'scripts/isolation/workspace-contracts.mjs', 'scripts/isolation/workspace-git.mjs', 'scripts/isolation/workspace-git-contracts.mjs', 'scripts/isolation/repository-git.mjs', 'scripts/probe-repair-isolation.mjs', 'package.json', 'docs/repair-isolation-candidate.md', 'docs/phase-4-repair-verification.md', 'docs/phase-4-integration-status.md', 'scripts/isolation/vendor/README.md']) report.source_files[path] = hash(await readFile(join(root, path)));
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
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('host listener positive control timed out')); });
    socket.on('data', () => {}); socket.once('end', resolve); socket.once('error', reject);
  });
  await new Promise((resolve, reject) => {
    const control = dgram.createSocket('udp4');
    const received = () => { clearTimeout(timer); control.close(); resolve(); };
    const timer = setTimeout(() => { udpListener.removeListener('message', received); control.close(); reject(new Error('host UDP positive control timed out')); }, 3000);
    udpListener.once('message', received);
    control.send('AUTHORED_POSITIVE_CONTROL', port, '127.0.0.1', (error) => {
      if (error) { clearTimeout(timer); udpListener.removeListener('message', received); control.close(); reject(error); }
    });
  });
  const listenerBaseline = listenerHits; assert.ok(listenerBaseline >= 2);
  report.host_listener_positive_control = true;
  report.host_listener_positive_control_scope = 'HOST_LOOPBACK_TCP_AND_UDP_ONLY; not proof of Docker-to-host routing. Container socket attempts must independently return EPERM/EACCES.';
  for (const mode of modes) {
    if (abort.signal.aborted) { passed = false; infrastructureError = 'harness interrupted'; break; }
    const runId = randomBytes(16).toString('hex'), name = `archsync-unapproved-${runId}`;
    environment = containerEnvironment(mode, { canary, port, hostAddress, syntheticSecret: fixtureSecret });
    const row = { mode, container_name: name, status: 'INCONCLUSIVE', started_at_utc: new Date().toISOString() }; rows.push(row);
    const cancel = new AbortController(); let cancelTimer;
    let startedContainer = false, createUncertain = false, knownOwnedId = null;
    try {
      const created = await client(createArguments(name, runId, environment, policy, profilePath));
      createUncertain = created.reason !== null;
      const id = checked(created, 'create fixed container').trim(); assert.match(id, /^[a-f0-9]{64}$/u);
      const container = JSON.parse(checked(await client(['container', 'inspect', name, '--format', '{{json .}}']), 'pre-start inspection'));
      assert.equal(container.Id, id); row.configuration = validateContainer(container, name, runId, environment, image, policy); knownOwnedId = id;
      const currentInfo = JSON.parse(checked(await client(['info', '--format', '{{json .}}']), 'pre-start daemon identity'));
      validateEngine(currentInfo); assert.equal(currentInfo.ID, info.ID, 'daemon identity changed');
      if (mode === 'cancel') cancelTimer = setTimeout(() => cancel.abort(), policy.termination_timeout_ms);
      startedContainer = true;
      const result = await client(['container', 'start', '--attach', '--interactive', id], {
        input: mode.startsWith('workspace-') ? workspacePayload : fixturePayload, maximumBytes: policy.maximum_output_bytes,
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
      else if (mode === 'workspace-failure') expected = row.status === 'FIXTURE_FAILED' && result.exit_code === 1;
      else if (mode === 'timeout') expected = result.reason === 'TIMED_OUT';
      else if (mode === 'cancel') expected = result.reason === 'CANCELLED';
      else if (mode.endsWith('overflow')) expected = result.reason === 'OUTPUT_LIMIT';
      else expected = row.status === 'FIXTURE_PASSED';
      if (mode === 'success' && expected) assert.equal(JSON.parse(result.stdout.trim()).npm_test_exit, 0, 'authored npm test did not pass');
      if (mode.startsWith('workspace-')) {
        const binding = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{"stage":"WORKSPACE_BOUND"')) ?? 'null');
        assert.deepEqual(binding, { stage: 'WORKSPACE_BOUND', ...snapshotIdentity }, 'container workspace bytes differ from the transferred snapshot');
        assert.ok(!result.stdout.includes('unexpected pretest lifecycle'));
        assert.match(result.stdout, /^# tests 3$/mu, 'all three authored project tests must actually run');
        assert.match(result.stdout, mode === 'workspace-failure' ? /^# pass 2$/mu : /^# pass 3$/mu);
        assert.match(result.stdout, mode === 'workspace-failure' ? /^# fail 1$/mu : /^# fail 0$/mu);
        if (mode === 'workspace-failure') assert.match(result.stdout, /^not ok 1 - transferred project executes the exact nested source$/mu);
        row.workspace_binding = binding;
      }
      if (mode === 'network' && expected) {
        const measurement = JSON.parse(result.stdout.trim());
        const denied = new Set(['EACCES', 'EPERM']);
        assert.ok(['tcp4', 'tcp6', 'udp4', 'udp6', 'host_listener', 'loopback_tcp4', 'loopback_tcp6', 'loopback_udp4', 'loopback_udp6', 'tcp_listener', 'unix_listener', 'unix_connect'].every((key) => denied.has(measurement[key])), 'network checks require policy denial, not timeout/refusal/no-route');
        assert.equal(measurement.loopback_available, false); row.measurements = measurement;
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
