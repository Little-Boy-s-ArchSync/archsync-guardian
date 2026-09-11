import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const modes = Object.freeze(['success', 'failure', 'filesystem', 'network', 'timeout', 'cancel', 'stdout-overflow', 'stderr-overflow']);
export const imagePin = 'docker.io/library/node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34';
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const labelKey = 'io.archsync.unapproved-isolation-run';
const empty = (value) => value == null || (Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.keys(value).length === 0);

export function validatePolicy(policy) {
  assert.deepEqual(policy, {
    schema_version: '1.0.0-unapproved', status: 'UNAPPROVED', image: imagePin,
    node_version: 'v22.16.0', user: '1000:1000', memory_bytes: 268435456,
    nano_cpus: 1000000000, pids_limit: 64,
    tmpfs: 'rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000',
    maximum_output_bytes: 65536, control_timeout_ms: 15000, fixture_timeout_ms: 10000,
    termination_timeout_ms: 1000, post_termination_observation_ms: 1800,
    network_scope: 'EXTERNAL_EGRESS_DENIED_LOOPBACK_REMAINS', host_mounts: 'NONE', production_capability: 'NOT_ISSUED',
  }, 'fixed unapproved policy changed');
}

export function validateEndpoint(endpoint) {
  assert.equal(typeof endpoint, 'string');
  assert.match(endpoint, /^unix:\/\/\/[A-Za-z0-9_./ -]+$/u, 'only a local Unix daemon socket is supported');
  assert.ok(!endpoint.slice(7).split('/').includes('..'), 'daemon endpoint traversal');
  assert.ok(!endpoint.includes('//', 7), 'ambiguous daemon endpoint');
}

export async function discoverEndpoint(environment = process.env) {
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']) {
    assert.ok(!environment[key], `inherited ${key} override refused`);
  }
  const paths = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')];
  if (process.getuid) paths.push(`/run/user/${process.getuid()}/docker.sock`);
  for (const candidate of paths) {
    try {
      const path = await realpath(candidate);
      const metadata = await lstat(path);
      assert.ok(metadata.isSocket(), 'daemon endpoint is not a socket');
      assert.ok(metadata.uid === 0 || metadata.uid === process.getuid(), 'unexpected daemon socket owner');
      assert.equal(metadata.mode & 0o002, 0, 'world-writable daemon socket refused');
      const endpoint = `unix://${path}`;
      validateEndpoint(endpoint);
      return endpoint;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('supported local Docker socket unavailable');
}

export function validateEngine(info) {
  assert.equal(info.OSType, 'linux', 'Linux container engine required');
  assert.ok(['x86_64', 'aarch64'].includes(info.Architecture), 'unsupported engine architecture');
  assert.equal(info.CgroupVersion, '2', 'cgroup v2 required');
  assert.ok(info.SecurityOptions?.includes('name=seccomp,profile=builtin'), 'default seccomp support required');
  for (const key of ['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CPUSet', 'CpuCfsQuota', 'CpuCfsPeriod']) {
    assert.equal(info[key], true, `engine lacks ${key}`);
  }
  assert.equal(typeof info.ID, 'string'); assert.ok(info.ID.length > 0);
}

export function validateImage(image, info) {
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, info.Architecture === 'aarch64' ? 'arm64' : 'amd64');
  assert.ok(image.RepoDigests?.some((value) => value.endsWith(imagePin.slice(imagePin.indexOf('@')))), 'pinned image digest unavailable');
  assert.ok(empty(image.Config?.Volumes), 'image-declared volumes refused');
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/u);
}

export function containerEnvironment(mode, input) {
  assert.ok(modes.includes(mode), 'unknown authored fixture mode');
  assert.match(input.canary, /^\/[A-Za-z0-9_./ -]+$/u);
  assert.match(input.hostAddress, /^\d+\.\d+\.\d+\.\d+$/u);
  assert.ok(Number.isInteger(input.port) && input.port > 0 && input.port < 65536);
  assert.match(input.syntheticSecret, /^[a-f0-9]{48}$/u);
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/workspace', TMPDIR: '/workspace',
    CI: 'true', npm_config_cache: '/workspace/.npm', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    ARCHSYNC_PROBE_MODE: mode, ARCHSYNC_PROBE_CANARY: input.canary, ARCHSYNC_PROBE_PORT: String(input.port),
    ARCHSYNC_PROBE_HOST_GATEWAY: input.hostAddress, ARCHSYNC_PROBE_SYNTHETIC_SECRET: input.syntheticSecret,
  };
}

