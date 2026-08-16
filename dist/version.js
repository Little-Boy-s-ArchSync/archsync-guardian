import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const packageName = "@archsync/guardian";
const provenanceFile = "provenance.json";
export const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
async function walkFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walkFiles(path) : [path];
    }));
    return files.flat();
}
async function readManifest(root) {
    const value = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (typeof value !== "object" || value === null ||
        !("name" in value) || typeof value.name !== "string" ||
        !("version" in value) || typeof value.version !== "string") {
        throw new Error("package.json does not contain a valid name and version");
    }
    const bundledDependencies = "bundledDependencies" in value && Array.isArray(value.bundledDependencies)
        ? value.bundledDependencies.filter((dependency) => typeof dependency === "string")
        : [];
    return { name: value.name, version: value.version, bundledDependencies };
}
const coreRuntimePackages = [
    "@archsync/core",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
    "yaml",
];
export async function computePackageContentSha256(root) {
    const dist = join(root, "dist");
    const manifest = await readManifest(root);
    const bundledFiles = manifest.bundledDependencies.includes("@archsync/core")
        ? (await Promise.all(coreRuntimePackages.map((dependency) => walkFiles(join(root, "node_modules", ...dependency.split("/")))))).flat()
        : [];
    const files = [
        join(root, "README.md"),
        ...(await walkFiles(dist)),
        ...bundledFiles,
    ].filter((file) => {
        const name = relative(root, file).replaceAll("\\", "/");
        return file !== join(dist, provenanceFile) &&
            basename(file) !== "package.json" &&
            !name.split("/").includes(".bin") &&
            name !== "node_modules/yaml/bin.mjs";
    });
    const digest = createHash("sha256");
    for (const file of files.sort()) {
        const name = relative(root, file).replaceAll("\\", "/");
        const bytes = await readFile(file);
        digest.update(`${name}\0${bytes.byteLength}\0`);
        digest.update(bytes);
    }
    return digest.digest("hex");
}
function gitCommit(root) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
    });
    const commit = result.status === 0 ? result.stdout.trim() : "";
    return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}
export async function createPackageProvenance(root = defaultPackageRoot, sourceCommit = gitCommit(root)) {
    const manifest = await readManifest(root);
    if (manifest.name !== packageName) {
        throw new Error(`expected package '${packageName}', received '${manifest.name}'`);
    }
    if (!sourceCommit || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
        throw new Error("a 40-character Git source commit is required to package ArchSync");
    }
    return {
        schema_version: 1,
        package_name: manifest.name,
        package_version: manifest.version,
        source_commit: sourceCommit.toLowerCase(),
        package_content_sha256: await computePackageContentSha256(root),
    };
}
function parseProvenance(value) {
    if (typeof value !== "object" || value === null ||
        !("schema_version" in value) || value.schema_version !== 1 ||
        !("package_name" in value) || typeof value.package_name !== "string" ||
        !("package_version" in value) || typeof value.package_version !== "string" ||
        !("source_commit" in value) || typeof value.source_commit !== "string" ||
        !("package_content_sha256" in value) || typeof value.package_content_sha256 !== "string" ||
        !/^[0-9a-f]{40}$/i.test(value.source_commit) ||
        !/^[0-9a-f]{64}$/i.test(value.package_content_sha256)) {
        throw new Error("packaged provenance is invalid");
    }
    return {
        schema_version: 1,
        package_name: value.package_name,
        package_version: value.package_version,
        source_commit: value.source_commit.toLowerCase(),
        package_content_sha256: value.package_content_sha256.toLowerCase(),
    };
}
async function readPackagedProvenance(root) {
    try {
        return parseProvenance(JSON.parse(await readFile(join(root, "dist", provenanceFile), "utf8")));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export async function loadVersionResult(root = defaultPackageRoot) {
    const manifest = await readManifest(root);
    const contentSha = await computePackageContentSha256(root);
    const packaged = await readPackagedProvenance(root);
    if (packaged) {
        if (packaged.package_name !== manifest.name || packaged.package_version !== manifest.version) {
            throw new Error("packaged provenance does not match package.json");
        }
        if (packaged.package_content_sha256 !== contentSha) {
            throw new Error(`packaged content failed its SHA-256 integrity check ` +
                `(expected ${packaged.package_content_sha256}, received ${contentSha})`);
        }
    }
    return {
        cli: {
            name: "ArchSync CLI",
            package: manifest.name,
            version: manifest.version,
        },
        contracts: {
            core_model: "0.1",
            guardian_analyzer: "0.2",
            git_gate: "0.3",
            finding: "0.1",
        },
        provenance: packaged
            ? {
                mode: "package",
                source_commit: packaged.source_commit,
                package_content_sha256: contentSha,
                integrity: "verified",
            }
            : {
                mode: "source-tree",
                source_commit: gitCommit(root),
                package_content_sha256: contentSha,
                integrity: "source-tree",
            },
    };
}
export function formatVersionResult(result) {
    const source = result.provenance.source_commit?.slice(0, 12) ?? "unavailable";
    return `${result.cli.name} ${result.cli.version} ` +
        `(Core Model ${result.contracts.core_model}, Guardian Analyzer ${result.contracts.guardian_analyzer}, ` +
        `Git Gate ${result.contracts.git_gate}; source ${source}; ${result.provenance.integrity})`;
}
//# sourceMappingURL=version.js.map