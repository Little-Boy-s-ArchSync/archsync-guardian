import { describe, expect, it } from "vitest";

import { redactOutboundContext, redactOutboundEvidence, redactProviderDiagnostic } from "./redaction.js";

describe("provider outbound redaction", () => {
  it("removes credentials, PII, and machine paths before a provider call", () => {
    const result = redactOutboundEvidence([
      { id: "a", kind: "source", text: "Bearer abc.def github_pat_abcdefghijkl api_key=secret-value" },
      {
        id: "b",
        kind: "source",
        text: "member@example.com /Users/member/private/file.ts C:\\Users\\member\\secret.ts",
        file: "/home/member/private/source.ts",
      },
      { id: "c", kind: "model", text: "safe structured evidence" },
    ]);
    const serialized = JSON.stringify(result.evidence);
    for (const secret of ["abc.def", "github_pat_abcdefghijkl", "secret-value", "member@example.com", "/Users/member", "C:\\Users\\member"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.events).toEqual([
      { evidence_id: "a", field: "text", reason: "credential" },
      { evidence_id: "a", field: "text", reason: "credential" },
      { evidence_id: "a", field: "text", reason: "credential" },
      { evidence_id: "b", field: "text", reason: "email" },
      { evidence_id: "b", field: "text", reason: "absolute-path" },
      { evidence_id: "b", field: "file", reason: "absolute-path" },
    ]);
    expect(result.evidence[2]?.text).toBe("safe structured evidence");
  });

  it("redacts finding messages, evidence paths, and provider diagnostics", () => {
    const result = redactOutboundContext(
      {
        id: "ARCH-001",
        kind: "deny-rule",
        decision: "BLOCK",
        message: "Bearer private.token /Users/member/private/window.ts",
      },
      [{ id: "safe", kind: "finding", text: "ordinary", file: "src/app.ts" }],
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private.token");
    expect(serialized).not.toContain("/Users/member/private");
    expect(result.events).toEqual([
      { evidence_id: "finding:ARCH-001", field: "message", reason: "credential" },
      { evidence_id: "finding:ARCH-001", field: "message", reason: "absolute-path" },
    ]);
    expect(redactProviderDiagnostic("api_key=private-value /home/member/raw.json"))
      .toBe("api_key=[REDACTED] [REDACTED_PATH]");
  });
});
