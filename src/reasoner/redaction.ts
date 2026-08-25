import type { ReasonerEvidence } from "./contracts.js";

export interface RedactionEvent {
  evidence_id: string;
  reason: "credential" | "email" | "absolute-path";
}

export interface RedactedEvidence {
  evidence: ReasonerEvidence[];
  events: RedactionEvent[];
}

const replacements: readonly [RegExp, string, RedactionEvent["reason"]][] = [
  [/(?:github_pat_|gh[opusr]_|glpat-)[A-Za-z0-9_-]{8,}/giu, "[REDACTED_TOKEN]", "credential"],
  [/(\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s,"']+/giu, "$1[REDACTED]", "credential"],
  [/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, "$1[REDACTED]", "credential"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]", "email"],
  [/(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s"']+/gu, "[REDACTED_PATH]", "absolute-path"],
];

export function redactOutboundEvidence(input: readonly ReasonerEvidence[]): RedactedEvidence {
  const events: RedactionEvent[] = [];
  const evidence = input.map((item) => {
    let text = item.text;
    for (const [pattern, replacement, reason] of replacements) {
      const next = text.replace(pattern, replacement);
      if (next !== text) events.push({ evidence_id: item.id, reason });
      text = next;
    }
    return { ...item, text };
  });
  return { evidence, events };
}
