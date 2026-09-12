import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const upstreamProfile = Object.freeze({
  commit: '61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31',
  sha256: 'de1f5327ca42b80be02daba8d39c0d087a530dc3c16f7028170fe068c9d66e61',
  url: 'https://github.com/moby/profiles/blob/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31/seccomp/default.json',
});
const denied = new Set(['socket', 'socketcall', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4', 'io_uring_setup', 'io_uring_enter', 'io_uring_register']);

// Start with the complete pinned upstream deny-by-default policy. Only remove
// permissions; keep its namespace, capability, architecture and clone rules.
export function networkProfile() {
  const bytes = readFileSync(new URL('vendor/moby-default-seccomp.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), upstreamProfile.sha256);
  const profile = JSON.parse(bytes);
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(profile.defaultErrnoRet, 1);
  profile.syscalls = profile.syscalls.map((rule) => ({ ...rule, names: rule.names.filter((name) => !denied.has(name)) })).filter((rule) => rule.names.length);
  // libuv uses AF_UNIX socketpair for subprocess stdio. These private, already
  // connected pairs cannot bind/listen/connect to a pathname or IP endpoint.
  profile.syscalls.push({ names: ['socketpair'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 1, op: 'SCMP_CMP_EQ' }] });
  return profile;
}

export const networkProfileSha256 = createHash('sha256').update(JSON.stringify(networkProfile())).digest('hex');

export function validateNetworkSecurityOptions(options) {
  assert.equal(options.length, 2, 'unexpected security option');
  assert.ok(options.includes('no-new-privileges:true'));
  const seccomp = options.find((value) => value.startsWith('seccomp='));
  assert.ok(seccomp, 'network seccomp profile missing');
  assert.deepEqual(JSON.parse(seccomp.slice(8)), networkProfile(), 'container seccomp differs from the pinned restricted profile');
}
