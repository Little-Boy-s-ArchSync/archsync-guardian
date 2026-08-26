import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type {
  ArchitectureComponent,
  ArchitectureDocument,
  ComponentType,
  Layer,
  RelationshipType,
} from "@archsync/core";
import ts from "typescript";

import type {
  DetectorId,
  ObservedArchitecture,
  ObservedComponent,
  ObservedRelationship,
  SourceEvidence,
} from "./contracts.js";
import { guardianAnalyzerVersion, observedGraphVersion } from "./contracts.js";
import { redactSensitiveText } from "./privacy.js";

interface EndpointTarget {
  id: string;
  relationshipType: RelationshipType;
  componentType: ComponentType;
  layer: Layer;
}

interface RelationshipAccumulator {
  from: string;
  to: string;
  type: RelationshipType;
  evidence: SourceEvidence[];
}

interface ImportBindings {
  pgConstructors: Set<string>;
  pgNamespaces: Set<string>;
  redisFactories: Set<string>;
  redisNamespaces: Set<string>;
  amqpConnectors: Set<string>;
  amqpNamespaces: Set<string>;
}

export interface AnalyzeTypeScriptOptions {
  /**
   * Limit parsing to source components affected by a Git diff. The returned
   * graph is intentionally partial and must be merged with a cached baseline
   * before conformance evaluation.
   */
  component_ids?: readonly string[];
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

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        sourceExtensions.some((extension) => entry.name.endsWith(extension)) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(path);
      }
    }
  }
  await visit(directory);
  return files.sort();
}

function sourceComponentId(
  repositoryPath: string,
  filePath: string,
  expected: ArchitectureDocument,
): string {
  const file = portablePath(relative(repositoryPath, filePath));
  const known = Object.keys(expected.components)
    .sort((a, b) => b.length - a.length)
    .find((id) => file === id || file.startsWith(`${id}/`));
  if (known) return known;
  return file.split("/")[0]!;
}

function inferredComponent(id: string, target?: EndpointTarget): ArchitectureComponent {
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

function targetFromUrl(value: string): EndpointTarget | undefined {
  try {
    const url = new URL(value);
    const id = url.hostname.toLowerCase();
    if (!id) return undefined;
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
  } catch {
    return undefined;
  }
  return undefined;
}

function targetFromEnvironment(name: string): EndpointTarget | undefined {
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

function expressionEndpoint(
  expression: ts.Expression,
  endpoints: ReadonlyMap<string, EndpointTarget>,
): EndpointTarget | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionEndpoint(expression.expression, endpoints);
  }
  if (ts.isStringLiteralLike(expression)) return targetFromUrl(expression.text);
  if (ts.isIdentifier(expression)) return endpoints.get(expression.text);
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "process" &&
    expression.expression.name.text === "env"
  ) {
    return targetFromEnvironment(expression.name.text);
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionEndpoint(expression.right, endpoints) ?? expressionEndpoint(expression.left, endpoints);
  }
  if (ts.isTemplateExpression(expression)) {
    for (const span of expression.templateSpans) {
      const target = expressionEndpoint(span.expression, endpoints);
      if (target) return target;
    }
    return targetFromUrl(expression.getText().replaceAll("`", ""));
  }
  return undefined;
}

