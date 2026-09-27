import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './capture.mjs';

function safe(root, file) {
  const path = resolve(root, file), rel = relative(root,path);
  assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+sep), 'Receipt path escapes its root');
  return path;
}
const json = path => JSON.parse(readFileSync(path));
const pairs = values => [...new Set(values.map(pair=>JSON.stringify(pair)))].sort();

/** Verifies retained files only. Does not execute either analyzer. */
export function verifyRun(folder) {
  const summary = json(resolve(folder, 'summary.json'));
  assert.equal(summary.status, 'DEVELOPMENT_PREFLIGHT_EXECUTED_REQUIRES_INTERPRETATION');
  assert.equal(summary.D3_executed, false);
  assert.equal(summary.research_accuracy, null);
  assert.equal(summary.rule_semantics_equivalence_tested, false);
  assert.equal(new Set(summary.cases.map(row=>row.group)).size,8);
  assert.equal(new Set(summary.cases.map(row=>row.case)).size,13);
  for (const file of summary.files) assert.equal(hash(readFileSync(safe(folder,file.file))),file.sha256,`Retained hash changed: ${file.file}`);
  const results = [];
  for (const row of summary.cases) {
    const root = safe(folder,row.case);
    const population = json(resolve(root,'population.json')).files;
    const normalized = json(resolve(root,'normalized.json'));
    const g = json(resolve(root,'guardian.stdout.txt'));
    assert.equal(normalized.eligible_for_later_comparison,false);
    assert.equal(g.purpose,'development-preflight-not-independent-evaluation');
    assert.deepEqual(g.graph.modules.map(m=>m.file).sort(),population);
    const gi = json(resolve(root,'guardian.invocation.json'));
    assert.equal(gi.exit_code,g.graph.status==='complete-within-scope'?0:2);
    if (g.graph.status==='incomplete') assert.equal(g.architecture,null);
    assert.deepEqual(pairs(g.graph.edges.map(e=>[e.from,e.to])),pairs(normalized.guardian_pairs));
    if (!population.length) {
      assert.equal(json(resolve(root,'comparator-not-executed.json')).status,'NOT_EXECUTED_EMPTY_SCOPE');
      assert.equal(row.comparator_exit,null);
      results.push({case:row.case,state:'EMPTY_SCOPE_NOT_SCORED'});
      continue;
    }
    const dc = json(resolve(root,'comparator.stdout.txt'));
    const ci = json(resolve(root,'comparator.invocation.json'));
    const selected = [];
    for (const module of dc.modules) {
      if (!population.includes(module.source)) continue;
      for (const dep of module.dependencies) if (!dep.couldNotResolve && population.includes(dep.resolved)) selected.push([module.source,dep.resolved]);
    }
    assert.deepEqual(pairs(selected),pairs(normalized.comparator_pairs));
    assert.deepEqual(ci.args.slice(-population.length),population);
    assert.equal(dc.summary.environment.version,'18.3.0');
    assert.equal(dc.summary.environment.nodeVersionFound,'v22.16.0');
    assert.deepEqual(dc.summary.optionsUsed.moduleSystems,['es6']);
    assert.equal(dc.summary.optionsUsed.tsPreCompilationDeps,true);
    assert.equal(dc.summary.optionsUsed.exclude.dynamic,true);
    const same = JSON.stringify(pairs(selected))===JSON.stringify(pairs(normalized.guardian_pairs));
    assert.equal(row.checks.scoped_pair_sets_equal,same);
    const complete = g.graph.status==='complete-within-scope';
    results.push({case:row.case,state:complete && same && ci.exit_code===0?'DEVELOPMENT_PAIR_COMPATIBILITY_OBSERVED':'INCOMPLETE_OR_MISMATCH_NOT_SCORED'});
  }
  // An exit-zero comparator graph may still contain unresolved dependencies.
  const unresolved = json(resolve(folder,'M7-unresolved/normalized.json'));
  assert(unresolved.comparator_unresolved_dependencies.length>0);
  // Keep the first observed syntax-domain difference visible; do not drop it.
  assert.deepEqual(json(resolve(folder,'M8/normalized.json')).comparator_pairs,[['src/app.ts','src/static.ts'],['src/app.ts','src/type-expression.ts']]);
  return {status:'RETAINED_DEVELOPMENT_RUN_VERIFIED',groups:8,cases:results,D3_executed:false,research_accuracy:null};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const run = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), 'receipts/2026-09-27T08-05-53.210Z-extraction');
  console.log(JSON.stringify(verifyRun(resolve(run)),null,2));
}
