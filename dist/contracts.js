export const observedGraphVersion = "0.1";
export const findingContractVersion = "0.1";
export const sourceEvidenceContractVersion = "0.1";
export const guardianResultContractVersion = "0.1";
export const guardianAnalyzerVersion = "0.2";
export function toArchitectureDocument(expected, observed) {
    return {
        version: expected.version,
        metadata: { name: observed.metadata.name },
        components: Object.fromEntries(Object.entries(observed.components).map(([id, value]) => [id, value.component])),
        relationships: observed.relationships.map(({ evidence: _evidence, ...relationship }) => relationship),
    };
}
//# sourceMappingURL=contracts.js.map