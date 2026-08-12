import { type ArchitectureDocument } from "@archsync/core";
import { type GuardianResult, type ObservedArchitecture } from "./contracts.js";
export declare function evaluateObservedArchitecture(expected: ArchitectureDocument, observed: ObservedArchitecture): GuardianResult;
export declare function checkRepository(expected: ArchitectureDocument, repositoryPath: string): Promise<GuardianResult>;
export declare function formatGuardianResult(result: GuardianResult): string;
//# sourceMappingURL=guardian.d.ts.map