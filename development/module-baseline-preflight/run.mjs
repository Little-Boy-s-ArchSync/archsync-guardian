import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { capture, newReceiptFolder, writeJSON, inventory, hash, portable } from './capture.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../..');
const cases = JSON.parse(readFileSync(resolve(root, 'cases.json'))).cases;
if (process.version !== 'v22.16.0') throw new Error('MBP-001 requires Node 22.16.0');
if (new Set(cases.map(c => c.group)).size !== 8) throw new Error('Scope changed: expected eight groups');
const comparatorRoot = resolve(root, 'comparator/node_modules/dependency-cruiser');
const pkg = JSON.parse(readFileSync(resolve(comparatorRoot, 'package.json')));
if (pkg.version !== '18.3.0') throw new Error('Unexpected comparator');
const out = newReceiptFolder(root, 'extraction');
writeJSON(resolve(out, 'input-snapshot.json'), {
  purpose: 'MBP-001-development-only-not-independent-evaluation',
  node: process.version, platform: process.platform, arch: process.arch, typescript: ts.version,
  comparator_version: pkg.version, fixture_and_harness_files: inventory(root),
  guardian_dist: inventory(resolve(repo, 'dist')), guardian_lock_sha256: hash(readFileSync(resolve(repo, 'pnpm-lock.yaml'))),
  package_lock_sha256: hash(readFileSync(resolve(root, 'comparator/package-lock.json'))),
  source_head: capture(out, 'guardian-head', 'git', ['rev-parse','HEAD'], repo).stdout_text.trim(),
});
capture(out, 'comparator-version', process.execPath, [resolve(comparatorRoot, 'bin/dependency-cruiser.mjs'), '--version'], repo);
capture(out, 'comparator-help', process.execPath, [resolve(comparatorRoot, 'bin/dependency-cruiser.mjs'), '--help'], repo);

