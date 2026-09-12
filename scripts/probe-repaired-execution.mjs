import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './isolation/backend.mjs';
import { collectGitSnapshot } from './isolation/workspace-git.mjs';
import { repositoryDirty, repositoryHead } from './isolation/repository-git.mjs';
import { repairedFixtureId, prepareRepairedFixture, executePreparedRepairedFixture } from './isolation/repaired-execution.mjs';

assert.equal(process.argv.length, 2, 'This authored probe accepts no project, command or configuration arguments');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.equal(repositoryDirty(root), false, 'commit runner changes before recording an exact-source experiment');
const commit = repositoryHead(root), sourcePath = 'scripts/isolation/project/lib/add.mjs';
const base = await collectGitSnapshot({ repository: root, commit, allowlist: [sourcePath] });
const started = new Date().toISOString(), cases = [];
const probes = [
  { name: 'repaired-success', body: 'export const add = (a, b) => a - -b;\n', outcome: 'FIXTURE_PASSED' },
  { name: 'repaired-failure', body: 'export const add = () => 0;\n', outcome: 'FIXTURE_FAILED' },
  { name: 'repaired-timeout', body: 'export const add = () => 42; while (true) {}\n', outcome: 'INCONCLUSIVE' },
  { name: 'repaired-cancel', body: 'setInterval(() => {}, 100); export const add = () => 42;\n', outcome: 'INCONCLUSIVE' },
  { name: 'repaired-stdout-overflow', body: 'process.stdout.write("X".repeat(100000)); export const add = () => 42;\n', outcome: 'INCONCLUSIVE' },
  { name: 'repaired-stderr-overflow', body: 'process.stderr.write("X".repeat(100000)); export const add = () => 42;\n', outcome: 'INCONCLUSIVE' },
];
let passed = true;
for (const probe of probes) {
  const marker = probe.name.toUpperCase().replaceAll('-', '_');
  const bytes = Buffer.from(`console.log(${JSON.stringify(marker)});\n` + probe.body);
  const expectedHash = hash(bytes);
  const prepared = await prepareRepairedFixture({ repository: root, commit, fixture: repairedFixtureId, replacements: [{ path: sourcePath, baseSha256: hash(base.files[sourcePath]), bytes }] });
  // A later producer mutation must not change either the payload or evidence.
  bytes.fill(0);
  const controller = new AbortController();
  const timer = probe.name === 'repaired-cancel' ? setTimeout(() => controller.abort(), 3000) : undefined;
  let row;
  try {
    row = await executePreparedRepairedFixture(prepared, { signal: controller.signal });
    row.mode = probe.name; cases.push(row);
    assert.equal(row.outcome, probe.outcome);
    assert.equal(row.cleanup.status, 'REMOVED'); assert.equal(row.cleanup.removal_verified, true);
    assert.equal(row.binding.source_commit, commit);
    assert.equal(row.binding.changes[0].repaired_sha256, expectedHash);
    assert.notEqual(row.binding.repaired_snapshot.sha256, row.binding.base_snapshot.sha256);
    assert.equal(row.workspace_binding.sha256, row.binding.repaired_snapshot.sha256);
    assert.ok(row.stdout.includes(marker), 'repaired source did not execute');
    if (probe.name === 'repaired-success') { assert.match(row.stdout, /^# tests 3$/mu); assert.match(row.stdout, /^# pass 3$/mu); }
    if (probe.name === 'repaired-failure') { assert.equal(row.exit_code, 1); assert.match(row.stdout, /^# fail 1$/mu); }
    if (probe.name === 'repaired-timeout') assert.ok(row.termination_reason === 'TIMED_OUT' || row.exit_code === 125, 'timeout must remain infrastructure uncertainty');
    if (probe.name === 'repaired-cancel') assert.equal(row.termination_reason, 'CANCELLED');
    if (probe.name.endsWith('overflow')) assert.equal(row.termination_reason, 'OUTPUT_LIMIT');
    assert.equal(row.host_canary_unchanged, true); row.expected_outcome_observed = true;
  } catch (error) { passed = false; if (row) { row.expected_outcome_observed = false; row.probe_error = error.message; } else cases.push({ mode: probe.name, probe_error: error.message }); }
  finally { clearTimeout(timer); }
  if (row?.cleanup.status === 'INCONCLUSIVE') break;
}
const sourceFiles = {};
for (const path of ['scripts/isolation/repaired-execution.mjs', 'scripts/isolation/repaired-execution-contracts.mjs', 'scripts/isolation/workspace-repaired.mjs', 'scripts/isolation/workspace-bootstrap.mjs', 'scripts/isolation/backend.mjs', 'scripts/isolation/manifest.json', 'scripts/probe-repaired-execution.mjs']) sourceFiles[path] = hash(await readFile(join(root, path)));
const report = { schema_version: '1.0.0-unapproved', status: 'UNAPPROVED', production_ready: false, production_capability: 'NOT_ISSUED', probe_result: passed && cases.length === probes.length ? 'PASS' : 'INCONCLUSIVE', source_commit: commit, source_dirty: repositoryDirty(root), source_files: sourceFiles, started_at_utc: started, finished_at_utc: new Date().toISOString(), cases };
const output = join(root, '.artifacts/isolation', 'repaired-' + started.replaceAll(':', '-') + '-' + randomBytes(4).toString('hex'));
await mkdir(output, { recursive: true }); await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`UNAPPROVED REPAIRED EXECUTION ${report.probe_result}: ${cases.filter((row) => row.expected_outcome_observed).length}/${probes.length}`);
console.log(`Evidence: ${join(output, 'result.json')}`);
if (report.probe_result !== 'PASS') process.exitCode = 1;
