import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { redactProviderDiagnostic } from "../dist/reasoner/redaction.js";

export const providerEvidenceLimits = Object.freeze({
  attempts: 8,
  requestBytes: 262_144,
  responseBytes: 1_048_576,
  totalResponseBytes: 4_194_304,
  packetBytes: 6_500_000,
  diagnosticLineCharacters: 4_096,
});

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const failureKinds = new Set(["timeout", "cancelled", "rate-limit", "quota", "budget", "invalid-response", "provider"]);
const sensitiveKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)$/iu;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid provider evidence: ${message}`);
}

function keys(value, expected, field) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  requireValue(Object.getPrototypeOf(value) === Object.prototype, `${field} must be a plain object`);
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), `${field} has unexpected or missing fields`);
}

function safeText(value, field, maximum = 256) {
  requireValue(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum, `${field} must be bounded text`);
  requireValue(!/[\u0000-\u001f\u007f]/u.test(value), `${field} contains control characters`);
  requireValue(redactProviderDiagnostic(value) === value, `${field} requires redaction`);
  return value;
}

function timestamp(value, field) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value), `${field} must be an explicit UTC timestamp`);
  requireValue(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `${field} is not a calendar timestamp`);
  return value;
}

function inspectJson(value, depth = 0) {
  requireValue(depth <= 32, "content exceeds the JSON depth limit");
  if (typeof value === "string") {
    checkContentRedaction(value);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      checkContentRedaction(key);
      requireValue(!sensitiveKey.test(key) || child === "[REDACTED]", "content contains a credential field");
      inspectJson(child, depth + 1);
    }
  }
}

function checkContentRedaction(text) {
  // Every existing diagnostic pattern needs one of these markers. Skip the
  // regex scanner for long marker-free strings; bound all other physical lines
  // before its email pattern can perform quadratic work on adversarial input.
  if (!/[@:=/\\_-]|\bBearer\s/iu.test(text)) return;
  requireValue(text.split(/\r?\n/u).every((line) => line.length <= providerEvidenceLimits.diagnosticLineCharacters), "content exceeds the redaction line limit");
  requireValue(redactProviderDiagnostic(text) === text, "content requires redaction");
}

function artifact(value, maximum, field) {
  requireValue(Buffer.isBuffer(value) && value.length <= maximum, `${field} must be bounded bytes`);
  // Snapshot caller-owned buffers before the first filesystem await.
  const bytes = Buffer.from(value);
  const text = bytes.toString("utf8");
  requireValue(Buffer.from(text, "utf8").equals(bytes), `${field} must be valid UTF-8`);
  requireValue(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), `${field} contains control bytes`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* Non-JSON text still receives the diagnostic check. */ }
  if (parsed !== undefined) inspectJson(parsed);
  else checkContentRedaction(text);
  return { bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString("base64") };
}

function usage(value) {
  if (value === null) return null;
  keys(value, ["input_tokens", "output_tokens", "cost_usd"], "usage");
  requireValue(Number.isSafeInteger(value.input_tokens) && value.input_tokens >= 0, "input usage is invalid");
  requireValue(Number.isSafeInteger(value.output_tokens) && value.output_tokens >= 0, "output usage is invalid");
  requireValue(Number.isFinite(value.cost_usd) && value.cost_usd >= 0, "cost is invalid");
  return { input_tokens: value.input_tokens, output_tokens: value.output_tokens, cost_usd: value.cost_usd };
}

/** Offline serialization only. Supplied metadata and outcomes are never authenticated or approved. */
export function createProviderEvidencePacket(input) {
  keys(input, ["run_id", "origin", "provider", "model", "model_version", "prompt_version", "started_at", "finished_at", "outcome", "request", "attempts"], "run");
  requireValue(typeof input.run_id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.run_id), "run_id must be a portable identifier");
  requireValue(["synthetic", "caller-supplied-unverified"].includes(input.origin), "origin must be explicit");
  requireValue(["success", "failed"].includes(input.outcome), "outcome must be explicit");
  const startedAt = timestamp(input.started_at, "started_at");
  const finishedAt = timestamp(input.finished_at, "finished_at");
  requireValue(finishedAt >= startedAt, "run timestamps are reversed");
  requireValue(Array.isArray(input.attempts) && input.attempts.length > 0 && input.attempts.length <= providerEvidenceLimits.attempts, "attempt count is invalid");
  let priorFinish = startedAt;
  let responseBytes = 0;
  const attempts = input.attempts.map((attempt, index) => {
    keys(attempt, ["attempt", "started_at", "finished_at", "outcome", "response", "failure", "usage"], "attempt");
    requireValue(attempt.attempt === index + 1, "attempt sequence is incomplete or duplicated");
    const start = timestamp(attempt.started_at, "attempt started_at");
    const finish = timestamp(attempt.finished_at, "attempt finished_at");
    requireValue(start >= priorFinish && finish >= start && finish <= finishedAt, "attempt timestamps do not match the run");
    priorFinish = finish;
    requireValue(["success", "failed"].includes(attempt.outcome), "attempt outcome must be explicit");
    requireValue(index === input.attempts.length - 1 || attempt.outcome === "failed", "a successful attempt cannot be retried");
    const response = attempt.response === null ? null : artifact(attempt.response, providerEvidenceLimits.responseBytes, "response");
    responseBytes += response?.bytes ?? 0;
    const measuredUsage = usage(attempt.usage);
    let failure = null;
    if (attempt.outcome === "failed") {
      keys(attempt.failure, ["kind", "message"], "failure");
      requireValue(failureKinds.has(attempt.failure.kind), "failure kind is invalid");
      failure = { kind: attempt.failure.kind, message: safeText(attempt.failure.message, "failure message", 2_048) };
    } else {
      requireValue(attempt.failure === null && response !== null && measuredUsage !== null, "successful attempt requires response and measured usage without a failure");
    }
    return { attempt: index + 1, started_at: start, finished_at: finish, outcome: attempt.outcome, response, failure, usage: measuredUsage };
  });
  requireValue(responseBytes <= providerEvidenceLimits.totalResponseBytes, "total response bytes exceed the limit");
  requireValue(input.outcome === attempts.at(-1).outcome, "run outcome disagrees with the final attempt");
  const packet = {
    schema_version: "1.0.0-preparatory",
    acceptance: "UNREVIEWED_PROVIDER_EVIDENCE",
    run_id: input.run_id,
    origin: input.origin,
    provider: safeText(input.provider, "provider"),
    model: safeText(input.model, "model"),
    model_version: safeText(input.model_version, "model_version"),
    prompt_version: safeText(input.prompt_version, "prompt_version"),
    started_at: startedAt,
    finished_at: finishedAt,
    outcome: input.outcome,
    request: artifact(input.request, providerEvidenceLimits.requestBytes, "request"),
    attempts,
  };
  const bytes = encode(packet);
  requireValue(bytes.length <= providerEvidenceLimits.packetBytes, "packet bytes exceed the limit");
  return { bytes, sha256: digest(bytes) };
}

function decodeArtifact(value, maximum) {
  keys(value, ["bytes", "sha256", "base64"], "artifact");
  requireValue(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= maximum, "artifact size is invalid");
  requireValue(typeof value.base64 === "string" && value.base64.length <= Math.ceil(maximum / 3) * 4, "artifact encoding exceeds the limit");
  const bytes = Buffer.from(value.base64, "base64");
  requireValue(bytes.toString("base64") === value.base64 && bytes.length === value.bytes && digest(bytes) === value.sha256, "artifact bytes or digest do not match");
  return bytes;
}

/** The expected digest must come from a separately retained trusted record, not this file. */
export function verifyProviderEvidencePacket(bytes, expectedSha256) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= providerEvidenceLimits.packetBytes, "packet must be bounded bytes");
  requireValue(typeof expectedSha256 === "string" && /^[0-9a-f]{64}$/u.test(expectedSha256) && digest(bytes) === expectedSha256, "packet digest does not match");
  let packet;
  try { packet = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid provider evidence: packet is not JSON"); }
  keys(packet, ["schema_version", "acceptance", "run_id", "origin", "provider", "model", "model_version", "prompt_version", "started_at", "finished_at", "outcome", "request", "attempts"], "packet");
  requireValue(packet.schema_version === "1.0.0-preparatory" && packet.acceptance === "UNREVIEWED_PROVIDER_EVIDENCE", "packet schema or acceptance is invalid");
  requireValue(Array.isArray(packet.attempts) && packet.attempts.length <= providerEvidenceLimits.attempts, "packet attempt count is invalid");
  const { schema_version, acceptance, ...input } = packet;
  input.request = decodeArtifact(input.request, providerEvidenceLimits.requestBytes);
  input.attempts = input.attempts.map((attempt) => {
    keys(attempt, ["attempt", "started_at", "finished_at", "outcome", "response", "failure", "usage"], "attempt");
    return { ...attempt, response: attempt.response === null ? null : decodeArtifact(attempt.response, providerEvidenceLimits.responseBytes) };
  });
  const regenerated = createProviderEvidencePacket(input);
  requireValue(regenerated.bytes.equals(bytes), "packet is not canonical");
  return { run_id: packet.run_id, origin: packet.origin, outcome: packet.outcome, attempts: packet.attempts.length, sha256: regenerated.sha256, acceptance };
}

/** POSIX-only, caller-selected private storage. No retention authority or provider execution is supplied. */
export async function persistProviderEvidence(directory, input) {
  const packet = createProviderEvidencePacket(input);
  const runId = input.run_id;
  requireValue(process.platform !== "win32", "private storage requires POSIX ownership and permissions");
  const root = resolve(directory);
  requireValue(await realpath(root) === root, "storage path must not contain symlink aliases");
  const before = await lstat(root);
  requireValue(before.isDirectory() && before.uid === process.getuid() && (before.mode & 0o077) === 0, "storage must be an owner-only directory");
  const temporary = join(root, `.provider-evidence-${randomUUID()}.tmp`);
  const destination = join(root, `${runId}.provider-evidence.json`);
  let handle;
  let created = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(packet.bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.close();
    handle = undefined;
    const after = await lstat(root);
    requireValue(after.dev === before.dev && after.ino === before.ino && !after.isSymbolicLink() && after.uid === before.uid && (after.mode & 0o077) === 0, "storage changed during the write");
    // link is an atomic no-replace publication; no reader sees partially written final bytes.
    await link(temporary, destination);
    return { path: destination, sha256: packet.sha256, bytes: packet.bytes.length, acceptance: "UNREVIEWED_PROVIDER_EVIDENCE" };
  } finally {
    await handle?.close();
    if (created) await unlink(temporary);
  }
}
