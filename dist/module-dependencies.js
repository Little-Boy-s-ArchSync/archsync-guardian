import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";
export const moduleDependencyAnalyzerVersion = "0.1.0-development";
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const posix = (value) => value.split(sep).join("/");
function safeMapping(mapping) {
    if (mapping.length === 0)
        throw new Error("At least one module group mapping is required");
    const prefixes = new Set();
    return mapping.map((item) => {
        if (!/^[a-z][a-z0-9-]*$/u.test(item.component))
            throw new Error("Unsafe module group ID");
        if (!/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9_./@-]+\/$/u.test(item.prefix))
            throw new Error("Unsafe module prefix");
        if (prefixes.has(item.prefix))
            throw new Error("Duplicate module prefix");
        prefixes.add(item.prefix);
        return { component: item.component, prefix: item.prefix };
    }).sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}
function groupFor(path, mapping) {
    return mapping.find((item) => path.startsWith(item.prefix))?.component ?? null;
}
function valueImport(statement, options) {
    const clause = statement.importClause;
    if (!clause)
        return true;
    if (clause.isTypeOnly || clause.name)
        return !clause.isTypeOnly;
    const bindings = clause.namedBindings;
    return !bindings || ts.isNamespaceImport(bindings) || bindings.elements.some((item) => !item.isTypeOnly) ||
        (options.verbatimModuleSyntax === true && bindings.elements.every((item) => item.isTypeOnly));
}
function valueExport(statement, options) {
    if (statement.isTypeOnly)
        return false;
    const clause = statement.exportClause;
    return !clause || !ts.isNamedExports(clause) || clause.elements.some((item) => !item.isTypeOnly) ||
        (options.verbatimModuleSyntax === true && clause.elements.every((item) => item.isTypeOnly));
}
function locallyBound(identifier, checker, file) {
    return checker.getSymbolAtLocation(identifier)?.declarations?.some((declaration) => declaration.getSourceFile() === file) ?? false;
}
function specifiers(file, checker, options) {
    const found = [];
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && valueImport(node, options)) {
            found.push({ node: node.moduleSpecifier, syntax: "import" });
        }
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && valueExport(node, options)) {
            found.push({ node: node.moduleSpecifier, syntax: "export" });
        }
        else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
                found.push({ node: node.arguments[0], syntax: "dynamic-import" });
            if (ts.isIdentifier(node.expression) && node.expression.text === "require" && !locallyBound(node.expression, checker, file)) {
                found.push({ node: node.arguments[0], syntax: "require" });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}
/** Read-only development adapter. No D3 run, prediction or accuracy claim is implied. */
export async function analyzeModuleDependencies(repository, mappings) {
    const root = await realpath(repository);
    const mapping = safeMapping(mappings);
    const files = [];
    async function visit(directory) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = resolve(directory, entry.name);
            // Dirent.isDirectory/isFile are both false for a symlink; never recurse or read it.
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name))
                    await visit(path);
            }
            else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
                const name = posix(relative(root, path));
                if (!/(^|\/)(__tests__|tests?|fixtures|__fixtures__|__mocks__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/u.test(name))
                    files.push(path);
            }
        }
    }
    await visit(root);
    const verified = new Set(files.map((file) => resolve(file)));
    const optionsCache = new Map();
    const fallbackOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext };
    const compilerOptions = (file) => {
        const config = ts.findConfigFile(dirname(file), ts.sys.fileExists, "tsconfig.json");
        if (!config || !resolve(config).startsWith(`${root}${sep}`))
            return fallbackOptions;
        const cached = optionsCache.get(config);
        if (cached)
            return cached;
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (read.error)
            throw new Error(`Cannot read TypeScript configuration: ${config}`);
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config));
        if (parsed.errors.length)
            throw new Error(`Invalid TypeScript configuration: ${config}`);
        optionsCache.set(config, parsed.options);
        return parsed.options;
    };
    const optionsByFile = new Map(files.map((file) => [file, compilerOptions(file)]));
    const grouped = new Map();
    for (const file of files) {
        const options = optionsByFile.get(file);
        const group = grouped.get(options) ?? [];
        group.push(file);
        grouped.set(options, group);
    }
    const analysis = new Map();
    for (const [options, rootNames] of grouped) {
        const program = ts.createProgram({ rootNames, options: { ...options, allowJs: true } });
        const checker = program.getTypeChecker();
        for (const path of rootNames) {
            const file = program.getSourceFile(path);
            assert(file, `TypeScript could not load source: ${path}`);
            analysis.set(path, { file, checker, options });
        }
    }
    const edges = new Map();
    const unresolved = [];
    for (const path of files) {
        assert((await lstat(path)).isFile(), "Source changed from a regular file during scan");
        assert.equal(await realpath(path), path, "Source changed to a symlink during scan");
        const source = await readFile(path, "utf8");
        const name = posix(relative(root, path));
        const from = groupFor(name, mapping);
        if (!from)
            continue;
        const current = analysis.get(path);
        assert.equal(current.file.text, source.startsWith("\uFEFF") ? source.slice(1) : source, "Source changed while TypeScript program was created");
        const parsed = current.file;
        for (const item of specifiers(parsed, current.checker, current.options)) {
            const specifier = item.node.text;
            const location = parsed.getLineAndCharacterOfPosition(item.node.getStart(parsed));
            const resolved = ts.resolveModuleName(specifier, path, current.options, ts.sys).resolvedModule?.resolvedFileName;
            if (!resolved) {
                unresolved.push({ file: name, line: location.line + 1, column: location.character + 1, specifier,
                    reason: specifier.startsWith(".") || specifier.startsWith("/") ? "unresolved-local-target" : "unresolved-package-or-alias" });
                continue;
            }
            const absolute = resolve(resolved);
            if (!verified.has(absolute)) {
                if (absolute.startsWith(`${root}${sep}`) && !absolute.includes(`${sep}node_modules${sep}`))
                    unresolved.push({ file: name, line: location.line + 1, column: location.character + 1, specifier, reason: "resolved-outside-verified-tree" });
                continue;
            }
            const targetFile = posix(relative(root, absolute));
            const to = groupFor(targetFile, mapping);
            if (!to || to === from)
                continue;
            const key = `${from}\0${to}`;
            const evidence = { file: name, line: location.line + 1, column: location.character + 1, specifier, target_file: targetFile, syntax: item.syntax };
            const edge = edges.get(key);
            if (edge)
                edge.evidence.push(evidence);
            else
                edges.set(key, { from, to, type: "dependency", evidence: [evidence] });
        }
    }
    return { analyzer: { id: "archsync-module-dependencies", version: moduleDependencyAnalyzerVersion }, scanned_files: files.length,
        edges: [...edges.values()].sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`)),
        unresolved,
        limitations: ["Development adapter only; package-export and alias resolution require repository-specific tests.",
            "Unsupported and unresolved imports are not absence evidence; no D3 or baseline result is computed here."] };
}
//# sourceMappingURL=module-dependencies.js.map