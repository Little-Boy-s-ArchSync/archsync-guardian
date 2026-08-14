import type {
  ArchitectureComponent,
  ArchitectureDocument,
  ArchitectureRelationship,
  ConformanceClassification,
  ConformanceEvidence,
  ConformanceFinding,
  ConformanceSummary,
  Severity,
} from "@archsync/core";

export const observedGraphVersion = "0.1" as const;
export const findingContractVersion = "0.1" as const;

export type DetectorId =
  | "component-root"
  | "typescript-fetch"
  | "typescript-pg"
  | "typescript-redis"
  | "typescript-amqp-publish"
  | "typescript-amqp-consume";

export interface SourceEvidence {
  kind: "source-location";
  file: string;
  line: number;
  column: number;
  snippet: string;
  detector: DetectorId;
  confidence: number;
}

export interface ObservedComponent {
  component: ArchitectureComponent;
  evidence: SourceEvidence[];
}

export interface ObservedRelationship extends ArchitectureRelationship {
  evidence: SourceEvidence[];
}

export interface ObservedArchitecture {
  version: typeof observedGraphVersion;
  analyzer: {
    id: "archsync-typescript";
    version: "0.2";
    stack: "typescript-node";
  };
  metadata: {
    name: string;
    scanned_files: number;
  };
  components: Record<string, ObservedComponent>;
  relationships: ObservedRelationship[];
}

export interface GuardianFinding {
  contract_version: typeof findingContractVersion;
  id: string;
  kind: ConformanceFinding["kind"];
  severity: Severity;
  message: string;
  rule_id?: string;
  edge?: {
    key: string;
    from: string;
    to: string;
    type: string;
  };
  component?: string;
  change?: "added" | "removed" | "changed";
  source_evidence: SourceEvidence[];
  model_evidence: ConformanceEvidence;
}

export interface GuardianResult {
  contract_version: "0.1";
  classification: ConformanceClassification;
  decision: "PASS" | "BLOCK" | "REVIEW";
  summary: ConformanceSummary;
  findings: GuardianFinding[];
  diff: {
    added_nodes: string[];
    removed_nodes: string[];
    changed_nodes: string[];
    added_edges: string[];
    removed_edges: string[];
  };
  observed: ObservedArchitecture;
}

export function toArchitectureDocument(
  expected: ArchitectureDocument,
  observed: ObservedArchitecture,
): ArchitectureDocument {
  return {
    version: expected.version,
    metadata: { name: observed.metadata.name },
    components: Object.fromEntries(
      Object.entries(observed.components).map(([id, value]) => [id, value.component]),
    ),
    relationships: observed.relationships.map(({ evidence: _evidence, ...relationship }) => relationship),
  };
}
