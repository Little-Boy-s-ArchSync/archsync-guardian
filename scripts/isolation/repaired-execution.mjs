import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeVerificationLog } from '../../dist/index.js';
import { checked, classifyExecution, cleanupOwnedContainer, containerEnvironment, createArguments, discoverEndpoint, dockerClient, hash, validateContainer, validateEngine, validateImage, validateOwnership, validatePolicy } from './backend.mjs';
import { networkProfile, networkProfileSha256 } from './network-policy.mjs';
import { collectRepairedSnapshot, collectRepairedWorkspaceSnapshot } from './workspace-repaired.mjs';
import { validateSnapshot } from './workspace-snapshot.mjs';

// A deliberately narrow fixture contract, not a caller-supplied manifest or
// arbitrary package adapter. No dependency, test, command or policy replacement.
export const repairedFixtureId = 'authored-add-v1';
const projectPath = 'scripts/isolation/project';
const fixtureHashes = Object.freeze({
  [projectPath + '/lib/add.mjs']: 'fb6e8256e50afcdab2bc23a3aadafeebc74c4bdd7d6d589da64017cc6a6af77e',
  [projectPath + '/package.json']: '9170e0626f550cc3ad8d5e016e9e3092d102c09cfdfbc3c4bf1cd5b68bac3f9d',
  [projectPath + '/test.mjs']: '88f476a882183de85cd94b601c93814c3060759aecbd76392cf1d80c1fded50c',
});
const plans = new WeakMap();
const fields = (object, expected) => {
  assert.ok(object && typeof object === 'object' && !Array.isArray(object));
  assert.deepEqual(Reflect.ownKeys(object).sort(), [...expected].sort(), 'unexpected fixture execution fields');
  for (const key of expected) assert.ok(Object.getOwnPropertyDescriptor(object, key)?.value !== undefined, 'plain data fields required');
};
const freeze = (value) => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
const planFor = (prepared) => { const plan = plans.get(prepared); assert.ok(plan, 'preparation must be issued by this collector instance'); return plan; };

async function prepare(options, live) {
  fields(options, live ? ['repository', 'workspace', 'commit', 'fixture', 'replacements'] : ['repository', 'commit', 'fixture', 'replacements']);
  assert.equal(options.fixture, repairedFixtureId, 'unsupported fixture project');
  assert.ok(Array.isArray(options.replacements) && options.replacements.length === 1, 'only one authored source replacement is supported');
  assert.equal(options.replacements[0]?.path, projectPath + '/lib/add.mjs', 'only the authored source can be replaced');
  const input = { repository: options.repository, commit: options.commit, allowlist: Object.keys(fixtureHashes), replacements: options.replacements };
  // The collector copies bytes and request fields synchronously here, before
  // preparation performs other I/O. Never reopen repair paths during execution.
  const collected = await (live ? collectRepairedWorkspaceSnapshot({ ...input, workspace: options.workspace }) : collectRepairedSnapshot(input));
  const change = collected.binding.changes[0];
  for (const file of collected.snapshot.files) {
    assert.equal(file.path === change.path ? change.base_sha256 : file.sha256, fixtureHashes[file.path], 'base is not the supported authored fixture');
    assert.equal(collected.binding.source_objects[file.path].mode, '100644', 'fixture modes must be regular non-executable files');
  }
  assert.deepEqual(validateSnapshot(collected.snapshot), collected.binding.repaired_snapshot);
  assert.notDeepEqual(collected.binding.base_snapshot, collected.binding.repaired_snapshot);
  const helpers = {};
  for (const path of ['fixture-command.mjs', 'workspace-snapshot.mjs', 'workspace-bootstrap.mjs', 'policy.json']) helpers[path] = await readFile(new URL(path, import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url)));
  for (const [path, bytes] of Object.entries(helpers)) assert.equal(hash(bytes), manifest.files[path], 'trusted runner helper differs from its manifest');
  const policy = JSON.parse(helpers['policy.json']); validatePolicy(policy);
  const packet = JSON.stringify(collected.snapshot);
  const payload = Buffer.concat([
    helpers['fixture-command.mjs'], Buffer.from('\n'), helpers['workspace-snapshot.mjs'],
    Buffer.from('\nconst snapshotProjectPath = ' + JSON.stringify(projectPath) + ';\nconst snapshotPacket = JSON.parse(Buffer.from(' + JSON.stringify(Buffer.from(packet).toString('base64')) + ', "base64").toString("utf8"));\n'),
    helpers['workspace-bootstrap.mjs'],
  ]).toString('utf8');
  const prepared = freeze({
    schema_version: '1.0.0-unapproved', status: 'UNAPPROVED', production_ready: false, production_capability: 'NOT_ISSUED',
    fixture: repairedFixtureId, binding: collected.binding, binding_sha256: collected.bindingSha256,
    payload_sha256: hash(payload), helper_sha256: Object.fromEntries(Object.entries(helpers).map(([path, bytes]) => [path, hash(bytes)])),
  });
  plans.set(prepared, { payload, policy: freeze(policy) });
  return prepared;
}

