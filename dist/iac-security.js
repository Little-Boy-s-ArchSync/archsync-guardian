function stableEvidence(evidence) {
    const values = new Map();
    for (const item of evidence) {
        const key = `${item.source}|${item.file}|${item.range.start.offset}|${item.range.end.offset}|${item.detector}`;
        values.set(key, item);
    }
    return [...values.values()].sort((left, right) => {
        const file = left.file.localeCompare(right.file);
        return file || left.range.start.offset - right.range.start.offset;
    });
}
function findingId(rule, subject) {
    return `${rule}:${subject}`.toLowerCase().replaceAll(/[^a-z0-9:|./_-]+/g, "-");
}
function nodesById(graph) {
    return new Map(graph.nodes.map((node) => [node.id, node]));
}
export function evaluateInfrastructureSecurity(graph) {
    const findings = [];
    for (const node of graph.nodes) {
        const publicEvidence = node.observations
            .filter(({ kind, exposure }) => kind === "database" && exposure === "public")
            .flatMap(({ evidence }) => evidence);
        const isDatabase = node.kind === "database" || node.observations.some(({ kind }) => kind === "database");
        if (isDatabase &&
            (node.exposure === "public" || publicEvidence.length > 0)) {
            findings.push({
                id: findingId("IAC-PUBLIC-DATABASE", node.id),
                rule_id: "IAC-PUBLIC-DATABASE",
                severity: "critical",
                message: `Database '${node.id}' is publicly exposed`,
                subject: node.id,
                edge: "",
                evidence: stableEvidence(publicEvidence.length > 0 ? publicEvidence : node.evidence),
            });
        }
        const hasPublicIngress = node.observations.some(({ kind, exposure }) => kind === "ingress" && exposure === "public");
        if ((node.kind === "ingress" && node.exposure === "public" || hasPublicIngress) &&
            !node.approved) {
            findings.push({
                id: findingId("IAC-UNEXPECTED-INGRESS", node.id),
                rule_id: "IAC-UNEXPECTED-INGRESS",
                severity: "high",
                message: `Public ingress '${node.id}' has no explicit architecture approval`,
                subject: node.id,
                edge: "",
                evidence: stableEvidence(node.evidence),
            });
        }
        const dataServiceKind = node.kind === "broker" ||
            node.observations.some(({ kind }) => kind === "broker")
            ? "broker"
            : node.kind === "cache" || node.observations.some(({ kind }) => kind === "cache")
                ? "cache"
                : "";
        if (dataServiceKind !== "" && !node.approved) {
            findings.push({
                id: findingId("IAC-UNAPPROVED-DATA-SERVICE", node.id),
                rule_id: "IAC-UNAPPROVED-DATA-SERVICE",
                severity: "high",
                message: `${dataServiceKind === "broker" ? "Broker" : "Cache"} '${node.id}' has no explicit architecture approval`,
                subject: node.id,
                edge: "",
                evidence: stableEvidence(node.evidence),
            });
        }
    }
    const index = nodesById(graph);
    for (const edge of graph.edges) {
        if (edge.type !== "routes-to" && edge.type !== "connects-to")
            continue;
        if (!edge.resolved)
            continue;
        const from = index.get(edge.from);
        const to = index.get(edge.to);
        if (!from || !to)
            continue;
        if (from.trust_boundary === "unknown" ||
            to.trust_boundary === "unknown" ||
            from.trust_boundary === to.trust_boundary ||
            edge.approved_trust_transition) {
            continue;
        }
        findings.push({
            id: findingId("IAC-TRUST-BOUNDARY", edge.key),
            rule_id: "IAC-TRUST-BOUNDARY",
            severity: "critical",
            message: `Unapproved transition crosses '${from.trust_boundary}' to '${to.trust_boundary}'`,
            subject: edge.from,
            edge: edge.key,
            evidence: stableEvidence([...edge.evidence, ...from.evidence, ...to.evidence]),
        });
    }
    return findings.sort((left, right) => {
        const rule = left.rule_id.localeCompare(right.rule_id);
        return rule || left.id.localeCompare(right.id);
    });
}
//# sourceMappingURL=iac-security.js.map