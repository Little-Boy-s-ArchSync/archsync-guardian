import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseChangedLines,
  parseNameStatus,
  parseNumStat,
  portablePath,
  repositoryRelativePath,
  sourceComponent,
} from "./phase3-git.js";
import { testArchitecture } from "./test-helpers.js";

describe("Phase 3 Git output parsing", () => {
  it("normalizes platform paths and maps source files to known or inferred components", () => {
    const expected = testArchitecture();

    expect(portablePath(["service", "src", "app.ts"].join(sep))).toBe("service/src/app.ts");
    expect(sourceComponent("service/src/app.ts", expected)).toBe("service");
    expect(sourceComponent("new-worker/src/job.tsx", expected)).toBe("new-worker");
    expect(sourceComponent("new-worker/src/job.mts", expected)).toBe("new-worker");
    expect(sourceComponent("new-worker/src/job.cts", expected)).toBe("new-worker");
    expect(sourceComponent("new-worker/src/types.d.ts", expected)).toBeUndefined();
    expect(sourceComponent("README.md", expected)).toBeUndefined();
  });

  it("strips a repository prefix and rejects paths outside a nested repository", () => {
    expect(repositoryRelativePath("service/src/app.ts", "")).toBe("service/src/app.ts");
    expect(repositoryRelativePath("packages/app/service/src/app.ts", "packages/app")).toBe("service/src/app.ts");
    expect(repositoryRelativePath("packages/other/src/app.ts", "packages/app")).toBeUndefined();
  });

  it("parses added, modified, deleted and renamed statuses while ignoring malformed or out-of-scope rows", () => {
    const files = parseNameStatus([
      "\tmissing-status",
      "M\t",
      "A\tpackages/app/new.ts",
      "M\tpackages/app/modified.ts",
      "D\tpackages/app/deleted.ts",
      "R100\tpackages/app/old.ts\tpackages/app/renamed.ts",
      "R090\toutside.ts\tpackages/app/moved-in.ts",
      "A\tpackages/other/outside.ts",
    ].join("\n"), "packages/app");

    expect([...files.values()]).toEqual([
      expect.objectContaining({ path: "new.ts", status: "added" }),
      expect.objectContaining({ path: "modified.ts", status: "modified" }),
      expect.objectContaining({ path: "deleted.ts", status: "deleted" }),
      expect.objectContaining({ path: "renamed.ts", status: "renamed", previous_path: "old.ts" }),
      expect.objectContaining({ path: "moved-in.ts", status: "renamed" }),
    ]);
    expect(files.get("moved-in.ts")).not.toHaveProperty("previous_path");
  });

  it("adds numstat counts, converts binary markers to zero and ignores unusable rows", () => {
    const files = parseNameStatus(
      "M\tpackages/app/modified.ts\nA\tpackages/app/binary.ts",
      "packages/app",
    );
    parseNumStat([
      "4\t2\tpackages/app/modified.ts",
      "-\t-\tpackages/app/binary.ts",
      "1\t2",
      "1\t1\tpackages/other/outside.ts",
      "1\t1\tpackages/app/unknown.ts",
    ].join("\n"), "packages/app", files);

    expect(files.get("modified.ts")).toMatchObject({ additions: 4, deletions: 2 });
    expect(files.get("binary.ts")).toMatchObject({ additions: 0, deletions: 0 });
  });

  it("parses single-line and multi-line hunks and ignores deletion, malformed and unknown-file hunks", () => {
    const files = parseNameStatus("M\tpackages/app/file.ts", "packages/app");
    parseChangedLines([
      "@@ -1 +1 @@ before-file-header",
      "+++ b/packages/other/outside.ts",
      "@@ -1 +1 @@ outside",
      "+++ /dev/null",
      "@@ -1 +1 @@ deleted",
      "+++ b/packages/app/unknown.ts",
      "@@ -1 +2 @@ unknown-file",
      "+++ b/packages/app/file.ts",
      "@@ malformed",
      "@@ -1 +3 @@ single",
      "@@ -4,2 +8,3 @@ multiple",
      "@@ -9 +12,0 @@ deletion-only",
    ].join("\n"), "packages/app", files);

    expect(files.get("file.ts")?.changed_lines).toEqual([
      { start: 3, end: 3 },
      { start: 8, end: 10 },
    ]);
  });
});
