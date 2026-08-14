import type { ArchitectureDocument } from "@archsync/core";
import type { ChangedFile } from "./phase3.js";
export declare const sourceExtensions: string[];
export declare function portablePath(value: string): string;
export declare function sourceComponent(file: string, expected: ArchitectureDocument): string | undefined;
export declare function repositoryRelativePath(gitPath: string, repositoryRelative: string): string | undefined;
export declare function parseNameStatus(output: string, repositoryRelative: string): Map<string, ChangedFile>;
export declare function parseNumStat(output: string, repositoryRelative: string, files: Map<string, ChangedFile>): void;
export declare function parseChangedLines(patch: string, repositoryRelative: string, files: Map<string, ChangedFile>): void;
//# sourceMappingURL=phase3-git.d.ts.map