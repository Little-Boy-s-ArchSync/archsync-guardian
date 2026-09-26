import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { guardianAnalyzerVersion, observedGraphVersion } from "./contracts.js";
import { redactSensitiveText } from "./privacy.js";
// Bind names within each parsed file without resolving dependencies or loading libraries.
// Symbol identity prevents an imported client or endpoint from leaking into shadowing scopes.
const sourceCheckers = new WeakMap();
function identifierKey(identifier) {
    const symbol = sourceCheckers.get(identifier.getSourceFile())?.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    return declaration ? `${identifier.text}@${declaration.pos}` : identifier.text;
}
function bindSource(sourceFile) {
    const sources = new Map([[sourceFile.fileName, sourceFile]]);
    const contents = new Map([[sourceFile.fileName, sourceFile.text]]);
    const host = {
        getSourceFile: sources.get.bind(sources),
        getDefaultLibFileName: () => "",
        // Required CompilerHost adapter; this binding-only program never emits files.
        /* v8 ignore next */
        writeFile: () => undefined,
        getCurrentDirectory: () => "",
        fileExists: (name) => name === sourceFile.fileName,
        readFile: contents.get.bind(contents),
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        // Required formatting adapter; no emit or diagnostic formatting is requested.
        /* v8 ignore next */
        getNewLine: () => "\n",
    };
    const program = ts.createProgram([sourceFile.fileName], { noLib: true, noResolve: true }, host);
    sourceCheckers.set(sourceFile, program.getTypeChecker());
}
const redisOperations = new Set([
    "get",
    "set",
    "del",
    "mGet",
    "mSet",
    "hGet",
    "hSet",
    "hDel",
    "lPush",
    "rPush",
    "lPop",
    "rPop",
    "sAdd",
    "sRem",
    "zAdd",
    "zRem",
    "expire",
]);
const ignoredDirectories = new Set([
    ".git",
    "coverage",
    "dist",
    "node_modules",
    "tmp",
]);
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
function portablePath(value) {
    return value.split(sep).join("/");
}
async function sourceFiles(directory) {
    const files = [];
    async function visit(current) {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory() && ignoredDirectories.has(entry.name))
                continue;
            const path = resolve(current, entry.name);
            if (entry.isDirectory()) {
                await visit(path);
            }
            else if (sourceExtensions.some((extension) => entry.name.endsWith(extension)) &&
                !entry.name.endsWith(".d.ts")) {
                files.push(path);
            }
        }
    }
    await visit(directory);
    return files.sort();
}
function sourceComponentId(repositoryPath, filePath, expected) {
    const file = portablePath(relative(repositoryPath, filePath));
    const known = Object.keys(expected.components)
        .sort((a, b) => b.length - a.length)
        .find((id) => file === id || file.startsWith(`${id}/`));
    if (known)
        return known;
    return file.split("/")[0];
}
function inferredComponent(id, target) {
    if (target) {
        return {
            name: id,
            type: target.componentType,
            layer: target.layer,
        };
    }
    if (id.includes("worker")) {
        return { name: id, type: "worker", layer: "domain" };
    }
    if (id.includes("gateway")) {
        return { name: id, type: "gateway", layer: "edge" };
    }
    if (id.includes("frontend") || id.includes("web")) {
        return { name: id, type: "frontend", layer: "experience" };
    }
    return { name: id, type: "service", layer: "domain" };
}
function targetFromUrl(value) {
    try {
        const url = new URL(value);
        const id = url.hostname.toLowerCase();
        if (!id)
            return undefined;
        if (url.protocol === "http:" || url.protocol === "https:") {
            return { id, relationshipType: "http", componentType: "service", layer: "domain" };
        }
        if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
            return { id, relationshipType: "data", componentType: "database", layer: "data" };
        }
        if (url.protocol === "redis:" || url.protocol === "rediss:") {
            return { id, relationshipType: "data", componentType: "cache", layer: "data" };
        }
        if (url.protocol === "amqp:" || url.protocol === "amqps:") {
            return { id, relationshipType: "async", componentType: "queue", layer: "integration" };
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function targetFromEnvironment(name) {
    const normalized = name.replace(/_URL$/, "").toLowerCase().replaceAll("_", "-");
    if (name === "DATABASE_URL") {
        return { id: "postgres", relationshipType: "data", componentType: "database", layer: "data" };
    }
    if (name === "REDIS_URL") {
        return { id: "redis", relationshipType: "data", componentType: "cache", layer: "data" };
    }
    if (name.includes("EVENT") || name.includes("QUEUE") || name.includes("AMQP")) {
        return { id: normalized, relationshipType: "async", componentType: "queue", layer: "integration" };
    }
    if (name.endsWith("_URL")) {
        return { id: normalized, relationshipType: "http", componentType: "service", layer: "domain" };
    }
    return undefined;
}
// Only evaluate string concatenation when all operands have a static string value.
// Selecting one URL-shaped operand can change the actual destination.
function staticString(expression, seen = new Set()) {
    if (seen.has(expression))
        return undefined;
    seen.add(expression);
    if (ts.isStringLiteralLike(expression))
        return expression.text;
    if (ts.isParenthesizedExpression(expression))
        return staticString(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
        const symbol = sourceCheckers.get(expression.getSourceFile()).getSymbolAtLocation(expression);
        const declaration = symbol?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
            return staticString(declaration.initializer, seen);
        }
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticString(expression.left, new Set(seen));
        const right = staticString(expression.right, new Set(seen));
        if (left !== undefined && right !== undefined)
            return left + right;
    }
    return undefined;
}
function expressionEndpoint(expression, endpoints) {
    if (ts.isParenthesizedExpression(expression)) {
        return expressionEndpoint(expression.expression, endpoints);
    }
    if (ts.isStringLiteralLike(expression))
        return targetFromUrl(expression.text);
    if (ts.isIdentifier(expression))
        return endpoints.get(identifierKey(expression));
    if (ts.isPropertyAccessExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        identifierKey(expression.expression.expression) === "process" &&
        expression.expression.name.text === "env") {
        return targetFromEnvironment(expression.name.text);
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const value = staticString(expression);
        return value === undefined ? undefined : targetFromUrl(value);
    }
    if (ts.isBinaryExpression(expression) && [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
    ].includes(expression.operatorToken.kind)) {
        return expressionEndpoint(expression.right, endpoints) ?? expressionEndpoint(expression.left, endpoints);
    }
    if (ts.isTemplateExpression(expression)) {
        for (const span of expression.templateSpans) {
            const target = expressionEndpoint(span.expression, endpoints);
            if (target)
                return target;
        }
        return targetFromUrl(expression.getText().replaceAll("`", ""));
    }
    return undefined;
}
function objectPropertyExpression(expression, propertyName) {
    if (!ts.isObjectLiteralExpression(expression))
        return undefined;
    for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property))
            continue;
        const name = property.name.getText().replaceAll(/["']/g, "");
        if (name === propertyName)
            return property.initializer;
    }
    return undefined;
}
function importBindings(sourceFile) {
    const bindings = {
        pgConstructors: new Set(),
        pgNamespaces: new Set(),
        redisFactories: new Set(),
        redisNamespaces: new Set(),
        amqpConnectors: new Set(),
        amqpNamespaces: new Set(),
    };
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
        const packageName = statement.moduleSpecifier.text;
        if (!['pg', 'redis', 'amqplib'].includes(packageName))
            continue;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly)
            continue;
        if (clause.name) {
            if (packageName === "pg")
                bindings.pgNamespaces.add(identifierKey(clause.name));
            if (packageName === "redis")
                bindings.redisNamespaces.add(identifierKey(clause.name));
            if (packageName === "amqplib")
                bindings.amqpNamespaces.add(identifierKey(clause.name));
        }
        const namedBindings = clause.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
            if (packageName === "pg")
                bindings.pgNamespaces.add(identifierKey(namedBindings.name));
            if (packageName === "redis")
                bindings.redisNamespaces.add(identifierKey(namedBindings.name));
            if (packageName === "amqplib")
                bindings.amqpNamespaces.add(identifierKey(namedBindings.name));
            continue;
        }
        if (!namedBindings || !ts.isNamedImports(namedBindings))
            continue;
        for (const element of namedBindings.elements) {
            if (element.isTypeOnly)
                continue;
            const imported = element.propertyName?.text ?? element.name.text;
            const local = identifierKey(element.name);
            if (packageName === "pg" && ["Client", "Pool"].includes(imported)) {
                bindings.pgConstructors.add(local);
            }
            if (packageName === "redis" && imported === "createClient") {
                bindings.redisFactories.add(local);
            }
            if (packageName === "amqplib" && imported === "connect") {
                bindings.amqpConnectors.add(local);
            }
        }
    }
    return bindings;
}
function unwrapExpression(expression) {
    let current = expression;
    while (ts.isAwaitExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current)) {
        current = current.expression;
    }
    return current;
}
function matchesBoundMember(expression, identifiers, namespaces, member) {
    if (ts.isIdentifier(expression))
        return identifiers.has(identifierKey(expression));
    return ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(identifierKey(expression.expression)) &&
        expression.name.text === member;
}
function lineEvidence(sourceFile, node, file, detector, confidence) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const firstLine = node.getText(sourceFile).split(/\r?\n/, 1)[0].trim();
    return {
        kind: "source-location",
        file,
        line: position.line + 1,
        column: position.character + 1,
        snippet: redactSensitiveText(firstLine.slice(0, 180)),
        detector,
        confidence,
    };
}
function anchorNode(sourceFile) {
    const preferredFunction = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.body && statement.body.statements.length > 0);
    if (preferredFunction && ts.isFunctionDeclaration(preferredFunction)) {
        return preferredFunction.body.statements[0];
    }
    return sourceFile.statements[0] ?? sourceFile;
}
function anchorRank(file) {
    const name = file.split("/").at(-1);
    if (["app.ts", "server.ts", "service.ts", "worker.ts"].includes(name))
        return 0;
    if (["index.ts", "main.ts"].includes(name))
        return 1;
    return 10;
}
function evidenceKey(evidence) {
    return `${evidence.file}\0${evidence.line}\0${evidence.column}\0${evidence.detector}`;
}
function sortedEvidence(values) {
    return [...new Map(values.map((value) => [evidenceKey(value), value])).values()].sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b)));
}
function relationshipKey(from, to, type) {
    return `${from}|${type}|${to}`;
}
function variableEndpoints(sourceFile, bindings) {
    const endpoints = new Map();
    const pgResources = new Map();
    const redisResources = new Map();
    const amqpConnections = new Map();
    const amqpChannels = new Map();
    const declarations = [];
    // Flow-insensitive invalidation: any recognized binding write makes it unknown,
    // including uses before the write. This deliberately trades recall for fewer stale edges.
    const mutated = new Set();
    const markWrite = (expression) => {
        const target = unwrapExpression(expression);
        if (ts.isIdentifier(target)) {
            mutated.add(identifierKey(target));
        }
        else if (ts.isArrayLiteralExpression(target)) {
            for (const element of target.elements)
                markWrite(element);
        }
        else if (ts.isObjectLiteralExpression(target)) {
            for (const property of target.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    // Shorthand property symbols differ from the variable being assigned.
                    const symbol = sourceCheckers.get(sourceFile).getShorthandAssignmentValueSymbol(property);
                    const declaration = symbol?.declarations?.[0];
                    if (declaration)
                        mutated.add(`${property.name.text}@${declaration.pos}`);
                }
                else if (ts.isPropertyAssignment(property)) {
                    markWrite(property.initializer);
                }
                else if (ts.isSpreadAssignment(property)) {
                    markWrite(property.expression);
                }
            }
        }
        else if (ts.isSpreadElement(target)) {
            markWrite(target.expression);
        }
        else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            markWrite(target.left);
        }
        // Property/element writes mutate an object, not the receiver or index binding.
    };
    const collect = (node) => {
        if (ts.isVariableDeclaration(node))
            declarations.push(node);
        if (ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            markWrite(node.left);
        }
        else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
            markWrite(node.operand);
        }
        else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
            !ts.isVariableDeclarationList(node.initializer)) {
            markWrite(node.initializer);
        }
        ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    for (let pass = 0; pass < 4; pass += 1) {
        for (const declaration of declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                continue;
            const name = identifierKey(declaration.name);
            if (mutated.has(name))
                continue;
            const direct = expressionEndpoint(declaration.initializer, endpoints);
            if (direct)
                endpoints.set(name, direct);
            const initializer = unwrapExpression(declaration.initializer);
            if (ts.isNewExpression(initializer) &&
                (matchesBoundMember(initializer.expression, bindings.pgConstructors, bindings.pgNamespaces, "Client") ||
                    matchesBoundMember(initializer.expression, bindings.pgConstructors, bindings.pgNamespaces, "Pool"))) {
                const [options] = initializer.arguments ?? [];
                const connection = options && objectPropertyExpression(options, "connectionString");
                const target = connection && expressionEndpoint(connection, endpoints);
                if (target?.componentType === "database") {
                    endpoints.set(name, target);
                    pgResources.set(name, target);
                }
            }
            if (ts.isCallExpression(initializer) &&
                matchesBoundMember(initializer.expression, bindings.redisFactories, bindings.redisNamespaces, "createClient")) {
                const [options] = initializer.arguments;
                const connection = options && objectPropertyExpression(options, "url");
                const target = connection && expressionEndpoint(connection, endpoints);
                if (target?.componentType === "cache") {
                    endpoints.set(name, target);
                    redisResources.set(name, target);
                }
            }
            if (ts.isCallExpression(initializer) &&
                matchesBoundMember(initializer.expression, bindings.amqpConnectors, bindings.amqpNamespaces, "connect")) {
                const [connection] = initializer.arguments;
                const target = connection && expressionEndpoint(connection, endpoints);
                if (target?.relationshipType === "async")
                    amqpConnections.set(name, target);
            }
            if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)) {
                const receiver = initializer.expression.expression;
                if (initializer.expression.name.text === "createChannel" &&
                    ts.isIdentifier(receiver) &&
                    amqpConnections.has(identifierKey(receiver))) {
                    amqpChannels.set(name, amqpConnections.get(identifierKey(receiver)));
                }
            }
        }
    }
    return { endpoints, pgResources, redisResources, amqpChannels };
}
export async function analyzeTypeScriptRepository(repositoryPath, expected, options = {}) {
    const absoluteRepository = resolve(repositoryPath);
    const componentFilter = options.component_ids
        ? new Set(options.component_ids)
        : undefined;
    const files = (await sourceFiles(absoluteRepository)).filter((filePath) => !componentFilter || componentFilter.has(sourceComponentId(absoluteRepository, filePath, expected)));
    const components = new Map();
    const componentAnchors = new Map();
    const relationships = new Map();
    const ensureComponent = (id, evidence, target) => {
        const component = expected.components[id] ?? inferredComponent(id, target);
        const current = components.get(id);
        if (current) {
            current.evidence.push(evidence);
        }
        else {
            components.set(id, { component, evidence: [evidence] });
        }
    };
    const addRelationship = (from, target, evidence, reverse = false) => {
        const relationshipFrom = reverse ? target.id : from;
        const relationshipTo = reverse ? from : target.id;
        if (relationshipFrom === relationshipTo)
            return;
        const key = relationshipKey(relationshipFrom, relationshipTo, target.relationshipType);
        const current = relationships.get(key);
        if (current) {
            current.evidence.push(evidence);
        }
        else {
            relationships.set(key, {
                from: relationshipFrom,
                to: relationshipTo,
                type: target.relationshipType,
                evidence: [evidence],
            });
        }
        ensureComponent(target.id, evidence, target);
    };
    for (const filePath of files) {
        const file = portablePath(relative(absoluteRepository, filePath));
        const source = await readFile(filePath, "utf8");
        const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const sourceId = sourceComponentId(absoluteRepository, filePath, expected);
        const anchor = lineEvidence(sourceFile, anchorNode(sourceFile), file, "component-root", 1);
        const rank = anchorRank(file);
        const currentAnchor = componentAnchors.get(sourceId);
        if (!currentAnchor || rank < currentAnchor.rank || (rank === currentAnchor.rank && file < currentAnchor.evidence.file)) {
            componentAnchors.set(sourceId, { rank, evidence: anchor });
        }
        ensureComponent(sourceId, anchor);
        bindSource(sourceFile);
        const bindings = importBindings(sourceFile);
        const { endpoints, pgResources, redisResources, amqpChannels } = variableEndpoints(sourceFile, bindings);
        const visit = (node) => {
            if (ts.isCallExpression(node)) {
                if (ts.isIdentifier(node.expression) && identifierKey(node.expression) === "fetch") {
                    const [argument] = node.arguments;
                    const target = argument && expressionEndpoint(argument, endpoints);
                    if (target?.relationshipType === "http") {
                        addRelationship(sourceId, target, lineEvidence(sourceFile, node, file, "typescript-fetch", 1));
                    }
                }
                if (ts.isPropertyAccessExpression(node.expression)) {
                    const method = node.expression.name.text;
                    const receiver = node.expression.expression;
                    const receiverName = ts.isIdentifier(receiver) ? identifierKey(receiver) : undefined;
                    const pgResource = receiverName ? pgResources.get(receiverName) : undefined;
                    if (method === "query" && pgResource) {
                        addRelationship(sourceId, pgResource, lineEvidence(sourceFile, node, file, "typescript-pg", 0.99));
                    }
                    const redisResource = receiverName ? redisResources.get(receiverName) : undefined;
                    if (redisOperations.has(method) && redisResource) {
                        addRelationship(sourceId, redisResource, lineEvidence(sourceFile, node, file, "typescript-redis", 0.99));
                    }
                    const amqpTarget = receiverName ? amqpChannels.get(receiverName) : undefined;
                    if (amqpTarget && ["publish", "sendToQueue"].includes(method)) {
                        addRelationship(sourceId, amqpTarget, lineEvidence(sourceFile, node, file, "typescript-amqp-publish", 0.98));
                    }
                    if (amqpTarget && method === "consume") {
                        addRelationship(sourceId, amqpTarget, lineEvidence(sourceFile, node, file, "typescript-amqp-consume", 0.98), true);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    for (const [id, observed] of components) {
        const preferred = componentAnchors.get(id)?.evidence;
        observed.evidence = sortedEvidence(preferred ? [preferred, ...observed.evidence] : observed.evidence);
    }
    return {
        version: observedGraphVersion,
        analyzer: { id: "archsync-typescript", version: guardianAnalyzerVersion, stack: "typescript-node" },
        metadata: { name: `${expected.metadata.name}-observed`, scanned_files: files.length },
        components: Object.fromEntries([...components.entries()].sort(([a], [b]) => a.localeCompare(b))),
        relationships: [...relationships.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, relationship]) => ({ ...relationship, evidence: sortedEvidence(relationship.evidence) })),
    };
}
//# sourceMappingURL=analyzer.js.map