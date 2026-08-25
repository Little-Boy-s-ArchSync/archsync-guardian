import { describe, expect, it } from "vitest";

import { classifyRootCause } from "./taxonomy.js";

describe("root-cause taxonomy", () => {
  it.each([
    [{ kind: "finding", message: "anything", detector_confidence: 0.7 }, "detector-uncertainty"],
    [{ kind: "invalid", message: "schema version mismatch" }, "configuration-error"],
    [{ kind: "finding", message: "pre-existing baseline drift" }, "stale-baseline"],
    [{ kind: "finding", message: "dependency absent", rule_id: "REQ-1" }, "missing-required-dependency"],
    [{ kind: "architecture-evolution", message: "new cache" }, "new-infrastructure"],
    [{ kind: "violation", message: "crossing", rule_id: "ARCH-001" }, "boundary-bypass"],
    [{ kind: "other", message: "unclassified" }, "unknown"],
  ])("maps %o to %s", (finding, code) => {
    expect(classifyRootCause(finding).code).toBe(code);
  });

  it("covers message-based required and forbidden relationships", () => {
    expect(classifyRootCause({ kind: "finding", message: "missing path" }).code).toBe("missing-required-dependency");
    expect(classifyRootCause({ kind: "finding", message: "forbidden direct dependency" }).code).toBe("boundary-bypass");
    expect(classifyRootCause({ kind: "finding", message: "ok", detector_confidence: 0.99 }).code).toBe("unknown");
  });
});
