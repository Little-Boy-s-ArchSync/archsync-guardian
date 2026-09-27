import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { analyzeTypeScriptRepository } from "./analyzer.js";
import { testArchitecture, writeSources } from "./test-helpers.js";
let repository: string;
beforeEach(async () => { repository = await mkdtemp(join(tmpdir(), "archsync-adversarial-")); });
afterEach(async () => { await rm(repository, { recursive: true, force: true }); });
async function edges(source: string) {
  await writeSources(repository, { "service/src/app.ts": source });
  return (await analyzeTypeScriptRepository(repository, testArchitecture())).relationships.map(({ to, type }) => `${type}|${to}`);
}
it.each([
  ['type-only default import', 'import type pg from "pg"; const db = new pg.Client({connectionString:"postgres://db/x"}); db.query("x");'],
  ['type-only named import', 'import {type Client} from "pg"; const db = new Client({connectionString:"postgres://db/x"}); db.query("x");'],
  ['type-only namespace import', 'import type * as redis from "redis"; const cache=redis.createClient({url:"redis://cache"}); cache.get("x");'],
  ['pg protocol mismatch', 'import {Client} from "pg"; const db=new Client({connectionString:"https://wrong"}); db.query("x");'],
  ['redis protocol mismatch', 'import {createClient} from "redis"; const cache=createClient({url:"postgres://wrong/x"}); cache.get("x");'],
  ['fetch protocol mismatch', 'fetch("redis://wrong");'],
  ['comparison is not URL', 'fetch("https://wrong" === "https://wrong");'],
  ['arithmetic is not URL', 'fetch("https://wrong" - 1);'],
  ['shadowed fetch parameter', 'function f(fetch: any) { fetch("https://wrong"); }'],
  ['shadowed process parameter', 'function f(process: any) { fetch(process.env.SERVICE_URL); }'],
  ['shadowed pg constructor', 'import {Client} from "pg"; function f(Client:any) {const db=new Client({connectionString:"postgres://wrong/x"}); db.query("x");}'],
  ['shadowed pg receiver', 'import {Client} from "pg"; const db=new Client({connectionString:"postgres://wrong/x"}); function f(db:any) {db.query("x");}'],
  ['shadowed endpoint parameter', 'const url="https://wrong"; function f(url:string) {fetch(url);}'],
  ['block-local endpoint leakage', '{const url="https://wrong";} fetch(url);'],
])('does not invent an edge for %s', async (_label, source) => { expect(await edges(source)).toEqual([]); });
it('separates same-named endpoints in sibling functions', async () => {
  expect(await edges('function a(){const url="https://first";fetch(url);} function b(){const url="https://second";fetch(url);}')).toEqual(['http|first','http|second']);
});
it('preserves imported aliases and closures over valid resources', async () => {
  expect(await edges('import {Client as Database} from "pg"; const db=new Database({connectionString:"postgres://actual/x"}); function f(){db.query("x");}')).toEqual(['data|actual']);
});
it('preserves an unshadowed global fetch beside a local binding', async () => {
  expect(await edges('function f(fetch:any){fetch("https://wrong");} fetch("https://actual");')).toEqual(['http|actual']);
});
it('preserves a supported fallback with the same endpoint', async () => {
  expect(await edges('fetch(process.env.REMOTE_URL ?? "https://remote");')).toEqual(['http|remote']);
});
it('uses the parsed concatenated URL rather than a URL-looking suffix', async () => {
  expect(await edges('fetch("https://actual/" + "https://wrong/");')).toEqual(['http|actual']);
});
it('rejects an invalid port produced by concatenation', async () => {
  expect(await edges('const suffix="v1"; fetch("http://binary-left:3000" + suffix);')).toEqual([]);
});
it('preserves static URL and path aliases', async () => {
  expect(await edges('const root="https://actual"; const path="/v1"; fetch((root + path));')).toEqual(['http|actual']);
});
it('abstains from arbitrary addition with a URL operand', async () => {
  expect(await edges('fetch(unknownValue + "https://wrong/");')).toEqual([]);
});
it('drops stale provenance after a resource reassignment', async () => {
  expect(await edges('import {Client} from "pg"; let db=new Client({connectionString:"postgres://wrong/x"}); db={query(){}}; db.query("x");')).toEqual([]);
});
it('drops stale endpoint provenance after a compound assignment', async () => {
  expect(await edges('let url="https://wrong"; url += "bad suffix"; fetch(url);')).toEqual([]);
});
it('keeps an unaffected binding beside a reassigned sibling', async () => {
  expect(await edges('import {Client} from "pg"; let db=new Client({connectionString:"postgres://wrong/x"}); const good=new Client({connectionString:"postgres://actual/x"}); db={query(){}}; db.query("x");good.query("x");')).toEqual(['data|actual']);
});
it('conservatively abstains even for a use before reassignment', async () => {
  expect(await edges('let url="https://actual"; fetch(url); url="unknown";')).toEqual([]);
});
it('abstains on cyclic string aliases without recursing forever', async () => {
  expect(await edges('const a=b; const b=a; fetch(a + "/path");')).toEqual([]);
});
it('resolves parentheses within string concatenation', async () => {
  expect(await edges('fetch(("https://actual") + ("/v1"));')).toEqual(['http|actual']);
});
it('preserves the known side of the existing fallback heuristic', async () => {
  expect(await edges('fetch("https://actual" ?? unknownValue);')).toEqual(['http|actual']);
});
it.each([
  ['array assignment', '[url] = incoming;'],
  ['object shorthand assignment', '({url} = incoming);'],
  ['renamed object assignment', '({value: url} = incoming);'],
  ['nested default assignment', '({value: [url = "https://fallback"]} = incoming);'],
  ['object rest assignment', '({...url} = incoming);'],
  ['array rest assignment', '[...url] = incoming;'],
  ['postfix increment', 'url++;'],
  ['prefix decrement', '--url;'],
  ['for-of assignment', 'for (url of incoming) {}'],
  ['for-in assignment', 'for (url in incoming) {}'],
  ['for-of destructuring', 'for ({value: url} of incoming) {}'],
])('invalidates endpoint provenance after %s', async (_label, write) => {
  expect(await edges(`let url:any="https://stale"; ${write} fetch(url);`)).toEqual([]);
});
it('invalidates a database receiver written by destructuring', async () => {
  expect(await edges('import {Client} from "pg"; let db=new Client({connectionString:"postgres://stale/x"}); [db]=incoming; db.query("x");')).toEqual([]);
});
it('keeps reads and property writes from invalidating unrelated endpoint bindings', async () => {
  expect(await edges('const url="https://actual"; const obj:any={}; obj[url]=1; const values=[url]; const copy={url}; +url; fetch(url);')).toEqual(['http|actual']);
});
it('keeps a sibling endpoint when a shadowed loop binding is written', async () => {
  expect(await edges('let url="https://actual"; for(let url of incoming){url++;} fetch(url);')).toEqual(['http|actual']);
});