export function createArguments(name, runId, environment, policy) {
  validatePolicy(policy);
  assert.match(runId, /^[a-f0-9]{32}$/u); assert.equal(name, `archsync-unapproved-${runId}`);
  return ['container', 'create', '--pull=never', '--name', name, '--label', `${labelKey}=${runId}`,
    '--interactive', '--network=none', '--read-only', '--user', policy.user, '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--cgroupns=private', '--ipc=none', '--pids-limit=64',
    '--memory=268435456', '--memory-swap=268435456', '--cpus=1', '--restart=no',
    '--tmpfs', `/workspace:${policy.tmpfs}`, '--workdir=/workspace',
    '--log-driver=local', '--log-opt=max-size=64k', '--log-opt=max-file=1', '--log-opt=compress=false',
    '--entrypoint=/usr/local/bin/node', ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    policy.image, '--input-type=module', '-'];
}

export function validateOwnership(container, name, runId) {
  assert.match(container.Id, /^[a-f0-9]{64}$/u);
  assert.equal(container.Name, '/' + name);
  assert.equal(container.Config?.Labels?.[labelKey], runId, 'container ownership mismatch');
  return container.Id;
}

export function validateContainer(container, name, runId, environment, image, policy) {
  validateOwnership(container, name, runId);
  const host = container.HostConfig, config = container.Config;
  assert.equal(container.State.Status, 'created'); assert.equal(container.State.Running, false);
  assert.equal(container.Image, image.Id); assert.equal(config.Image, policy.image);
  assert.deepEqual(config.Entrypoint, ['/usr/local/bin/node']); assert.deepEqual(config.Cmd, ['--input-type=module', '-']);
  assert.equal(config.User, policy.user); assert.equal(config.WorkingDir, '/workspace');
  assert.equal(config.OpenStdin, true); assert.equal(config.Tty, false);
  const expectedEnvironment = Object.fromEntries(image.Config.Env.map((value) => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
  Object.assign(expectedEnvironment, environment);
  assert.deepEqual([...config.Env].sort(), Object.entries(expectedEnvironment).map(([key, value]) => `${key}=${value}`).sort(), 'unexpected container environment');
  assert.equal(host.NetworkMode, 'none'); assert.equal(host.Privileged, false); assert.equal(host.ReadonlyRootfs, true);
  assert.deepEqual(host.CapDrop, ['ALL']); assert.ok(empty(host.CapAdd));
  assert.deepEqual(host.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(host.CgroupnsMode, 'private'); assert.equal(host.IpcMode, 'none'); assert.equal(host.PidMode, '');
  assert.equal(host.UTSMode, ''); assert.ok(['', 'private'].includes(host.UsernsMode));
  assert.equal(host.Memory, policy.memory_bytes); assert.equal(host.MemorySwap, policy.memory_bytes);
  assert.equal(host.NanoCpus, policy.nano_cpus); assert.equal(host.PidsLimit, policy.pids_limit);
  assert.deepEqual(host.Tmpfs, { '/workspace': policy.tmpfs });
  assert.deepEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 });
  assert.deepEqual(host.LogConfig, { Type: 'local', Config: { 'max-file': '1', 'max-size': '64k', compress: 'false' } });
  for (const field of ['Binds', 'Mounts', 'VolumesFrom', 'Devices', 'DeviceRequests', 'PortBindings', 'ExtraHosts', 'Links', 'GroupAdd']) {
    assert.ok(empty(host[field]), `unexpected ${field}`);
  }
  assert.ok(empty(container.Mounts), 'host/image mount refused');
  assert.ok(empty(config.Volumes)); assert.ok(empty(config.ExposedPorts)); assert.equal(host.PublishAllPorts, false);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), ['none']);
  return { image_id: container.Image, configuration_sha256: hash(JSON.stringify({ Config: config, HostConfig: host })), host_mounts: 0 };
}