export function prepareRepairedFixture(options) { return prepare(options, false); }
export function prepareRepairedWorkspaceFixture(options) { return prepare(options, true); }

// Validate the first pre-project observation and final parent-generated exit.
// A random line supplied by the project cannot substitute for either position.
// This binds execution input, not repair correctness or trusted project logs.
export function inspectRepairedExecution(prepared, result) {
  planFor(prepared);
  const lines = result.stdout.trimEnd().split('\n');
  let observed = null;
  try {
    const first = JSON.parse(lines[0]);
    assert.deepEqual(first, { stage: 'WORKSPACE_BOUND', ...prepared.binding.repaired_snapshot });
    observed = first;
  } catch {}
  const status = classifyExecution(result);
  if (status === 'INCONCLUSIVE') return { outcome: status, workspace_binding: observed };
  assert.ok(observed, 'container bytes do not match the collected repaired snapshot');
  assert.deepEqual(JSON.parse(lines.at(-1)), { stage: 'WORKSPACE_RESULT', ...prepared.binding.repaired_snapshot, npm_test_exit: result.exit_code }, 'missing or inconsistent trusted npm outcome');
  return { outcome: status, workspace_binding: observed };
}

// No configurable client, image, mount, command, environment or dependencies.
// The sealed preparation is local to this module instance and cannot be forged
// by deserializing an evidence report or edited after collection.
export async function executePreparedRepairedFixture(prepared, options = {}) {
  const { payload, policy } = planFor(prepared);
  fields(options, Object.hasOwn(options, 'signal') ? ['signal'] : []);
  const signal = options.signal;
  if (signal !== undefined) assert.ok(signal instanceof AbortSignal, 'AbortSignal required');
  const report = {
    ...prepared, outcome: 'INCONCLUSIVE', started_at_utc: new Date().toISOString(),
    host_mounts: 0, workspace_returned_to_host: false, arbitrary_project_execution: false,
    dependency_installation: 'NONE', network_scope: policy.network_scope, seccomp_sha256: networkProfileSha256,
    cleanup: { status: 'NOT_CREATED', reason: null },
  };
  const temporary = await mkdtemp(join(tmpdir(), 'archsync-unapproved-repaired-'));
  const secret = randomBytes(24).toString('hex');
  const scrub = (value) => sanitizeVerificationLog(value, temporary, [secret], policy.maximum_output_bytes);
  let client, createAttempted = false, createUncertain = false, knownOwnedId = null;
  const runId = randomBytes(16).toString('hex'), name = 'archsync-unapproved-' + runId;
  const interrupt = new AbortController();
  const onInterrupt = () => interrupt.abort();
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  const combinedSignal = signal ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal;
  const checkCancelled = () => assert.ok(!combinedSignal.aborted, 'CANCELLED before container execution');
  try {
    checkCancelled();
    const configDirectory = join(temporary, 'docker-config'); await mkdir(configDirectory, { mode: 0o700 });
    const profilePath = join(temporary, 'seccomp.json');
    await writeFile(profilePath, JSON.stringify(networkProfile()), { mode: 0o600, flag: 'wx' });
    const canary = join(temporary, 'host-canary.txt'); await writeFile(canary, secret, { mode: 0o600, flag: 'wx' });
    const endpoint = await discoverEndpoint(); client = dockerClient(endpoint, configDirectory, process.env);
    report.endpoint_sha256 = hash(endpoint);
    const info = JSON.parse(checked(await client(['info', '--format', '{{json .}}']), 'engine preflight')); validateEngine(info);
    const image = JSON.parse(checked(await client(['image', 'inspect', policy.image, '--format', '{{json .}}']), 'pinned image preflight')); validateImage(image, info);
    report.engine = { version: info.ServerVersion, architecture: info.Architecture, identity_sha256: hash(info.ID) };
    report.image = { pin: policy.image, id: image.Id };
    // Fields unused by this fixture are fixed, not routes or new listeners.
    const environment = containerEnvironment('workspace-success', { canary, hostAddress: '127.0.0.1', port: 9, syntheticSecret: secret });
    checkCancelled(); report.container_name = name; createAttempted = true;
    const created = await client(createArguments(name, runId, environment, policy, profilePath));
    createUncertain = created.reason !== null;
    const id = checked(created, 'create fixed container').trim(); assert.match(id, /^[a-f0-9]{64}$/u);
    const container = JSON.parse(checked(await client(['container', 'inspect', name, '--format', '{{json .}}']), 'pre-start inspection'));
    assert.equal(container.Id, id); validateOwnership(container, name, runId); knownOwnedId = id;
    report.configuration = validateContainer(container, name, runId, environment, image, policy);
    const currentInfo = JSON.parse(checked(await client(['info', '--format', '{{json .}}']), 'pre-start daemon identity'));
    validateEngine(currentInfo); assert.equal(currentInfo.ID, info.ID, 'daemon identity changed');
    checkCancelled();
    const result = await client(['container', 'start', '--attach', '--interactive', id], {
      input: payload, maximumBytes: policy.maximum_output_bytes, timeoutMs: policy.fixture_timeout_ms, signal: combinedSignal,
    });
    report.exit_code = result.exit_code; report.termination_reason = result.reason;
    report.stdout = scrub(result.stdout); report.stderr = scrub(result.stderr);
    report.stdout_bytes = Buffer.byteLength(result.stdout); report.stderr_bytes = Buffer.byteLength(result.stderr);
    if (!result.reason && result.exit_code !== null) {
      const post = JSON.parse(checked(await client(['container', 'inspect', name, '--format', '{{json .}}']), 'post-execution inspection'));
      assert.equal(validateOwnership(post, name, runId), id);
      assert.equal(post.State.Running, false); assert.equal(post.State.ExitCode, result.exit_code, 'Docker/npm exit mismatch');
      assert.equal(post.State.OOMKilled, false, 'out-of-memory is infrastructure uncertainty'); assert.equal(post.State.Error, '');
    }
    Object.assign(report, inspectRepairedExecution(prepared, result));
    assert.equal(await readFile(canary, 'utf8'), secret, 'host canary was modified'); report.host_canary_unchanged = true;
  } catch (error) { report.outcome = 'INCONCLUSIVE'; report.error = scrub(error.message); }
  finally {
    if (createAttempted) {
      report.cleanup = await cleanupOwnedContainer(client, name, runId, { knownOwnedId });
      if (createUncertain) { report.cleanup.status = 'INCONCLUSIVE'; report.cleanup.reason = 'create client outcome uncertain; delayed daemon creation cannot be excluded'; }
      if (report.cleanup.status !== 'REMOVED') report.outcome = 'INCONCLUSIVE';
      if (report.cleanup.reason) report.cleanup.reason = scrub(report.cleanup.reason);
    }
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    await rm(temporary, { recursive: true, force: true });
  }
  report.finished_at_utc = new Date().toISOString();
  assert.ok(!JSON.stringify(report).includes(secret), 'synthetic secret escaped report redaction');
  return report;
}
