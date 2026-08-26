import { describe, expect, it } from "vitest";

import { redactDiagnosticPath, redactSensitiveText } from "./privacy.js";

describe("operational privacy", () => {
  it("redacts tokens, credentials, email addresses, and local roots", () => {
    const value = redactSensitiveText(
      "Bearer abc.def_123 api_key=top-secret github_pat_abcdefghijkl /users/student/project user@example.com postgres://user:pass@db/app",
      { home: "/users/student", workspace: "/users/student/project" },
    );

    expect(value).not.toContain("abc.def_123");
    expect(value).not.toContain("top-secret");
    expect(value).not.toContain("github_pat_");
    expect(value).not.toContain("user@example.com");
    expect(value).not.toContain("user:pass@");
    expect(value).toContain("$WORKSPACE");
    expect(value).toContain("postgres://user:[REDACTED]@db/app");
  });

  it("keeps ordinary evidence useful and makes diagnostic paths portable", () => {
    expect(redactSensitiveText("frontend/src/app.ts:7 fetch(serviceUrl)", {
      home: "/home/member",
      workspace: "/home/member/archsync",
    })).toBe("frontend/src/app.ts:7 fetch(serviceUrl)");
    expect(redactDiagnosticPath("/home/member/archsync/report.json", {
      home: "/home/member",
      workspace: "/home/member/archsync",
    })).toBe("$WORKSPACE/report.json");
    expect(redactDiagnosticPath("C:\\Users\\member\\archsync\\report.json", {
      home: "C:\\Users\\member",
      workspace: "C:\\Users\\member\\archsync",
    })).toBe("$WORKSPACE/report.json");
    expect(redactDiagnosticPath("\\\\server\\share\\report.json", {
      workspace: "\\\\server\\share",
    })).toBe("$WORKSPACE/report.json");
    expect(redactDiagnosticPath("reports/report.json", {
      workspace: process.cwd(),
    })).toBe("$WORKSPACE/reports/report.json");
    expect(redactSensitiveText("relative-root/report.json", {
      workspace: "relative-root",
      home: "/",
    })).toBe("$WORKSPACE/report.json");
    expect(redactSensitiveText("/kept/when/root-is-home", {
      home: "/",
      workspace: "/workspace",
    })).toBe("/kept/when/root-is-home");
  });
});
