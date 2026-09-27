import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
/** Separate from Guardian's service graph and its cache/version contract. */
export const moduleAdapterVersion = "0.1.0";
function digest(text) {
    return createHash("sha256").update(text).digest("hex");
}
function portablePath(root, file) {
    return relative(root, file).replaceAll("\\", "/");
}
function isWithin(root, file) {
    const path = relative(root, file);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}
function isDeclaration(file) {
    return /\.d\.[cm]?ts$/i.test(file);
}
/** IDs are path identities, not names inferred from author-supplied labels. */
export function moduleId(file) {
    return `module-${digest(file)}`;
}
export function moduleDiagnosticLocation(source, file, diagnostic) {
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return { file, line: position.line + 1, column: position.character + 1 };
}
/**
 * Reads source/config only. Does not execute repository code or download packages.
 * Local ESM imports and re-exports (including type-only forms) are syntax edges,
 * not runtime-call edges. Unsupported/unresolved constructs prevent a complete
 * result; external packages, builtins and declaration-only targets are counted
 * explicitly outside the internal-source comparison population.
 */
export function analyzeModuleProject(configPath, repositoryRoot = dirname(resolve(configPath))) {
    const root = realpathSync(repositoryRoot);
    const config = resolve(configPath).replaceAll("\\", "/");
    if (!isWithin(root, realpathSync(config)))
        throw new Error("Module config must be inside repositoryRoot");
    const inputs = new Map();
    const readFile = (file) => {
        const content = ts.sys.readFile(file);
        if (content !== undefined)
            inputs.set(portablePath(root, resolve(file)), digest(readFileSync(file)));
        return content;
    };
    const fatal = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
        ...ts.sys, readFile, onUnRecoverableConfigFileDiagnostic: (error) => fatal.push(error),
    });
    const errors = [...fatal, ...(parsed?.errors ?? [])];
    if (!parsed || errors.length) {
        throw new Error(`Invalid module tsconfig: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`);
    }
    const result = {
        schema_version: "0.1.0", adapter: "archsync-static-esm", adapter_version: moduleAdapterVersion,
        typescript_version: ts.version, scope: "configured-internal-typescript-static-esm",
        status: "complete-within-scope", modules: [], edges: [], exclusions: [], issues: [], inputs: [],
    };
    const configLocation = { file: portablePath(root, config), line: 1, column: 1 };
    const issue = (location, code, message) => {
        result.issues.push({ ...location, code, message });
    };
    if (parsed.projectReferences?.length) {
        issue(configLocation, "project-references", "Project references require separately frozen project scopes; a single-project scan is incomplete.");
    }
    const files = parsed.fileNames.filter((file) => !isDeclaration(file)).sort();
    const candidates = new Map();
    for (const file of files) {
        if (!/\.[cm]?tsx?$/i.test(file) || !isWithin(root, realpathSync(file))) {
            issue({ file: portablePath(root, file), line: 1, column: 1 }, "unsupported-source", "Only repository-contained TypeScript source files belong to this adapter scope.");
        }
        else {
            const canonical = realpathSync(file);
            if (candidates.has(canonical)) {
                issue({ file: portablePath(root, file), line: 1, column: 1 }, "source-alias", "Multiple configured paths identify the same physical file; choose one source identity before comparison.");
            }
            else {
                candidates.set(canonical, file);
            }
        }
    }
    if (!candidates.size)
        issue(configLocation, "empty-scope", "No eligible TypeScript source files were selected.");
    const host = ts.createCompilerHost(parsed.options, true);
    host.readFile = readFile;
    // createCompilerHost.getSourceFile closes over its original reader. Override
    // it so the input receipt also includes every parsed source and declaration.
    host.getSourceFile = (file, languageVersion) => {
        const content = readFile(file);
        return content === undefined ? undefined : ts.createSourceFile(file, content, languageVersion, true);
    };
    const program = ts.createProgram({ rootNames: [...candidates.values()], options: parsed.options, host });
    const edges = new Map();
    for (const file of candidates.values()) {
        const source = program.getSourceFile(file);
        const name = portablePath(root, file);
        if (!source) {
            issue({ file: name, line: 1, column: 1 }, "unreadable-source", "A selected source could not be read; the observation is incomplete.");
            continue;
        }
        result.modules.push({ id: moduleId(name), file: name, sha256: inputs.get(name) });
        const location = (node) => {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            return { file: name, line: position.line + 1, column: position.character + 1 };
        };
        for (const error of program.getSyntacticDiagnostics(source)) {
            issue(moduleDiagnosticLocation(source, name, error), "syntax-error", ts.flattenDiagnosticMessageText(error.messageText, " "));
        }
        const record = (node, literal) => {
            const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
            const named = clause?.namedBindings;
            const typeOnly = ts.isExportDeclaration(node)
                ? node.isTypeOnly || !!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every((element) => element.isTypeOnly))
                : !!(clause?.isTypeOnly || (!clause?.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every((element) => element.isTypeOnly)));
            const evidence = { ...location(literal), specifier: literal.text, syntax: ts.isImportDeclaration(node) ? "import" : "export", type_only: typeOnly };
            if (isBuiltin(literal.text)) {
                result.exclusions.push({ ...evidence, reason: "builtin" });
                return;
            }
            const resolved = ts.resolveModuleName(literal.text, file, parsed.options, host, undefined, undefined, program.getModeForUsageLocation(source, literal)).resolvedModule;
            if (!resolved) {
                issue(location(literal), "unresolved-module", `Cannot resolve module '${literal.text}' under the supplied tsconfig.`);
                return;
            }
            if (resolved.isExternalLibraryImport) {
                result.exclusions.push({ ...evidence, reason: "external-package" });
                return;
            }
            if (isDeclaration(resolved.resolvedFileName)) {
                result.exclusions.push({ ...evidence, reason: "declaration-only" });
                return;
            }
            const target = realpathSync(resolved.resolvedFileName);
            const targetFile = candidates.get(target);
            if (!targetFile) {
                issue(location(literal), "target-outside-scope", `Resolved module '${literal.text}' is not in the configured internal source population.`);
                return;
            }
            const targetName = portablePath(root, targetFile);
            const key = JSON.stringify([name, targetName]);
            const edge = edges.get(key) ?? { from: name, to: targetName, evidence: [] };
            edge.evidence.push(evidence);
            edges.set(key, edge);
        };
        const visit = (node) => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
                record(node, node.moduleSpecifier);
            }
            else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
                issue(location(node), "unsupported-commonjs", "TypeScript import-equals/require is outside the static ESM contract.");
            }
            else if (ts.isImportTypeNode(node)) {
                issue(location(node), "unsupported-import-type", "An import() type expression is outside the static ESM declaration contract.");
            }
            else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                issue(location(node), "unsupported-dynamic-import", "Dynamic import, including literal import(), is outside the static ESM contract.");
            }
            else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
                issue(location(node), "unsupported-commonjs", "A require-shaped call needs separate CommonJS/binding analysis; no dependency is inferred.");
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    result.edges = [...edges.values()];
    // Map keys are unique; comparison equality is impossible here.
    result.inputs = [...inputs].sort(([a], [b]) => a < b ? -1 : 1).map(([file, sha256]) => ({ file, sha256 }));
    result.status = result.issues.length ? "incomplete" : "complete-within-scope";
    return result;
}
/** Produces a distinct module-level Core model, never remaps service edges. */
export function moduleArchitecture(graph) {
    if (graph.status !== "complete-within-scope" || graph.issues.length) {
        throw new Error("Incomplete module observation cannot be treated as a complete conformance input");
    }
    return {
        version: "0.1.1", metadata: { name: "Static ESM module architecture" },
        components: Object.fromEntries(graph.modules.map((module) => [module.id, { name: module.file, type: "library", layer: "domain" }])),
        relationships: graph.edges.map((edge) => ({ from: moduleId(edge.from), to: moduleId(edge.to), type: "dependency" })),
    };
}
//# sourceMappingURL=module-graph.js.map