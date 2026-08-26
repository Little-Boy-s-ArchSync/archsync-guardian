import { infrastructureContractVersion, infrastructureGraphVersion, } from "./iac-contracts.js";
const sourceOrder = { spec: 0, code: 1, iac: 2 };
function normalizedToken(value) {
    return value
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-|-$/g, "");
}
function observationKey(observation) {
    return `${observation.source}:${observation.native_id}`;
}
function stableEvidence(evidence) {
    const unique = new Map();
    for (const item of evidence) {
        const key = [
            item.source,
            item.file,
            item.range.start.offset,
            item.range.end.offset,
            item.detector,
            item.confidence,
        ].join("|");
        unique.set(key, item);
    }
    return [...unique.values()].sort((left, right) => {
        const file = left.file.localeCompare(right.file);
        return file || left.range.start.offset - right.range.start.offset;
    });
}
function canonicalUnknown(observation, prefix = "unknown") {
    const namespace = normalizedToken(observation.namespace) || "global";
    const nativeId = normalizedToken(observation.native_id) || "unnamed";
    const name = normalizedToken(observation.name) || nativeId;
    return `${prefix}:${observation.source_class}:${namespace}/${name}@${nativeId}`;
}
function aliasMatches(observation, rule) {
    const namespace = normalizedToken(observation.namespace);
    const ruleNamespace = normalizedToken(rule.namespace);
    if (ruleNamespace !== "any" && namespace !== ruleNamespace)
        return false;
    const candidates = new Set([observation.name, observation.native_id, ...observation.aliases].map(normalizedToken));
    return rule.aliases.some((alias) => candidates.has(normalizedToken(alias)));
}
export function observationsFromParseResult(result) {
    return result.resources.map((resource) => ({
        source: resource.source,
        source_class: "iac",
        native_id: resource.id,
        name: resource.name,
        namespace: resource.namespace,
        aliases: [...resource.aliases],
        kind: resource.kind,
        exposure: resource.exposure,
        approved: resource.approved,
        trust_boundary: resource.trust_boundary,
        attributes: { ...resource.attributes },
        evidence: [...resource.evidence],
    }));
}
export function mapCrossSourceIdentities(observations, aliasRules = []) {
    const ordered = [...observations].sort((left, right) => observationKey(left).localeCompare(observationKey(right)));
    const byNamespaceName = new Map();
    const byName = new Map();
    for (const observation of ordered) {
        const name = normalizedToken(observation.name);
        const namespace = normalizedToken(observation.namespace) || "global";
        const namespaceName = `${namespace}/${name}`;
        byNamespaceName.set(namespaceName, [...(byNamespaceName.get(namespaceName) ?? []), observation]);
        byName.set(name, [...(byName.get(name) ?? []), observation]);
    }
    const resolutions = [];
    for (const observation of ordered) {
        const matches = aliasRules
            .filter((rule) => aliasMatches(observation, rule))
            .sort((left, right) => left.canonical_id.localeCompare(right.canonical_id));
        const evidence = stableEvidence(observation.evidence);
        if (matches.length === 1) {
            resolutions.push({
                observation_key: observationKey(observation),
                canonical_id: matches[0].canonical_id,
                method: "explicit-alias",
                confidence: 1,
                evidence,
            });
            continue;
        }
        if (matches.length > 1) {
            resolutions.push({
                observation_key: observationKey(observation),
                canonical_id: canonicalUnknown(observation, "ambiguous"),
                method: "ambiguous",
                confidence: 0,
                evidence,
            });
            continue;
        }
        const name = normalizedToken(observation.name);
        const namespace = normalizedToken(observation.namespace) || "global";
        const exact = byNamespaceName.get(`${namespace}/${name}`);
        const exactSources = new Set(exact.map((candidate) => candidate.source_class));
        if (exact.length > 1 && exactSources.size > 1) {
            resolutions.push({
                observation_key: observationKey(observation),
                canonical_id: `${namespace}/${name}`,
                method: "namespace-and-name",
                confidence: 0.99,
                evidence,
            });
            continue;
        }
        const sameName = byName.get(name);
        const knownNamespaces = new Set(sameName
            .map((candidate) => normalizedToken(candidate.namespace))
            .filter((namespace) => namespace !== "" && namespace !== "unknown"));
        const sameNameSources = new Set(sameName.map((candidate) => candidate.source_class));
        const hasUnscopedName = sameName.some((candidate) => normalizedToken(candidate.namespace) === "" || candidate.namespace === "unknown");
        if (sameName.length > 1 &&
            sameNameSources.size > 1 &&
            knownNamespaces.size === 1 &&
            hasUnscopedName) {
            resolutions.push({
                observation_key: observationKey(observation),
                canonical_id: `${[...knownNamespaces][0]}/${name}`,
                method: "name-only",
                confidence: 0.75,
                evidence,
            });
            continue;
        }
        if (sameName.length > 1 && knownNamespaces.size > 1) {
            resolutions.push({
                observation_key: observationKey(observation),
                canonical_id: canonicalUnknown(observation, "ambiguous"),
                method: "ambiguous",
                confidence: 0,
                evidence,
            });
            continue;
        }
        resolutions.push({
            observation_key: observationKey(observation),
            canonical_id: canonicalUnknown(observation),
            method: "unknown",
            confidence: 0.25,
            evidence,
        });
    }
    return {
        contract_version: infrastructureContractVersion,
        resolutions,
        unknowns: resolutions.filter(({ method }) => method === "unknown" || method === "ambiguous"),
    };
}
function preferredObservation(observations) {
    return [...observations].sort((left, right) => {
        const source = sourceOrder[left.source_class] - sourceOrder[right.source_class];
        return source || observationKey(left).localeCompare(observationKey(right));
    })[0];
}
function preferredKind(observations) {
    const concrete = observations.filter(({ kind }) => kind !== "unknown");
    return (concrete.length > 0 ? preferredObservation(concrete) : preferredObservation(observations)).kind;
}
function preferredExposure(observations) {
    const concrete = observations.filter(({ exposure }) => exposure !== "unknown");
    return (concrete.length > 0 ? preferredObservation(concrete) : preferredObservation(observations)).exposure;
}
function preferredBoundary(observations) {
    const concrete = observations.filter(({ trust_boundary }) => trust_boundary !== "unknown");
    return (concrete.length > 0 ? preferredObservation(concrete) : preferredObservation(observations))
        .trust_boundary;
}
function normalizedNode(id, observations) {
    const ordered = [...observations].sort((left, right) => observationKey(left).localeCompare(observationKey(right)));
    const aliases = new Set();
    for (const observation of ordered) {
        aliases.add(observation.name);
        for (const alias of observation.aliases)
            aliases.add(alias);
    }
    return {
        id,
        kind: preferredKind(ordered),
        namespace: preferredObservation(ordered).namespace,
        aliases: [...aliases].sort(),
        exposure: preferredExposure(ordered),
        approved: ordered.some(({ approved }) => approved),
        trust_boundary: preferredBoundary(ordered),
        sources: [...new Set(ordered.map(({ source_class }) => source_class))].sort((left, right) => sourceOrder[left] - sourceOrder[right]),
        observations: ordered,
        evidence: stableEvidence(ordered.flatMap(({ evidence }) => evidence)),
    };
}
function mappedEndpoint(nativeId, resolutionByObservation) {
    const matches = [...resolutionByObservation.entries()]
        .filter(([key]) => key.endsWith(`:${nativeId}`))
        .map(([, resolution]) => resolution.canonical_id)
        .sort();
    return matches[0] ?? `unmapped:${nativeId}`;
}
function normalizedEdges(references, resolutions) {
    const resolutionMap = new Map(resolutions.map((resolution) => [resolution.observation_key, resolution]));
    const accumulators = new Map();
    for (const reference of references) {
        const from = mappedEndpoint(reference.from, resolutionMap);
        const to = mappedEndpoint(reference.to, resolutionMap);
        const key = `${from}|${reference.type}|${to}`;
        const existing = accumulators.get(key);
        if (existing) {
            existing.resolved ||= reference.resolved;
            existing.approved_trust_transition ||= reference.approved_trust_transition;
            existing.sources = [...new Set([...existing.sources, reference.source])].sort();
            existing.evidence = stableEvidence([...existing.evidence, ...reference.evidence]);
        }
        else {
            accumulators.set(key, {
                key,
                from,
                to,
                type: reference.type,
                resolved: reference.resolved,
                approved_trust_transition: reference.approved_trust_transition,
                sources: [reference.source],
                evidence: stableEvidence(reference.evidence),
            });
        }
    }
    return [...accumulators.values()].sort((left, right) => left.key.localeCompare(right.key));
}
export function buildNormalizedInfrastructureGraph(observations, references, diagnostics = [], aliasRules = []) {
    const identityMap = mapCrossSourceIdentities(observations, aliasRules);
    const resolutionByKey = new Map(identityMap.resolutions.map((resolution) => [resolution.observation_key, resolution]));
    const grouped = new Map();
    for (const observation of observations) {
        const canonical = resolutionByKey.get(observationKey(observation)).canonical_id;
        grouped.set(canonical, [...(grouped.get(canonical) ?? []), observation]);
    }
    const nodes = [...grouped.entries()]
        .map(([id, values]) => normalizedNode(id, values))
        .sort((left, right) => left.id.localeCompare(right.id));
    return {
        version: infrastructureGraphVersion,
        identity_contract_version: infrastructureContractVersion,
        nodes,
        edges: normalizedEdges(references, identityMap.resolutions),
        diagnostics: [...diagnostics].sort((left, right) => {
            const file = left.evidence.file.localeCompare(right.evidence.file);
            return file || left.evidence.range.start.offset - right.evidence.range.start.offset;
        }),
    };
}
function propertyValue(observation, property, canonicalId) {
    if (property === "identity")
        return canonicalId;
    if (property === "kind")
        return observation.kind;
    if (property === "exposure")
        return observation.exposure;
    return observation.trust_boundary;
}
export function buildCrossSourceEvidenceClaims(graph) {
    const properties = ["identity", "kind", "exposure", "trust-boundary"];
    const required = ["spec", "code", "iac"];
    const claims = [];
    for (const node of graph.nodes) {
        for (const property of properties) {
            const grouped = new Map();
            for (const observation of node.observations) {
                const value = propertyValue(observation, property, node.id);
                const key = `${observation.source_class}|${value}`;
                const current = grouped.get(key);
                grouped.set(key, {
                    source: observation.source_class,
                    value,
                    evidence: stableEvidence([...(current?.evidence ?? []), ...observation.evidence]),
                });
            }
            const values = [...grouped.values()].sort((left, right) => {
                const source = sourceOrder[left.source] - sourceOrder[right.source];
                return source || left.value.localeCompare(right.value);
            });
            const present = new Set(values.map(({ source }) => source));
            claims.push({
                id: `claim:${node.id}:${property}`,
                subject: node.id,
                property,
                values,
                missing_sources: required.filter((source) => !present.has(source)),
                evidence: stableEvidence(values.flatMap(({ evidence }) => evidence)),
            });
        }
    }
    return claims.sort((left, right) => left.id.localeCompare(right.id));
}
function classificationFor(claim) {
    if (claim.subject.startsWith("unknown:") || claim.subject.startsWith("ambiguous:")) {
        return {
            classification: "identity-uncertain",
            confidence: 0.25,
            reason: "The observation could not be joined to a stable cross-source identity",
        };
    }
    const values = new Set(claim.values.map(({ value }) => value));
    if (values.size > 1) {
        return {
            classification: "contradiction",
            confidence: 1,
            reason: `Sources report ${values.size} distinct values for ${claim.property}`,
        };
    }
    if (claim.missing_sources.length > 0) {
        return {
            classification: "missing-source",
            confidence: Number(((3 - claim.missing_sources.length) / 3).toFixed(2)),
            reason: `Missing ${claim.missing_sources.join(", ")} evidence`,
        };
    }
    return {
        classification: "aligned",
        confidence: 1,
        reason: "Spec, code and IaC report the same value",
    };
}
export function classifyEvidenceClaim(claim) {
    return { ...claim, ...classificationFor(claim) };
}
export function classifyEvidenceClaims(claims) {
    return [...claims]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(classifyEvidenceClaim);
}
//# sourceMappingURL=iac-normalize.js.map