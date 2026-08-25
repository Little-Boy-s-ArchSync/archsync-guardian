import { LineCounter, parseAllDocuments } from "yaml";
function portablePath(value) {
    return value.replaceAll("\\", "/");
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function stringRecord(value) {
    return Object.fromEntries(Object.entries(asRecord(value))
        .filter((entry) => typeof entry[1] === "string")
        .sort(([left], [right]) => left.localeCompare(right)));
}
function textPosition(lineCounter, offset) {
    const position = lineCounter.linePos(offset);
    return { line: position.line, column: position.col, offset };
}
function evidenceAt(source, file, lineCounter, start, end, detector, confidence) {
    return {
        source: "kubernetes",
        file: portablePath(file),
        range: {
            start: textPosition(lineCounter, start),
            end: textPosition(lineCounter, end),
        },
        snippet: source.slice(start, end).trim(),
        detector,
        confidence,
    };
}
function metadataFor(value) {
    const metadata = asRecord(value.metadata);
    return {
        name: typeof metadata.name === "string" ? metadata.name : "",
        namespace: typeof metadata.namespace === "string" ? metadata.namespace : "default",
        labels: stringRecord(metadata.labels),
        annotations: stringRecord(metadata.annotations),
    };
}
function approved(metadata) {
    return metadata.annotations["archsync.io/approved"] === "true";
}
function trustBoundary(metadata) {
    return metadata.annotations["archsync.io/trust-boundary"] ?? "unknown";
}
function internalLoadBalancer(metadata) {
    return Object.entries(metadata.annotations).some(([key, value]) => key.toLowerCase().includes("internal") && value.toLowerCase() !== "false");
}
function kindFor(nativeKind) {
    if (nativeKind === "Deployment")
        return "workload";
    if (nativeKind === "Service")
        return "service";
    if (nativeKind === "Ingress")
        return "ingress";
    if (nativeKind === "ConfigMap")
        return "configuration";
    return "unknown";
}
function exposureFor(nativeKind, value, metadata) {
    if (nativeKind === "Ingress")
        return internalLoadBalancer(metadata) ? "internal" : "public";
    if (nativeKind !== "Service")
        return "internal";
    const type = asRecord(value.spec).type;
    if (type === "LoadBalancer" || type === "NodePort") {
        return internalLoadBalancer(metadata) ? "internal" : "public";
    }
    return type === "ExternalName" ? "public" : "internal";
}
function deploymentDetails(value) {
    const spec = asRecord(value.spec);
    const template = asRecord(spec.template);
    const podSpec = asRecord(template.spec);
    const labels = stringRecord(asRecord(template.metadata).labels);
    const configMaps = new Set();
    for (const container of asArray(podSpec.containers)) {
        const containerRecord = asRecord(container);
        for (const envFrom of asArray(containerRecord.envFrom)) {
            const name = asRecord(asRecord(envFrom).configMapRef).name;
            if (typeof name === "string")
                configMaps.add(name);
        }
        for (const env of asArray(containerRecord.env)) {
            const name = asRecord(asRecord(asRecord(env).valueFrom).configMapKeyRef).name;
            if (typeof name === "string")
                configMaps.add(name);
        }
    }
    for (const volume of asArray(podSpec.volumes)) {
        const name = asRecord(asRecord(volume).configMap).name;
        if (typeof name === "string")
            configMaps.add(name);
    }
    const attributes = {};
    if (typeof spec.replicas === "number")
        attributes.replicas = spec.replicas;
    return { labels, configMaps: [...configMaps].sort(), attributes };
}
function serviceDetails(value) {
    const spec = asRecord(value.spec);
    const selector = stringRecord(spec.selector);
    const attributes = {};
    if (typeof spec.type === "string")
        attributes.service_type = spec.type;
    if (Object.keys(selector).length > 0)
        attributes.selector = JSON.stringify(selector);
    return { selector, attributes };
}
function ingressRoutes(value) {
    const routes = new Set();
    const spec = asRecord(value.spec);
    const defaultName = asRecord(asRecord(spec.defaultBackend).service).name;
    if (typeof defaultName === "string")
        routes.add(defaultName);
    for (const rule of asArray(spec.rules)) {
        for (const path of asArray(asRecord(asRecord(rule).http).paths)) {
            const name = asRecord(asRecord(asRecord(path).backend).service).name;
            if (typeof name === "string")
                routes.add(name);
        }
    }
    return [...routes].sort();
}
function aliasesFor(metadata, nativeKind) {
    const aliases = new Set([metadata.name, `${metadata.namespace}/${metadata.name}`]);
    for (const key of ["app", "app.kubernetes.io/name", "app.kubernetes.io/instance"]) {
        const value = metadata.labels[key];
        if (value)
            aliases.add(value);
    }
    aliases.add(`${nativeKind.toLowerCase()}/${metadata.name}`);
    return [...aliases].sort();
}
function containsTemplate(value) {
    if (typeof value === "string")
        return value.includes("{{") || value.includes("${");
    if (Array.isArray(value))
        return value.some(containsTemplate);
    if (value !== null && typeof value === "object") {
        return Object.values(value).some(containsTemplate);
    }
    return false;
}
function sameSelector(labels, selector) {
    const entries = Object.entries(selector);
    return entries.length > 0 && entries.every(([key, value]) => labels[key] === value);
}
function targetId(namespace, nativeKind, name) {
    return `kubernetes:${namespace}:${nativeKind.toLowerCase()}:${name}`;
}
function reference(from, to, type, resolved) {
    return {
        source: "kubernetes",
        from: from.resource.id,
        to,
        type,
        resolved,
        approved_trust_transition: from.resource.attributes.approved_trust_transition === true,
        evidence: from.resource.evidence,
    };
}
export function parseKubernetes(source, file = "manifests.yaml") {
    const lineCounter = new LineCounter();
    const documents = parseAllDocuments(source, { lineCounter, prettyErrors: false, uniqueKeys: true });
    const pending = [];
    const diagnostics = [];
    for (const document of documents) {
        const range = document.range;
        for (const error of document.errors) {
            diagnostics.push({
                code: "malformed-document",
                severity: "error",
                message: error.message,
                evidence: evidenceAt(source, file, lineCounter, error.pos[0], error.pos[1], "kubernetes-yaml-parser", 1),
            });
        }
        if (document.errors.length > 0)
            continue;
        const raw = document.toJS({ maxAliasCount: 100 });
        const value = asRecord(raw);
        if (Object.keys(value).length === 0)
            continue;
        const nativeKind = typeof value.kind === "string" ? value.kind : "";
        const metadata = metadataFor(value);
        const documentEvidence = evidenceAt(source, file, lineCounter, range[0], range[2], "kubernetes-object", 1);
        if (nativeKind === "" || metadata.name === "") {
            diagnostics.push({
                code: "missing-identity",
                severity: "error",
                message: "Kubernetes objects require kind and metadata.name",
                evidence: documentEvidence,
            });
            continue;
        }
        const kind = kindFor(nativeKind);
        if (kind === "unknown") {
            diagnostics.push({
                code: "unsupported-resource",
                severity: "warning",
                message: `Kubernetes kind '${nativeKind}' is outside the Phase 5 subset`,
                evidence: documentEvidence,
            });
        }
        if (containsTemplate(raw)) {
            diagnostics.push({
                code: "unsupported-dynamic-expression",
                severity: "warning",
                message: `Kubernetes object '${metadata.namespace}/${metadata.name}' contains an unrendered template`,
                evidence: documentEvidence,
            });
        }
        const deployment = deploymentDetails(value);
        const service = serviceDetails(value);
        const routes = ingressRoutes(value);
        const attributes = nativeKind === "Deployment"
            ? deployment.attributes
            : nativeKind === "Service"
                ? service.attributes
                : {};
        const transition = metadata.annotations["archsync.io/approved-trust-transition"] === "true";
        if (transition)
            attributes.approved_trust_transition = true;
        pending.push({
            resource: {
                source: "kubernetes",
                id: targetId(metadata.namespace, nativeKind, metadata.name),
                native_type: nativeKind,
                name: metadata.name,
                namespace: metadata.namespace,
                kind,
                provider: "kubernetes",
                aliases: aliasesFor(metadata, nativeKind),
                exposure: exposureFor(nativeKind, value, metadata),
                managed: kind !== "unknown",
                approved: approved(metadata),
                trust_boundary: trustBoundary(metadata),
                attributes,
                evidence: [documentEvidence],
            },
            labels: { ...metadata.labels, ...deployment.labels },
            selector: service.selector,
            configMaps: deployment.configMaps,
            routes,
        });
    }
    const references = [];
    for (const item of pending) {
        if (item.resource.native_type === "Service") {
            const matches = pending.filter((candidate) => candidate.resource.native_type === "Deployment" &&
                candidate.resource.namespace === item.resource.namespace &&
                sameSelector(candidate.labels, item.selector));
            if (matches.length === 1) {
                references.push(reference(item, matches[0].resource.id, "selects", true));
            }
            else if (Object.keys(item.selector).length > 0) {
                const code = matches.length === 0 ? "missing-reference" : "ambiguous-reference";
                diagnostics.push({
                    code,
                    severity: "warning",
                    message: `Service '${item.resource.name}' selector matched ${matches.length} Deployments`,
                    evidence: item.resource.evidence[0],
                });
                references.push(reference(item, matches[0]?.resource.id ?? targetId(item.resource.namespace, "Deployment", "unknown"), "selects", false));
            }
        }
        for (const configMap of item.configMaps) {
            const id = targetId(item.resource.namespace, "ConfigMap", configMap);
            const resolved = pending.some((candidate) => candidate.resource.id === id);
            references.push(reference(item, id, "configures", resolved));
            if (!resolved) {
                diagnostics.push({
                    code: "missing-reference",
                    severity: "warning",
                    message: `Deployment '${item.resource.name}' references missing ConfigMap '${configMap}'`,
                    evidence: item.resource.evidence[0],
                });
            }
        }
        for (const route of item.routes) {
            const id = targetId(item.resource.namespace, "Service", route);
            const resolved = pending.some((candidate) => candidate.resource.id === id);
            references.push(reference(item, id, "routes-to", resolved));
            if (!resolved) {
                diagnostics.push({
                    code: "missing-reference",
                    severity: "warning",
                    message: `Ingress '${item.resource.name}' references missing Service '${route}'`,
                    evidence: item.resource.evidence[0],
                });
            }
        }
    }
    return {
        resources: pending.map(({ resource }) => resource).sort((left, right) => left.id.localeCompare(right.id)),
        references: references.sort((left, right) => {
            const leftKey = `${left.from}|${left.type}|${left.to}`;
            const rightKey = `${right.from}|${right.type}|${right.to}`;
            return leftKey.localeCompare(rightKey);
        }),
        diagnostics: diagnostics.sort((left, right) => {
            const fileOrder = left.evidence.file.localeCompare(right.evidence.file);
            return fileOrder || left.evidence.range.start.offset - right.evidence.range.start.offset;
        }),
    };
}
export function parseKubernetesFiles(files) {
    const resources = [];
    const references = [];
    const diagnostics = [];
    for (const file of Object.keys(files).sort()) {
        const result = parseKubernetes(files[file], file);
        resources.push(...result.resources);
        references.push(...result.references);
        diagnostics.push(...result.diagnostics);
    }
    return {
        resources: resources.sort((left, right) => left.id.localeCompare(right.id)),
        references: references.sort((left, right) => `${left.from}|${left.type}|${left.to}`.localeCompare(`${right.from}|${right.type}|${right.to}`)),
        diagnostics,
    };
}
//# sourceMappingURL=iac-kubernetes.js.map