function objectPropertyExpression(
  expression: ts.Expression,
  propertyName: string,
): ts.Expression | undefined {
  if (!ts.isObjectLiteralExpression(expression)) return undefined;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText().replaceAll(/["']/g, "");
    if (name === propertyName) return property.initializer;
  }
  return undefined;
}

function importBindings(sourceFile: ts.SourceFile): ImportBindings {
  const bindings: ImportBindings = {
    pgConstructors: new Set(),
    pgNamespaces: new Set(),
    redisFactories: new Set(),
    redisNamespaces: new Set(),
    amqpConnectors: new Set(),
    amqpNamespaces: new Set(),
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const packageName = statement.moduleSpecifier.text;
    if (!['pg', 'redis', 'amqplib'].includes(packageName)) continue;
    const clause = statement.importClause;
    if (!clause) continue;

    if (clause.name) {
      if (packageName === "pg") bindings.pgNamespaces.add(clause.name.text);
      if (packageName === "redis") bindings.redisNamespaces.add(clause.name.text);
      if (packageName === "amqplib") bindings.amqpNamespaces.add(clause.name.text);
    }

    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      if (packageName === "pg") bindings.pgNamespaces.add(namedBindings.name.text);
      if (packageName === "redis") bindings.redisNamespaces.add(namedBindings.name.text);
      if (packageName === "amqplib") bindings.amqpNamespaces.add(namedBindings.name.text);
      continue;
    }
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function matchesBoundMember(
  expression: ts.Expression,
  identifiers: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  member: string,
): boolean {
  if (ts.isIdentifier(expression)) return identifiers.has(expression.text);
  return ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    namespaces.has(expression.expression.text) &&
    expression.name.text === member;
}

function lineEvidence(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  file: string,
  detector: DetectorId,
  confidence: number,
): SourceEvidence {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const firstLine = node.getText(sourceFile).split(/\r?\n/, 1)[0]!.trim();
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

function anchorNode(sourceFile: ts.SourceFile): ts.Node {
  const preferredFunction = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.body && statement.body.statements.length > 0,
  );
  if (preferredFunction && ts.isFunctionDeclaration(preferredFunction)) {
    return preferredFunction.body!.statements[0]!;
  }
  return sourceFile.statements[0] ?? sourceFile;
}

function anchorRank(file: string): number {
  const name = file.split("/").at(-1)!;
  if (["app.ts", "server.ts", "service.ts", "worker.ts"].includes(name)) return 0;
  if (["index.ts", "main.ts"].includes(name)) return 1;
  return 10;
}

function evidenceKey(evidence: SourceEvidence): string {
  return `${evidence.file}\0${evidence.line}\0${evidence.column}\0${evidence.detector}`;
}

function sortedEvidence(values: SourceEvidence[]): SourceEvidence[] {
  return [...new Map(values.map((value) => [evidenceKey(value), value])).values()].sort((a, b) =>
    evidenceKey(a).localeCompare(evidenceKey(b)),
  );
}

function relationshipKey(from: string, to: string, type: RelationshipType): string {
  return `${from}|${type}|${to}`;
}

function variableEndpoints(
  sourceFile: ts.SourceFile,
  bindings: ImportBindings,
): {
  endpoints: Map<string, EndpointTarget>;
  pgResources: Map<string, EndpointTarget>;
  redisResources: Map<string, EndpointTarget>;
  amqpChannels: Map<string, EndpointTarget>;
} {
  const endpoints = new Map<string, EndpointTarget>();
  const pgResources = new Map<string, EndpointTarget>();
  const redisResources = new Map<string, EndpointTarget>();
  const amqpConnections = new Map<string, EndpointTarget>();
  const amqpChannels = new Map<string, EndpointTarget>();
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (let pass = 0; pass < 4; pass += 1) {
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      const direct = expressionEndpoint(declaration.initializer, endpoints);
      if (direct) endpoints.set(name, direct);
      const initializer = unwrapExpression(declaration.initializer);

      if (
        ts.isNewExpression(initializer) &&
        (
          matchesBoundMember(initializer.expression, bindings.pgConstructors, bindings.pgNamespaces, "Client") ||
          matchesBoundMember(initializer.expression, bindings.pgConstructors, bindings.pgNamespaces, "Pool")
        )
      ) {
        const [options] = initializer.arguments ?? [];
        const connection = options && objectPropertyExpression(options, "connectionString");
        const target = connection && expressionEndpoint(connection, endpoints);
        if (target) {
          endpoints.set(name, target);
          pgResources.set(name, target);
        }
      }

      if (
        ts.isCallExpression(initializer) &&
        matchesBoundMember(initializer.expression, bindings.redisFactories, bindings.redisNamespaces, "createClient")
      ) {
        const [options] = initializer.arguments;
        const connection = options && objectPropertyExpression(options, "url");
        const target = connection && expressionEndpoint(connection, endpoints);
        if (target) {
          endpoints.set(name, target);
          redisResources.set(name, target);
        }
      }

      if (
        ts.isCallExpression(initializer) &&
        matchesBoundMember(initializer.expression, bindings.amqpConnectors, bindings.amqpNamespaces, "connect")
      ) {
        const [connection] = initializer.arguments;
        const target = connection && expressionEndpoint(connection, endpoints);
        if (target?.relationshipType === "async") amqpConnections.set(name, target);
      }

      if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)) {
        const receiver = initializer.expression.expression;
        if (
          initializer.expression.name.text === "createChannel" &&
          ts.isIdentifier(receiver) &&
          amqpConnections.has(receiver.text)
        ) {
          amqpChannels.set(name, amqpConnections.get(receiver.text)!);
        }
      }
    }
  }
  return { endpoints, pgResources, redisResources, amqpChannels };
}

