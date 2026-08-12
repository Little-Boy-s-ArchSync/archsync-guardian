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
  const [first] = file.split("/");
  return first || expected.metadata.name;
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

function importPackages(sourceFile: ts.SourceFile): Set<string> {
  return new Set(
    sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((specifier) => specifier.text),
  );
}

function lineEvidence(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  file: string,
  detector: DetectorId,
  confidence: number,
): SourceEvidence {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const firstLine = node.getText(sourceFile).split(/\r?\n/, 1)[0]?.trim() ?? "";
  return {
    kind: "source-location",
    file,
    line: position.line + 1,
    column: position.character + 1,
    snippet: firstLine.slice(0, 180),
    detector,
    confidence,
  };
}

function anchorNode(sourceFile: ts.SourceFile): ts.Node {
  const preferredFunction = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.body && statement.body.statements.length > 0,
  );
  if (preferredFunction && ts.isFunctionDeclaration(preferredFunction)) {
    return preferredFunction.body?.statements[0] ?? preferredFunction;
  }
  return sourceFile.statements[0] ?? sourceFile;
}

function anchorRank(file: string): number {
  const name = file.split("/").at(-1) ?? file;
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
  packages: ReadonlySet<string>,
): { endpoints: Map<string, EndpointTarget>; resources: Map<string, EndpointTarget> } {
  const endpoints = new Map<string, EndpointTarget>();
  const resources = new Map<string, EndpointTarget>();
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (let pass = 0; pass < 3; pass += 1) {
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      const direct = expressionEndpoint(declaration.initializer, endpoints);
      if (direct) endpoints.set(name, direct);

      if (packages.has("pg") && ts.isNewExpression(declaration.initializer)) {
        const [options] = declaration.initializer.arguments ?? [];
        const connection = options && objectPropertyExpression(options, "connectionString");
        const target = connection && expressionEndpoint(connection, endpoints);
        if (target) {
          endpoints.set(name, target);
          resources.set(name, target);
        }
      }

      if (packages.has("redis") && ts.isCallExpression(declaration.initializer)) {
        const [options] = declaration.initializer.arguments;
        const connection = options && objectPropertyExpression(options, "url");
        const target = connection && expressionEndpoint(connection, endpoints);
        if (target) {
          endpoints.set(name, target);
          resources.set(name, target);
        }
      }
    }
  }
  return { endpoints, resources };
}

export async function analyzeTypeScriptRepository(
  repositoryPath: string,
  expected: ArchitectureDocument,
): Promise<ObservedArchitecture> {
  const absoluteRepository = resolve(repositoryPath);
  const files = await sourceFiles(absoluteRepository);
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

    const packages = importPackages(sourceFile);
    const { endpoints, resources } = variableEndpoints(sourceFile, packages);
    const amqpTarget = [...endpoints.values()].find((target) => target.relationshipType === "async");

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
          const resource = receiverName ? resources.get(receiverName) : undefined;
          if (packages.has("pg") && method === "query" && resource?.relationshipType === "data") {
            addRelationship(sourceId, resource, lineEvidence(sourceFile, node, file, "typescript-pg", 0.99));
          }
          if (
            packages.has("redis") &&
            ["get", "set", "del", "mGet", "mSet"].includes(method) &&
            resource?.componentType === "cache"
          ) {
            addRelationship(sourceId, resource, lineEvidence(sourceFile, node, file, "typescript-redis", 0.99));
          }
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
    version: "0.1",
    analyzer: { id: "archsync-typescript", version: "0.1", stack: "typescript-node" },
    metadata: { name: `${expected.metadata.name}-observed`, scanned_files: files.length },
    components: Object.fromEntries([...components.entries()].sort(([a], [b]) => a.localeCompare(b))),
    relationships: [...relationships.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, relationship]) => ({ ...relationship, evidence: sortedEvidence(relationship.evidence) })),
  };
}
