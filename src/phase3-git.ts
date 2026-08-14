import { sep } from "node:path";

import type { ArchitectureDocument } from "@archsync/core";

import type { ChangedFile } from "./phase3.js";

export const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];

export function portablePath(value: string): string {
  return value.split(sep).join("/");
}

export function sourceComponent(file: string, expected: ArchitectureDocument): string | undefined {
  if (!sourceExtensions.some((extension) => file.endsWith(extension)) || file.endsWith(".d.ts")) {
    return undefined;
  }
  const known = Object.keys(expected.components)
    .sort((a, b) => b.length - a.length)
    .find((id) => file === id || file.startsWith(`${id}/`));
  return known ?? file.split("/")[0]!;
}

export function repositoryRelativePath(
  gitPath: string,
  repositoryRelative: string,
): string | undefined {
  const normalized = portablePath(gitPath);
  if (!repositoryRelative) return normalized;
  const prefix = `${repositoryRelative}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

function statusName(value: string): ChangedFile["status"] {
  if (value.startsWith("A")) return "added";
  if (value.startsWith("D")) return "deleted";
  if (value.startsWith("R")) return "renamed";
  return "modified";
}

export function parseNameStatus(output: string, repositoryRelative: string): Map<string, ChangedFile> {
  const files = new Map<string, ChangedFile>();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const [rawStatus, first, second] = line.split("\t");
    if (!rawStatus || !first) continue;
    const renamed = rawStatus.startsWith("R") && second;
    const currentPath = repositoryRelativePath(renamed ? second : first, repositoryRelative);
    if (!currentPath) continue;
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

export function parseNumStat(
  output: string,
  repositoryRelative: string,
  files: Map<string, ChangedFile>,
): void {
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const rawPath = pathParts.at(-1);
    if (!rawPath) continue;
    const path = repositoryRelativePath(rawPath, repositoryRelative);
    if (!path) continue;
    const file = files.get(path);
    if (!file) continue;
    file.additions = Number.parseInt(added!, 10) || 0;
    file.deletions = Number.parseInt(deleted!, 10) || 0;
  }
}

export function parseChangedLines(
  patch: string,
  repositoryRelative: string,
  files: Map<string, ChangedFile>,
): void {
  let currentPath: string | undefined;
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4);
      currentPath = raw === "/dev/null"
        ? undefined
        : repositoryRelativePath(raw.replace(/^b\//u, ""), repositoryRelative);
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) continue;
    const match = line.match(/\+(\d+)(?:,(\d+))?/u);
    if (!match?.[1]) continue;
    const start = Number.parseInt(match[1], 10);
    const count = Number.parseInt(match[2] ?? "1", 10);
    if (count > 0) files.get(currentPath)?.changed_lines.push({ start, end: start + count - 1 });
  }
}
