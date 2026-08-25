import { describe, expect, it } from "vitest";

import {
  redactOutboundContext,
  redactOutboundEvidence,
  redactProviderArtifactPath,
  redactProviderDiagnostic,
} from "./redaction.js";

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
      { id: "d", kind: "source", text: "network path", file: "\\\\server\\share\\private.ts" },
      { id: "e", kind: "source", text: "Windows path", file: "C:\\private\\source.ts" },
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
      { evidence_id: "b", field: "text", reason: "absolute-path" },
      { evidence_id: "b", field: "file", reason: "absolute-path" },
      { evidence_id: "d", field: "file", reason: "absolute-path" },
      { evidence_id: "e", field: "file", reason: "absolute-path" },
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
    expect(redactProviderArtifactPath("/opt/service/private/raw.json")).toBe("[REDACTED_PATH]");
    expect(redactProviderArtifactPath("raw/run.json")).toBe("raw/run.json");
  });

  it("redacts every untrusted string field and portable path without leaking through events", () => {
    const result = redactOutboundContext(
      {
        id: "api_key=id-leak-value",
        kind: "secret=kind-leak-value",
        decision: "BLOCK",
        message: "inspect /opt/private/source.ts and C:/private/source.ts",
      },
      [
        {
          id: "Bearer evidence-id-leak",
          kind: "source",
          text: "read /tmp/private/source.ts and \\\\server\\share\\private.ts",
          file: "/var/private/source.ts",
          rule_id: "auth_token=rule-leak-value",
        },
        {
          id: "[REDACTED_EVIDENCE_ID_1]",
          kind: "finding",
          text: "https://member:url-leak-value@provider.invalid/v1 remains a URL after credential removal",
        },
      ],
    );

    expect(result.finding.id).toBe("[REDACTED_FINDING_ID]");
    expect(result.evidence[0]?.id).toBe("[REDACTED_EVIDENCE_ID_2]");
    expect(result.evidence[1]?.id).toBe("[REDACTED_EVIDENCE_ID_1]");
    expect(result.evidence[0]?.file).toBe("[REDACTED_PATH]");
    const serialized = JSON.stringify(result);
    for (const leaked of [
      "id-leak-value",
      "kind-leak-value",
      "evidence-id-leak",
      "rule-leak-value",
      "url-leak-value",
      "/opt/private",
      "C:/private",
      "/tmp/private",
      "\\\\server\\share",
      "/var/private",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(result.events.length).toBeGreaterThan(0);
    expect(new Set(result.events.map(({ field }) => field))).toEqual(
      new Set(["id", "kind", "message", "text", "file", "rule_id"]),
    );
    expect(redactProviderDiagnostic("failed at /var/private/error.txt and \\\\server\\share\\error.txt"))
      .toBe("failed at [REDACTED_PATH] and [REDACTED_PATH]");
  });
});
