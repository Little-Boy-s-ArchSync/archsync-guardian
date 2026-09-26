import { sep } from "node:path";
export const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];
export function portablePath(value) {
    return value.split(sep).join("/");
}
export function sourceComponent(file, expected) {
    if (!sourceExtensions.some((extension) => file.endsWith(extension)) || file.endsWith(".d.ts")) {
        return undefined;
    }
    const known = Object.keys(expected.components)
        .sort((a, b) => b.length - a.length)
        .find((id) => file === id || file.startsWith(`${id}/`));
    return known ?? file.split("/")[0];
}
export function repositoryRelativePath(gitPath, repositoryRelative) {
    const normalized = portablePath(gitPath);
    if (!repositoryRelative)
        return normalized;
    const prefix = `${repositoryRelative}/`;
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}
function statusName(value) {
    if (value.startsWith("A"))
        return "added";
    if (value.startsWith("D"))
        return "deleted";
    if (value.startsWith("R"))
        return "renamed";
    return "modified";
}
export function parseNameStatus(output, repositoryRelative) {
    const files = new Map();
    const rows = [];
    if (output.includes("\0")) {
        const fields = output.split("\0");
        for (let index = 0; index < fields.length - 1;) {
            const status = fields[index++];
            const first = fields[index++];
            rows.push([status, first, ...(status.startsWith("R") ? [fields[index++]] : [])]);
        }
    }
    else {
        rows.push(...output.split(/\r?\n/u).filter(Boolean).map((line) => line.split("\t")));
    }
    for (const [rawStatus, first, second] of rows) {
        if (!rawStatus || !first)
            continue;
        const renamed = rawStatus.startsWith("R") && second;
        const currentPath = repositoryRelativePath(renamed ? second : first, repositoryRelative);
        if (!currentPath)
            continue;
        const previousPath = renamed
            ? repositoryRelativePath(first, repositoryRelative)
            : undefined;
        files.set(currentPath, {
            path: currentPath,
            status: statusName(rawStatus),
            ...(previousPath ? { previous_path: previousPath } : {}),
            additions: 0,
            deletions: 0,
            changed_lines: [],
        });
    }
    return files;
}
export function parseNumStat(output, repositoryRelative, files) {
    const rows = [];
    if (output.includes("\0")) {
        const fields = output.split("\0");
        for (let index = 0; index < fields.length - 1; index++) {
            const match = fields[index].match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/u);
            if (!match)
                continue;
            let path = match[3];
            // With -z a rename has an empty path followed by old and new paths.
            if (!path) {
                index++;
                path = fields[++index];
            }
            rows.push([match[1], match[2], path]);
        }
    }
    else {
        rows.push(...output.split(/\r?\n/u).filter(Boolean).map((line) => line.split("\t")));
    }
    for (const [added, deleted, rawPath] of rows) {
        if (!rawPath)
            continue;
        const path = repositoryRelativePath(rawPath, repositoryRelative);
        if (!path)
            continue;
        const file = files.get(path);
        if (!file)
            continue;
        file.additions = Number.parseInt(added, 10) || 0;
        file.deletions = Number.parseInt(deleted, 10) || 0;
    }
}
export function parseChangedLines(patch, repositoryRelative, files) {
    let currentPath;
    for (const line of patch.split(/\r?\n/u)) {
        if (line.startsWith("+++ ")) {
            const raw = decodeGitQuotedPath(line.slice(4));
            currentPath = raw === "/dev/null"
                ? undefined
                : repositoryRelativePath(raw.replace(/^b\//u, ""), repositoryRelative);
            continue;
        }
        if (!currentPath || !line.startsWith("@@"))
            continue;
        const match = line.match(/\+(\d+)(?:,(\d+))?/u);
        if (!match?.[1])
            continue;
        const start = Number.parseInt(match[1], 10);
        const count = Number.parseInt(match[2] ?? "1", 10);
        if (count > 0)
            files.get(currentPath)?.changed_lines.push({ start, end: start + count - 1 });
    }
}
// Patch headers still use Git C-style quoting even when status/stat use -z.
function decodeGitQuotedPath(value) {
    if (!value.startsWith('"') || !value.endsWith('"'))
        return value;
    const bytes = [];
    const body = value.slice(1, -1);
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
    for (let index = 0; index < body.length;) {
        if (body[index] === "\\") {
            const octal = body.slice(index + 1).match(/^[0-7]{3}/u)?.[0];
            if (octal) {
                bytes.push(Number.parseInt(octal, 8));
                index += 4;
                continue;
            }
            const escaped = escapes[body[index + 1]];
            if (escaped !== undefined) {
                bytes.push(escaped);
                index += 2;
                continue;
            }
        }
        const char = String.fromCodePoint(body.codePointAt(index));
        bytes.push(...Buffer.from(char, "utf8"));
        index += char.length;
    }
    return Buffer.from(bytes).toString("utf8");
}
//# sourceMappingURL=phase3-git.js.map