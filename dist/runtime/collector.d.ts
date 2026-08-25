import { type OtlpExport, type RuntimeCollectionOptions, type RuntimeEvidenceSnapshot } from "./contracts.js";
export declare const storedRuntimeAttributeAllowlist: readonly ["archsync.goal.id", "db.system", "deployment.environment.name", "http.request.method", "messaging.destination.name", "messaging.system", "peer.service", "rpc.system", "server.address", "service.name"];
export declare class RuntimeEvidenceError extends Error {
    constructor(path: string, message: string);
}
export declare function collectRuntimeEvidence(value: OtlpExport | unknown, options: RuntimeCollectionOptions): RuntimeEvidenceSnapshot;
export declare function serializeRuntimeEvidence(snapshot: RuntimeEvidenceSnapshot): string;
//# sourceMappingURL=collector.d.ts.map