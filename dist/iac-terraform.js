const resourceKinds = new Map([
    ["aws_db_instance", "database"],
    ["aws_rds_cluster", "database"],
    ["aws_redshift_cluster", "database"],
    ["azurerm_postgresql_flexible_server", "database"],
    ["azurerm_mysql_flexible_server", "database"],
    ["azurerm_mssql_server", "database"],
    ["azurerm_cosmosdb_account", "database"],
    ["google_sql_database_instance", "database"],
    ["aws_elasticache_cluster", "cache"],
    ["aws_elasticache_replication_group", "cache"],
    ["azurerm_redis_cache", "cache"],
    ["google_redis_instance", "cache"],
    ["aws_mq_broker", "broker"],
    ["aws_msk_cluster", "broker"],
    ["azurerm_servicebus_namespace", "broker"],
    ["azurerm_eventhub_namespace", "broker"],
    ["google_pubsub_topic", "broker"],
    ["aws_lb", "ingress"],
    ["aws_alb", "ingress"],
    ["azurerm_application_gateway", "ingress"],
    ["google_compute_forwarding_rule", "ingress"],
]);
function portablePath(value) {
    return value.replaceAll("\\", "/");
}
function positionAt(source, offset) {
    const prefix = source.slice(0, offset);
    const lines = prefix.split("\n");
    return {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
        offset,
    };
}
function evidenceAt(source, file, start, end, detector, confidence) {
    return {
        source: "terraform",
        file: portablePath(file),
        range: { start: positionAt(source, start), end: positionAt(source, end) },
        snippet: source.slice(start, end).trim(),
        detector,
        confidence,
    };
}
function closingBrace(source, open) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = open; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1] ?? "";
        if (lineComment) {
            if (character === "\n")
                lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === "*" && next === "/") {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            continue;
        }
        if (character === "#" || (character === "/" && next === "/")) {
            lineComment = true;
            if (character === "/")
                index += 1;
            continue;
        }
        if (character === "/" && next === "*") {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === "{")
            depth += 1;
        if (character === "}") {
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    return -1;
}
function withoutComments(source) {
    const masked = [...source];
    let quoted = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1] ?? "";
        if (lineComment) {
            if (character === "\n")
                lineComment = false;
            else
                masked[index] = " ";
            continue;
        }
        if (blockComment) {
            masked[index] = character === "\n" ? "\n" : " ";
            if (character === "*" && next === "/") {
                masked[index + 1] = " ";
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            continue;
        }
        if (character === "#" || (character === "/" && next === "/")) {
            lineComment = true;
            masked[index] = " ";
            if (character === "/") {
                masked[index + 1] = " ";
                index += 1;
            }
            continue;
        }
        if (character === "/" && next === "*") {
            blockComment = true;
            masked[index] = " ";
            masked[index + 1] = " ";
            index += 1;
        }
    }
    return masked.join("");
}
function scanBlocks(source) {
    const blocks = [];
    const searchable = withoutComments(source);
    const pattern = /^[ \t]*(resource|module|data|dynamic)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
    let match;
    while ((match = pattern.exec(searchable)) !== null) {
        const start = match.index;
        const open = start + match[0].lastIndexOf("{");
        const end = closingBrace(source, open);
        blocks.push({
            blockType: match[1],
            labels: [match[2], ...(match[3] ? [match[3]] : [])],
            start,
            open,
            end,
        });
        if (end < 0)
            break;
        pattern.lastIndex = end + 1;
    }
    return blocks;
}
function stripInlineComment(value) {
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const next = value[index + 1] ?? "";
        if (quoted) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                quoted = false;
            continue;
        }
        if (character === '"')
            quoted = true;
        else if (character === "#" || (character === "/" && next === "/")) {
            return value.slice(0, index).trim();
        }
    }
    return value.trim();
}
function parseLiteral(raw) {
    const value = stripInlineComment(raw);
    if (/^"(?:[^"\\]|\\.)*"$/.test(value) && !value.includes("${")) {
        return { supported: true, value: JSON.parse(value) };
    }
    if (value === "true" || value === "false") {
        return { supported: true, value: value === "true" };
    }
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
        return { supported: true, value: Number(value) };
    }
    if (value.startsWith("[") && value.endsWith("]")) {
        const body = value.slice(1, -1).trim();
        if (body === "")
            return { supported: true, value: [] };
        const items = body.split(",").map((item) => parseLiteral(item.trim()));
        if (items.every((item) => item.supported && typeof item.value === "string")) {
            return { supported: true, value: items.map((item) => item.value) };
        }
    }
    return { supported: false, value };
}
function providerFor(resourceType) {
    if (resourceType.startsWith("aws_"))
        return "aws";
    if (resourceType.startsWith("azurerm_"))
        return "azure";
    if (resourceType.startsWith("google_"))
        return "gcp";
    return "unknown";
}
function literalAttributes(source, file, block) {
    const attributes = {};
    const diagnostics = [];
    const bodyStart = block.open + 1;
    const body = source.slice(bodyStart, block.end);
    for (const match of body.matchAll(/^\s*dynamic\s+"([^"]+)"\s*\{/gm)) {
        const start = bodyStart + match.index;
        diagnostics.push({
            code: "unsupported-block",
            severity: "warning",
            message: `Terraform dynamic block '${match[1]}' is not expanded`,
            evidence: evidenceAt(source, file, start, start + match[0].length, "terraform-unsupported-block", 1),
        });
    }
    const pattern = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.+)$/gm;
    for (const match of body.matchAll(pattern)) {
        const attribute = match[1];
        const raw = match[2];
        const start = bodyStart + match.index + match[0].indexOf(raw);
        const end = start + raw.length;
        const parsed = parseLiteral(raw);
        if (parsed.supported && attribute !== "count" && attribute !== "for_each") {
            attributes[attribute] = parsed.value;
        }
        else {
            diagnostics.push({
                code: "unsupported-dynamic-expression",
                severity: "warning",
                message: attribute === "count" || attribute === "for_each"
                    ? `Terraform meta-argument '${attribute}' changes resource identity and is not expanded`
                    : `Terraform attribute '${attribute}' is dynamic or outside the supported literal subset`,
                evidence: evidenceAt(source, file, start, end, "terraform-unsupported-expression", 1),
            });
        }
    }
    return { attributes, diagnostics };
}
function exposureFor(attributes) {
    const publicBooleans = [
        "publicly_accessible",
        "public_network_access_enabled",
        "ipv4_enabled",
        "assign_public_ip",
        "internet_facing",
    ];
    if (publicBooleans.some((attribute) => attributes[attribute] === true))
        return "public";
    if (attributes.scheme === "internet-facing")
        return "public";
    const cidrs = attributes.cidr_blocks;
    if (Array.isArray(cidrs) && cidrs.some((cidr) => cidr === "0.0.0.0/0" || cidr === "::/0")) {
        return "public";
    }
    if (publicBooleans.some((attribute) => attributes[attribute] === false))
        return "private";
    if (attributes.internal === true || attributes.scheme === "internal")
        return "internal";
    return "unknown";
}
function stringAttribute(attributes, key, fallback) {
    return typeof attributes[key] === "string" ? attributes[key] : fallback;
}
function resourceFromBlock(source, file, block) {
    const resourceType = block.labels[0];
    const name = block.labels[1];
    const provider = providerFor(resourceType);
    const kind = resourceKinds.get(resourceType) ?? "unknown";
    const parsed = literalAttributes(source, file, block);
    const blockEvidence = evidenceAt(source, file, block.start, block.end + 1, "terraform-resource", kind === "unknown" ? 0.5 : 1);
    if (kind === "unknown") {
        parsed.diagnostics.push({
            code: "unsupported-resource",
            severity: "warning",
            message: `Terraform resource type '${resourceType}' is outside the Phase 5 subset`,
            evidence: blockEvidence,
        });
    }
    const displayName = stringAttribute(parsed.attributes, "name", name);
    return {
        resource: {
            source: "terraform",
            id: `terraform:${provider}:${resourceType}:${name}`,
            native_type: resourceType,
            name: displayName,
            namespace: stringAttribute(parsed.attributes, "namespace", "terraform"),
            kind,
            provider,
            aliases: [...new Set([name, displayName, `${resourceType}.${name}`])].sort(),
            exposure: exposureFor(parsed.attributes),
            managed: kind !== "unknown",
            approved: parsed.attributes.archsync_approved === true,
            trust_boundary: stringAttribute(parsed.attributes, "archsync_trust_boundary", "unknown"),
            attributes: Object.fromEntries(Object.entries(parsed.attributes).sort(([left], [right]) => left.localeCompare(right))),
            evidence: [blockEvidence],
        },
        diagnostics: parsed.diagnostics,
    };
}
export function parseTerraform(source, file = "main.tf") {
    const resources = [];
    const diagnostics = [];
    for (const block of scanBlocks(source)) {
        if (block.end < 0) {
            diagnostics.push({
                code: "malformed-document",
                severity: "error",
                message: `Terraform ${block.blockType} block is not closed`,
                evidence: evidenceAt(source, file, block.start, source.length, "terraform-parser", 1),
            });
            break;
        }
        if (block.blockType !== "resource" || block.labels.length !== 2) {
            diagnostics.push({
                code: "unsupported-block",
                severity: "warning",
                message: `Terraform ${block.blockType} blocks are not expanded by the Phase 5 parser`,
                evidence: evidenceAt(source, file, block.start, block.end + 1, "terraform-unsupported-block", 1),
            });
            continue;
        }
        const parsed = resourceFromBlock(source, file, block);
        resources.push(parsed.resource);
        diagnostics.push(...parsed.diagnostics);
    }
    return {
        resources: resources.sort((left, right) => left.id.localeCompare(right.id)),
        references: [],
        diagnostics: diagnostics.sort((left, right) => {
            const fileOrder = left.evidence.file.localeCompare(right.evidence.file);
            return fileOrder || left.evidence.range.start.offset - right.evidence.range.start.offset;
        }),
    };
}
export function parseTerraformFiles(files) {
    const resources = [];
    const diagnostics = [];
    for (const file of Object.keys(files).sort()) {
        const result = parseTerraform(files[file], file);
        resources.push(...result.resources);
        diagnostics.push(...result.diagnostics);
    }
    return {
        resources: resources.sort((left, right) => left.id.localeCompare(right.id)),
        references: [],
        diagnostics,
    };
}
//# sourceMappingURL=iac-terraform.js.map