import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from './verify.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const original = resolve(root,'receipts/2026-09-27T08-05-53.210Z-extraction');
const tempRoot = resolve(root,'../../.artifacts/mbp001-validator-tests');
mkdirSync(tempRoot,{recursive:true});
function tampered(file, mutate) {
  const copy = mkdtempSync(resolve(tempRoot,'case-'));
  cpSync(original,copy,{recursive:true});
  const path = resolve(copy,file), data=JSON.parse(readFileSync(path));
  mutate(data); writeFileSync(path,JSON.stringify(data));
  return copy;
}
test('retained output is verified without rerunning either tool',()=>{
  const result=verifyRun(original);
  assert.equal(result.cases.length,13);
  assert.equal(result.cases.filter(c=>c.state==='DEVELOPMENT_PAIR_COMPATIBILITY_OBSERVED').length,8);
  assert.equal(result.research_accuracy,null);
});
test('tampered native graph is rejected',()=>{
  assert.throws(()=>verifyRun(tampered('M8/comparator.stdout.txt',d=>{d.modules=[];})),/Retained hash changed/);
});
test('relabelling engineering run as D3 is rejected',()=>{
  assert.throws(()=>verifyRun(tampered('summary.json',d=>{d.D3_executed=true;})));
});
test('dropping an incomplete configuration from summary is rejected',()=>{
  assert.throws(()=>verifyRun(tampered('summary.json',d=>{d.cases=d.cases.filter(c=>c.case!=='M7-syntax');})));
});
