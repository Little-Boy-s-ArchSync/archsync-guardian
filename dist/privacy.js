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
function isPortableAbsolute(path) {
    if (path.startsWith("/") || path.startsWith("\\\\"))
        return true;
    return /^[A-Za-z]:[\\/]/u.test(path);
}
function replacePath(value, path, label) {
    const candidates = new Set([
        path,
        path.replaceAll("\\", "/"),
        path.replaceAll("/", "\\"),
    ]);
    if (!isPortableAbsolute(path))
        candidates.add(resolve(path));
    let output = value;
    for (const candidate of candidates) {
        if (candidate.length > 1)
            output = output.replaceAll(candidate, label);
    }
    return output;
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
    const absolute = isPortableAbsolute(path) ? path : resolve(path);
    return redactSensitiveText(absolute, context).replaceAll("\\", "/");
}
//# sourceMappingURL=privacy.js.map