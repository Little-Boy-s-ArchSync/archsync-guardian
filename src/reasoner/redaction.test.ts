import { describe, expect, it } from "vitest";

import { redactOutboundEvidence } from "./redaction.js";

describe("provider outbound redaction", () => {
  it("removes credentials, PII, and machine paths before a provider call", () => {
    const result = redactOutboundEvidence([
      { id: "a", kind: "source", text: "Bearer abc.def github_pat_abcdefghijkl api_key=secret-value" },
      { id: "b", kind: "source", text: "member@example.com /Users/member/private/file.ts C:\\Users\\member\\secret.ts" },
      { id: "c", kind: "model", text: "safe structured evidence" },
    ]);
    const serialized = JSON.stringify(result.evidence);
    for (const secret of ["abc.def", "github_pat_abcdefghijkl", "secret-value", "member@example.com", "/Users/member", "C:\\Users\\member"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.events).toEqual([
      { evidence_id: "a", reason: "credential" },
      { evidence_id: "a", reason: "credential" },
      { evidence_id: "a", reason: "credential" },
      { evidence_id: "b", reason: "email" },
      { evidence_id: "b", reason: "absolute-path" },
    ]);
    expect(result.evidence[2]?.text).toBe("safe structured evidence");
  });
});
