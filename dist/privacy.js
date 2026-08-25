import { homedir } from "node:os";
import { resolve } from "node:path";
const credentialPatterns = [
    [/\b(?:github_pat_|gh[opusr]_|glpat-)[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_TOKEN]"],
    [/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_TOKEN]"],
    [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?)[^\s,"']+/giu, "$1[REDACTED]"],
    [/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, "$1[REDACTED]"],
    [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/giu, "$1[REDACTED]@"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]"],
];
function replacePath(value, path, label) {
    const normalized = resolve(path);
    return normalized.length > 1 ? value.replaceAll(normalized, label) : value;
}
/**
 * Removes common credentials, personal addresses, and machine-specific roots
 * from anything that may reach a terminal, CI annotation, or persisted report.
 */
export function redactSensitiveText(input, context = {}) {
    let output = input;
    for (const [pattern, replacement] of credentialPatterns) {
        output = output.replace(pattern, replacement);
    }
    output = replacePath(output, context.workspace ?? process.cwd(), "$WORKSPACE");
    output = replacePath(output, context.home ?? homedir(), "$HOME");
    return output;
}
export function redactDiagnosticPath(path, context = {}) {
    return redactSensitiveText(resolve(path), context);
}
//# sourceMappingURL=privacy.js.map