export async function analyzeTypeScriptRepository(
  repositoryPath: string,
  expected: ArchitectureDocument,
  options: AnalyzeTypeScriptOptions = {},
): Promise<ObservedArchitecture> {
  const absoluteRepository = resolve(repositoryPath);
  const componentFilter = options.component_ids
    ? new Set(options.component_ids)
    : undefined;
  const files = (await sourceFiles(absoluteRepository)).filter((filePath) =>
    !componentFilter || componentFilter.has(sourceComponentId(absoluteRepository, filePath, expected)),
  );
  const components = new Map<string, ObservedComponent>();
  const componentAnchors = new Map<string, { rank: number; evidence: SourceEvidence }>();
  const relationships = new Map<string, RelationshipAccumulator>();

  const ensureComponent = (
    id: string,
    evidence: SourceEvidence,
    target?: EndpointTarget,
  ): void => {
    const component = expected.components[id] ?? inferredComponent(id, target);
    const current = components.get(id);
    if (current) {
      current.evidence.push(evidence);
    } else {
      components.set(id, { component, evidence: [evidence] });
    }
  };

  const addRelationship = (
    from: string,
    target: EndpointTarget,
    evidence: SourceEvidence,
    reverse = false,
  ): void => {
    const relationshipFrom = reverse ? target.id : from;
    const relationshipTo = reverse ? from : target.id;
    if (relationshipFrom === relationshipTo) return;
    const key = relationshipKey(relationshipFrom, relationshipTo, target.relationshipType);
    const current = relationships.get(key);
    if (current) {
      current.evidence.push(evidence);
    } else {
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
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const sourceId = sourceComponentId(absoluteRepository, filePath, expected);
    const anchor = lineEvidence(sourceFile, anchorNode(sourceFile), file, "component-root", 1);
    const rank = anchorRank(file);
    const currentAnchor = componentAnchors.get(sourceId);
    if (!currentAnchor || rank < currentAnchor.rank || (rank === currentAnchor.rank && file < currentAnchor.evidence.file)) {
      componentAnchors.set(sourceId, { rank, evidence: anchor });
    }
    ensureComponent(sourceId, anchor);

    const bindings = importBindings(sourceFile);
    const { endpoints, pgResources, redisResources, amqpChannels } = variableEndpoints(sourceFile, bindings);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
          const [argument] = node.arguments;
          const target = argument && expressionEndpoint(argument, endpoints);
          if (target) {
            addRelationship(sourceId, target, lineEvidence(sourceFile, node, file, "typescript-fetch", 1));
          }
        }

        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const receiver = node.expression.expression;
          const receiverName = ts.isIdentifier(receiver) ? receiver.text : undefined;
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
