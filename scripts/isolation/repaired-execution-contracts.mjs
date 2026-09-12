import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from './backend.mjs';
import { repairedFixtureId, prepareRepairedFixture, prepareRepairedWorkspaceFixture, executePreparedRepairedFixture, inspectRepairedExecution } from './repaired-execution.mjs';

const sourcePath = 'scripts/isolation/project/lib/add.mjs';
const original = await readFile(new URL('project/lib/add.mjs', import.meta.url));
const replacement = Buffer.from('export const add = (a, b) => a - -b;\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
async function fixture(t) {
  const repository = await mkdtemp(join(tmpdir(), 'archsync-repaired-runner-contract-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(join(repository, 'scripts/isolation/project/lib'), { recursive: true });
  for (const path of ['package.json', 'test.mjs', 'lib/add.mjs']) await writeFile(join(repository, 'scripts/isolation/project', path), await readFile(new URL('project/' + path, import.meta.url)));
  git(repository, 'init', '--quiet'); git(repository, 'config', 'user.name', 'Authored fixture'); git(repository, 'config', 'user.email', 'authored@example.invalid');
  git(repository, 'add', '.'); git(repository, 'commit', '--quiet', '-m', 'Authored fixture base');
  const commit = git(repository, 'rev-parse', 'HEAD').trim();
  const request = (bytes = Buffer.from(replacement)) => ({ repository, commit, fixture: repairedFixtureId, replacements: [{ path: sourcePath, baseSha256: hash(original), bytes }] });
  return { repository, commit, request };
}
const output = (prepared, exit_code = 0) => ({
  exit_code, reason: null, stderr: '',
  stdout: JSON.stringify({ stage: 'WORKSPACE_BOUND', ...prepared.binding.repaired_snapshot }) + '\nuntrusted npm/test output\n' + JSON.stringify({ stage: 'WORKSPACE_RESULT', ...prepared.binding.repaired_snapshot, npm_test_exit: exit_code }) + '\n',
});

test('preparation binds exact repaired bytes and commit without reading or changing the live workspace', async (t) => {
  const { repository, commit, request } = await fixture(t);
  await writeFile(join(repository, sourcePath), 'uncommitted bytes must never be executed');
  const before = git(repository, 'status', '--porcelain');
  const bytes = Buffer.from(replacement), input = request(bytes);
  const pending = prepareRepairedFixture(input);
  bytes.fill(0); input.replacements[0].path = 'package.json'; input.commit = '0'.repeat(40);
  const prepared = await pending;
  assert.equal(prepared.binding.source_commit, commit);
  assert.equal(prepared.binding.changes[0].base_sha256, hash(original));
  assert.equal(prepared.binding.changes[0].repaired_sha256, hash(replacement));
  assert.equal(prepared.binding_sha256, hash(JSON.stringify(prepared.binding)));
  assert.notEqual(prepared.binding.repaired_snapshot.sha256, prepared.binding.base_snapshot.sha256);
  assert.deepEqual(Object.keys(prepared.binding.source_objects), [sourcePath, 'scripts/isolation/project/package.json', 'scripts/isolation/project/test.mjs']);
  assert.equal(git(repository, 'status', '--porcelain'), before);
  assert.equal(await readFile(join(repository, sourcePath), 'utf8'), 'uncommitted bytes must never be executed');
  assert.throws(() => { prepared.binding.changes[0].repaired_sha256 = '0'.repeat(64); });
  await assert.rejects(executePreparedRepairedFixture(JSON.parse(JSON.stringify(prepared))), /issued by this collector/);
  for (const options of [{ command: 'node arbitrary' }, { environment: {} }, { client: {} }, { image: 'node:latest' }, { signal: {} }]) await assert.rejects(executePreparedRepairedFixture(prepared, options));
});

test('unsupported projects, replacements, stale bytes and dependency changes fail before Docker', async (t) => {
  const { repository, request } = await fixture(t);
  for (const patch of [{ fixture: 'arbitrary-project' }, { allowlist: [sourcePath] }, { command: 'npm install' }, { replacements: [] }]) await assert.rejects(prepareRepairedFixture({ ...request(), ...patch }));
  for (const patch of [{ path: 'scripts/isolation/project/package.json' }, { path: 'scripts/isolation/project/test.mjs' }, { baseSha256: '0'.repeat(64) }, { bytes: original }, { mode: '100755' }]) {
    const input = request(); Object.assign(input.replacements[0], patch); await assert.rejects(prepareRepairedFixture(input));
  }
  await writeFile(join(repository, 'scripts/isolation/project/package.json'), '{"scripts":{"test":"npm install"},"dependencies":{"new-scope":"*"}}');
  git(repository, 'add', '.'); git(repository, 'commit', '--quiet', '-m', 'Unsupported dependency and command');
  await assert.rejects(prepareRepairedFixture({ ...request(), commit: git(repository, 'rev-parse', 'HEAD').trim() }), /not the supported authored fixture/);
});

test('execution observations reject committed-base substitution, spoofed later lines and missing/mismatched npm outcomes', async (t) => {
  const { request } = await fixture(t); const prepared = await prepareRepairedFixture(request());
  assert.equal(inspectRepairedExecution(prepared, output(prepared)).outcome, 'FIXTURE_PASSED');
  assert.equal(inspectRepairedExecution(prepared, output(prepared, 1)).outcome, 'FIXTURE_FAILED');
  const wrongBase = output(prepared); wrongBase.stdout = wrongBase.stdout.replace(prepared.binding.repaired_snapshot.sha256, prepared.binding.base_snapshot.sha256);
  const spoof = output(prepared); spoof.stdout = 'project-controlled first line\n' + spoof.stdout;
  const missing = output(prepared); missing.stdout = missing.stdout.split('\n').slice(0, -2).join('\n');
  const mismatch = output(prepared, 1); mismatch.exit_code = 0;
  const bootstrapError = { exit_code: 1, reason: null, stdout: '', stderr: 'materialization failed' };
  for (const result of [wrongBase, spoof, missing, mismatch, bootstrapError]) assert.throws(() => inspectRepairedExecution(prepared, result));
  for (const reason of ['CANCELLED', 'TIMED_OUT', 'OUTPUT_LIMIT', 'CLIENT_ERROR']) {
    const result = inspectRepairedExecution(prepared, { ...output(prepared), reason });
    assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.workspace_binding.sha256, prepared.binding.repaired_snapshot.sha256);
  }
  for (const exit_code of [125, 126, 127, null]) assert.equal(inspectRepairedExecution(prepared, { ...output(prepared), exit_code }).outcome, 'INCONCLUSIVE');
});

test('pre-start cancellation creates no container and never produces an approval', async (t) => {
  const { request } = await fixture(t); const prepared = await prepareRepairedFixture(request());
  const controller = new AbortController(); controller.abort();
  const report = await executePreparedRepairedFixture(prepared, { signal: controller.signal });
  assert.equal(report.outcome, 'INCONCLUSIVE'); assert.equal(report.cleanup.status, 'NOT_CREATED');
  assert.equal(report.status, 'UNAPPROVED'); assert.equal(report.production_ready, false); assert.equal(report.production_capability, 'NOT_ISSUED');
  assert.equal(report.workspace_returned_to_host, false); assert.equal(report.host_mounts, 0); assert.equal(report.dependency_installation, 'NONE');
  assert.match(report.error, /CANCELLED/); assert.equal(report.container_name, undefined);
});

test('live collection feeds the same sealed runner on Linux and refuses other platforms', async (t) => {
  const { repository, request } = await fixture(t);
  await writeFile(join(repository, sourcePath), replacement);
  const input = request(); input.workspace = repository;
  input.replacements = [{ path: sourcePath, baseSha256: hash(original), sha256: hash(replacement) }];
  if (process.platform !== 'linux') { await assert.rejects(prepareRepairedWorkspaceFixture(input), /requires Linux descriptor-relative opens/); return; }
  const prepared = await prepareRepairedWorkspaceFixture(input);
  const portable = await prepareRepairedFixture(request());
  assert.equal(prepared.binding.collection.kind, 'LINUX_DESCRIPTOR_RELATIVE_WORKSPACE');
  assert.deepEqual(prepared.binding.repaired_snapshot, portable.binding.repaired_snapshot);
  assert.equal(prepared.payload_sha256, portable.payload_sha256);
  await writeFile(join(repository, sourcePath), 'changed after collection');
  assert.equal(inspectRepairedExecution(prepared, output(prepared)).outcome, 'FIXTURE_PASSED');
});
