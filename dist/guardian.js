import { analyzeConformance, edgeKey, } from "@archsync/core";
import { analyzeTypeScriptRepository } from "./analyzer.js";
import { toArchitectureDocument, } from "./contracts.js";
function sourceEvidenceKey(value) {
    return `${value.file}\0${value.line}\0${value.column}\0${value.detector}`;
}
function uniqueEvidence(values) {
    return [...new Map(values.map((value) => [sourceEvidenceKey(value), value])).values()].sort((a, b) => sourceEvidenceKey(a).localeCompare(sourceEvidenceKey(b)));
}
function evidenceRank(value) {
    const name = value.file.split("/").at(-1);
    if (["app.ts", "server.ts", "service.ts", "worker.ts"].includes(name))
        return 0;
    if (["index.ts", "main.ts"].includes(name))
        return 1;
    return 10;
}
function preferredComponentEvidence(observed, component) {
    const candidates = observed.components[component]?.evidence ?? [];
    const anchors = candidates.filter((candidate) => candidate.detector === "component-root");
    return [...(anchors.length > 0 ? anchors : candidates)].sort((a, b) => evidenceRank(a) - evidenceRank(b) || sourceEvidenceKey(a).localeCompare(sourceEvidenceKey(b))).slice(0, 1);
}
function findingSourceEvidence(finding, observed) {
    const edgeEvidence = finding.edge_key
        ? observed.relationships.find((relationship) => edgeKey(relationship) === finding.edge_key)?.evidence ?? []
        : [];
    if (edgeEvidence.length > 0)
        return uniqueEvidence(edgeEvidence);
    if (finding.component)
        return preferredComponentEvidence(observed, finding.component);
    return preferredComponentEvidence(observed, finding.from);
}
function guardianFinding(finding, observed) {
    return {
        contract_version: "0.1",
        id: finding.id,
        kind: finding.kind,
        severity: finding.severity,
        message: finding.message,
        ...(finding.kind !== "architecture-evolution" ? { rule_id: finding.id } : {}),
        ...(finding.from && finding.to && finding.edge_key && finding.relationship_type
            ? {
                edge: {
                    key: finding.edge_key,
                    from: finding.from,
                    to: finding.to,
                    type: finding.relationship_type,
                },
            }
            : {}),
        ...(finding.component ? { component: finding.component } : {}),
        ...(finding.change ? { change: finding.change } : {}),
        source_evidence: findingSourceEvidence(finding, observed),
        model_evidence: finding.evidence,
    };
}
export function evaluateObservedArchitecture(expected, observed) {
    const observedDocument = toArchitectureDocument(expected, observed);
    const conformance = analyzeConformance(expected, observedDocument);
    return {
        contract_version: "0.1",
        classification: conformance.classification,
        decision: conformance.classification === "no-impact"
            ? "PASS"
            : conformance.classification === "violation"
                ? "BLOCK"
                : "REVIEW",
        summary: conformance.summary,
        findings: conformance.findings.map((finding) => guardianFinding(finding, observed)),
        diff: {
            added_nodes: conformance.diff.addedNodes.map(({ id }) => id),
            removed_nodes: conformance.diff.removedNodes.map(({ id }) => id),
            changed_nodes: conformance.diff.changedNodes.map(({ id }) => id),
            added_edges: conformance.diff.addedEdges.map(({ key }) => key),
            removed_edges: conformance.diff.removedEdges.map(({ key }) => key),
        },
        observed,
    };
}
export async function checkRepository(expected, repositoryPath) {
    return evaluateObservedArchitecture(expected, await analyzeTypeScriptRepository(repositoryPath, expected));
}
export function formatGuardianResult(result) {
    const lines = [
        `${result.classification.toUpperCase()} / ${result.decision} (${result.summary.violations} violations, ${result.summary.evolutions} architecture changes)`,
    ];
    for (const finding of result.findings) {
        const locations = finding.source_evidence.length > 0
            ? finding.source_evidence.map((item) => `${item.file}:${item.line}:${item.column}`).join(", ")
            : `${finding.model_evidence.document}:${finding.model_evidence.path}`;
        lines.push(`- [${finding.id}] ${finding.severity.toUpperCase()} ${finding.kind} at ${locations}: ${finding.message}`);
    }
    if (result.findings.length === 0) {
        lines.push("- No source-level architecture drift detected");
    }
    lines.push(`OBSERVED ${Object.keys(result.observed.components).length} components, ${result.observed.relationships.length} relationships, ${result.observed.metadata.scanned_files} TypeScript files`);
    return lines.join("\n");
}
//# sourceMappingURL=guardian.js.map