const key = pairs => [...new Set(pairs.map(p => JSON.stringify(p)))].sort();
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const summaries = [];
for (const spec of cases) {
  const folder = resolve(out, spec.id); mkdirSync(folder);
  const fixture = resolve(root, 'fixtures', spec.id);
  const config = resolve(fixture, 'tsconfig.json');
  const fatal = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: e => fatal.push(e) });
  if (!parsed || fatal.length || parsed.errors.length) throw new Error(`Population selection failed for ${spec.id}; no comparator invoked for this case`);
  const files = parsed.fileNames.filter(f => /\.[cm]?tsx?$/i.test(f) && !/\.d\.[cm]?ts$/i.test(f)).map(f => portable(relative(fixture,f))).sort();
  writeJSON(resolve(folder, 'population.json'), { source: 'TypeScript configuration file selection, not either graph output', files });
  const comparatorConfig = {
    forbidden: [],
    options: {
      moduleSystems: ['es6'], tsPreCompilationDeps: true,
      exclude: { dynamic: true }, tsConfig: { fileName: 'tsconfig.json' },
      doNotFollow: { path: `^(?!(?:${files.map(regexEscape).join('|')})$)` },
    },
  };
  const dcConfigPath = resolve(folder, 'dependency-cruiser.json');
  writeJSON(dcConfigPath, comparatorConfig);
  const guardian = capture(folder, 'guardian', process.execPath, [resolve(repo, 'scripts/module-preflight.mjs'), config, fixture], fixture);
  let g;
  try { g = JSON.parse(guardian.stdout_text); } catch { g = null; }
  let dcRun = null, dc = null, dcParseError = null;
  if (files.length) {
    dcRun = capture(folder, 'comparator', process.execPath, [resolve(comparatorRoot, 'bin/dependency-cruiser.mjs'), '--config', dcConfigPath, '--output-type', 'json', ...files], fixture);
    try { dc = JSON.parse(dcRun.stdout_text); } catch (error) { dcParseError = error.message; }
  } else {
    writeJSON(resolve(folder, 'comparator-not-executed.json'), { status: 'NOT_EXECUTED_EMPTY_SCOPE', reason: 'No eligible source population; never substitute a directory crawl or zero-edge success', at_utc: new Date().toISOString() });
  }
  const observed = [], outside = [], unresolved = [], nativeOutsideModules = [];
  for (const module of dc?.modules ?? []) {
    const from = portable(module.source);
    if (!files.includes(from)) { nativeOutsideModules.push(module); continue; }
    for (const dep of module.dependencies ?? []) {
      const to = portable(dep.resolved ?? dep.module ?? '');
      if (dep.couldNotResolve) unresolved.push({ from, dependency: dep });
      else if (files.includes(to)) observed.push([from,to]);
      else outside.push({ from, dependency: dep });
    }
  }
  const gp = key((g?.graph.edges ?? []).map(e => [e.from,e.to]));
  const dp = key(observed);
  const expected = key(spec.pairs);
  const expectedIssues = spec.issues ?? [];
  const observedIssues = [...new Set((g?.graph.issues ?? []).map(i => i.code))].sort();
  const checks = {
    guardian_output_present: !!g,
    guardian_status_expected: g?.graph.status === spec.status,
    guardian_exit_expected: guardian.exit_code === (spec.status === 'incomplete' ? 2 : 0),
    guardian_source_population_exact: equal((g?.graph.modules ?? []).map(m => m.file).sort(), files),
    guardian_developer_asserted_pairs: equal(gp, expected),
    guardian_required_issues_present: expectedIssues.every(code => observedIssues.includes(code)),
    guardian_architecture_null_when_incomplete: spec.status !== 'incomplete' || g?.architecture === null,
    guardian_exclusions: !spec.exclusions || equal((g?.graph.exclusions ?? []).map(e => e.reason).sort(), spec.exclusions),
    guardian_locations: !spec.location_lines || equal(g?.graph.edges?.[0]?.evidence?.map(e=>e.line),spec.location_lines),
    comparator_executed: !!dcRun,
    comparator_exit_zero: dcRun?.exit_code === 0,
    comparator_graph_present: Array.isArray(dc?.modules),
    comparator_source_population_exact: !!dc && equal(dc.modules.map(m=>portable(m.source)).filter(f=>files.includes(f)).sort(),files),
    scoped_pair_sets_equal: !!dc && equal(gp,dp),
  };
  const normalized = {
    case: spec.id, group: spec.group, purpose: 'development-engineering-assertions-not-accuracy',
    checks, guardian_exit: guardian.exit_code, guardian_status: g?.graph.status ?? null, guardian_issues: observedIssues,
    guardian_pairs: gp.map(JSON.parse), comparator_pairs: dp.map(JSON.parse),
    comparator_exit: dcRun?.exit_code ?? null, comparator_parse_error: dcParseError,
    comparator_outside_source_dependencies: outside, comparator_unresolved_dependencies: unresolved,
    comparator_outside_source_modules: nativeOutsideModules,
    eligible_for_later_comparison: false,
    note: 'Native exit 0 without rules is not an architecture PASS; incomplete/unsupported cases must not be scored as complete successes.',
  };
  writeJSON(resolve(folder, 'normalized.json'), normalized);
  summaries.push({ case:spec.id, group:spec.group, guardian_exit:guardian.exit_code, guardian_status:g?.graph.status ?? null, comparator_exit:dcRun?.exit_code ?? null, guardian_pairs:gp.length, comparator_pairs:dp.length, checks, observed_issues:observedIssues });
  console.log(`${spec.id}: guardian=${guardian.exit_code}/${g?.graph.status} comparator=${dcRun?.exit_code ?? 'not-executed'} pairsEqual=${checks.scoped_pair_sets_equal}`);
}
writeJSON(resolve(out, 'summary.json'), { status:'DEVELOPMENT_PREFLIGHT_EXECUTED_REQUIRES_INTERPRETATION', groups:8, cases:summaries, research_accuracy:null, D3_executed:false, rule_semantics_equivalence_tested:false, files:inventory(out,new Set()) });
console.log(out);
