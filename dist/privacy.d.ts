export interface RedactionContext {
    home?: string;
    workspace?: string;
}
/**
 * Removes common credentials, personal addresses, and machine-specific roots
 * from anything that may reach a terminal, CI annotation, or persisted report.
 */
export declare function redactSensitiveText(input: string, context?: RedactionContext): string;
export declare function redactDiagnosticPath(path: string, context?: RedactionContext): string;
//# sourceMappingURL=privacy.d.ts.map