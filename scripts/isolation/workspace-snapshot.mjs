import snapshotAssert from 'node:assert/strict';
import { createHash as snapshotHash } from 'node:crypto';

export const snapshotLimits = Object.freeze({ files: 128, fileBytes: 262144, totalBytes: 2097152, packetBytes: 3000000 });
const snapshotDigest = (bytes) => snapshotHash('sha256').update(bytes).digest('hex');
const snapshotKeys = (value, expected) => {
  snapshotAssert.ok(value && typeof value === 'object' && !Array.isArray(value));
  snapshotAssert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'unexpected snapshot fields');
};

export function validateSnapshot(packet) {
  snapshotKeys(packet, ['schema_version', 'files']);
  snapshotAssert.equal(packet.schema_version, '1.0.0-unapproved');
  snapshotAssert.ok(Array.isArray(packet.files) && packet.files.length > 0 && packet.files.length <= snapshotLimits.files);
  const paths = new Set();
  let total = 0, previous = '';
  for (const file of packet.files) {
    snapshotKeys(file, ['path', 'size', 'sha256', 'base64']);
    snapshotAssert.equal(typeof file.path, 'string');
    snapshotAssert.match(file.path, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u, 'unsafe snapshot path');
    snapshotAssert.ok(file.path.length <= 240 && file.path > previous, 'paths must be unique and sorted');
    previous = file.path;
    const parts = file.path.split('/');
    snapshotAssert.ok(parts.length <= 16);
    for (const part of parts) {
      snapshotAssert.ok(!['.', '..'].includes(part) && !part.endsWith('.'), 'ambiguous path segment');
      snapshotAssert.ok(!/^(?:\.git|\.env|\.ssh|\.aws|\.azure|\.config|\.npm|\.yarn|\.pnpm|\.docker|\.netrc|\.pypirc|\.archsync|\.artifacts|coverage$)/iu.test(part), 'reserved or credential path');
      snapshotAssert.ok(!/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part), 'platform-reserved path');
    }
    const key = file.path.toLowerCase();
    snapshotAssert.ok(!paths.has(key), 'case-colliding paths');
    for (let i = 1; i < parts.length; i++) snapshotAssert.ok(!paths.has(parts.slice(0, i).join('/').toLowerCase()), 'file/directory collision');
    for (const existing of paths) snapshotAssert.ok(!existing.startsWith(key + '/'), 'directory/file collision');
    paths.add(key);
    snapshotAssert.ok(Number.isInteger(file.size) && file.size >= 0 && file.size <= snapshotLimits.fileBytes);
    total += file.size;
    snapshotAssert.ok(total <= snapshotLimits.totalBytes);
    snapshotAssert.equal(typeof file.base64, 'string');
    snapshotAssert.ok(file.base64.length <= 4 * Math.ceil(snapshotLimits.fileBytes / 3));
    const bytes = Buffer.from(file.base64, 'base64');
    snapshotAssert.equal(bytes.toString('base64'), file.base64, 'noncanonical base64');
    snapshotAssert.equal(bytes.length, file.size, 'snapshot size mismatch');
    snapshotAssert.equal(snapshotDigest(bytes), file.sha256, 'snapshot digest mismatch');
  }
  const bytes = Buffer.from(JSON.stringify(packet));
  snapshotAssert.ok(bytes.length <= snapshotLimits.packetBytes);
  return { sha256: snapshotDigest(bytes), file_count: packet.files.length, total_bytes: total };
}

// Accept explicit bytes only: never enumerate a user's working directory,
// follow a host symlink, parse an archive, or include credentials implicitly.
export function createSnapshot(files) {
  snapshotAssert.ok(Array.isArray(files) && files.length <= snapshotLimits.files);
  const entries = files.map((file) => {
    snapshotKeys(file, ['path', 'bytes']);
    const { path, bytes } = file;
    snapshotAssert.ok(Buffer.isBuffer(bytes) && bytes.length <= snapshotLimits.fileBytes);
    return { path, size: bytes.length, sha256: snapshotDigest(bytes), base64: bytes.toString('base64') };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const packet = { schema_version: '1.0.0-unapproved', files: entries };
  validateSnapshot(packet);
  return packet;
}