// One bounded child per Docker operation; killing an attached client is followed
// by container-level termination in cleanupOwnedContainer, never considered enough.
export function execute(command, args, { environment, input = '', timeoutMs = 15000, maximumBytes = 65536, signal } = {}) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    let reason = null, settled = false;
    const child = spawn(command, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const stop = (value) => { if (!reason) reason = value; child.kill('SIGKILL'); };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('TIMED_OUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (bytes) => {
      const room = maximumBytes - sizes[stream];
      if (room > 0) chunks[stream].push(bytes.subarray(0, room));
      sizes[stream] += Math.min(bytes.length, Math.max(0, room));
      if (bytes.length > room) stop('OUTPUT_LIMIT');
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    const finish = (code, error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ exit_code: code, reason: reason ?? (error ? 'CLIENT_ERROR' : null), stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'), ...(error ? { error: String(error.message) } : {}) });
    };
    child.once('error', (error) => finish(null, error)); child.once('close', (code) => finish(code));
  });
}

export function classifyExecution(result) {
  if (result.reason || result.exit_code === null || [125, 126, 127].includes(result.exit_code)) return 'INCONCLUSIVE';
  return result.exit_code === 0 ? 'FIXTURE_PASSED' : 'FIXTURE_FAILED';
}

export function dockerClient(endpoint, configDirectory, environment, runner = execute) {
  validateEndpoint(endpoint);
  const safeEnvironment = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'LANG', 'LC_ALL']) if (environment[key]) safeEnvironment[key] = environment[key];
  // HOME/config are harness-owned. No user Docker config, credential helpers,
  // proxy credentials, DOCKER_* options or host secrets reach this client.
  safeEnvironment.HOME = configDirectory;
  return async (args, options = {}) => runner('docker', ['--config', configDirectory, '--host', endpoint, ...args], { ...options, environment: safeEnvironment });
}

export function checked(result, operation) {
  assert.equal(result.reason, null, `${operation}: ${result.reason}`);
  assert.equal(result.exit_code, 0, `${operation}: ${result.stderr}`);
  return result.stdout;
}

function absent(result, name) {
  return result.exit_code === 1 && !result.reason && result.stdout.trim() === '' &&
    result.stderr.trim() === `Error response from daemon: No such container: ${name}`;
}

export async function cleanupOwnedContainer(client, name, runId, { observeDescendant = false, observationMs = 1800, allowAbsent = false, knownOwnedId = null } = {}) {
  let cleanupError = null, stopped = false, postTerminationNoMarker = null, removalVerified = false;
  if (knownOwnedId !== null) assert.match(knownOwnedId, /^[a-f0-9]{64}$/u);
  let container, id;
  const inspect = () => client(['container', 'inspect', name, '--format', '{{json .}}']);
  try {
    const first = await inspect();
    if (absent(first, name)) return { status: allowAbsent ? 'ABSENT' : 'INCONCLUSIVE', reason: allowAbsent ? null : 'created container unexpectedly absent' };
    // A previously inspected immutable CID is sufficient for a narrow cleanup
    // attempt if this later read fails. Never derive it from a caller name.
    if (first.reason || first.exit_code !== 0) id = knownOwnedId;
    container = JSON.parse(checked(first, 'cleanup inspect'));
    id = validateOwnership(container, name, runId);
    if (container.State.Running) checked(await client(['container', 'kill', '--signal=KILL', id]), 'kill container and descendants');
    container = JSON.parse(checked(await inspect(), 'post-stop inspect'));
    validateOwnership(container, name, runId);
    assert.equal(container.State.Running, false); assert.equal(container.State.Pid, 0); stopped = true;
    if (observeDescendant) {
      await new Promise((resolve) => setTimeout(resolve, observationMs));
      const logs = await client(['container', 'logs', id]);
      checked(logs, 'post-deadline logs');
      const output = logs.stdout + logs.stderr;
      assert.ok(output.includes('DESCENDANT_STARTED'), 'descendant was not observed starting');
      assert.ok(!output.includes('LATE_DESCENDANT_MARKER'), 'descendant outlived deadline');
      postTerminationNoMarker = true;
    }
  } catch (error) { cleanupError = error.message; }
  if (id) {
    try {
      // Identity was bound to the unguessable name/label before this removal.
      checked(await client(['container', 'rm', '--force', id]), 'remove owned container');
      assert.ok(absent(await inspect(), name), 'container removal not verified');
      const remaining = checked(await client(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${labelKey}=${runId}`]), 'owned-container inventory');
      assert.equal(remaining.trim(), '', 'owned container remains');
      removalVerified = true;
    } catch (error) { cleanupError ??= error.message; }
  } else { cleanupError ??= 'owned container identity unavailable'; }
  return { status: cleanupError ? 'INCONCLUSIVE' : 'REMOVED', reason: cleanupError, stopped, removal_verified: removalVerified, post_termination_no_late_marker: postTerminationNoMarker };
}
