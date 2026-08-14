import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyBenchmarkDelta, edgeKey, loadArchitecture, } from "@archsync/core";
import { checkRepository } from "./guardian.js";
function metricCounts(expected, actual) {
    const truePositive = [...actual].filter((value) => expected.has(value)).length;
    const falsePositive = [...actual].filter((value) => !expected.has(value)).length;
    const falseNegative = [...expected].filter((value) => !actual.has(value)).length;
    const precision = truePositive + falsePositive === 0
        ? 1
        : truePositive / (truePositive + falsePositive);
    const recall = truePositive + falseNegative === 0
        ? 1
        : truePositive / (truePositive + falseNegative);
    return {
        true_positive: truePositive,
        false_positive: falsePositive,
        false_negative: falseNegative,
        precision,
        recall,
        f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
    };
}
function mergeCounts(values) {
    const expected = new Set();
    const actual = new Set();
    let expectedSequence = 0;
    let actualSequence = 0;
    for (const value of values) {
        for (let index = 0; index < value.true_positive; index += 1) {
            const key = `tp-${expectedSequence++}`;
            expected.add(key);
            actual.add(key);
        }
        for (let index = 0; index < value.false_negative; index += 1) {
            expected.add(`fn-${expectedSequence++}`);
        }
        for (let index = 0; index < value.false_positive; index += 1) {
            actual.add(`fp-${actualSequence++}`);
        }
    }
    return metricCounts(expected, actual);
}
function sorted(values) {
    return [...values].sort();
}
function sameValues(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function expectedEvidenceMatch(scenario, result) {
    if (scenario.expected.findings.length === 0)
        return { file: true, line: true, actual: [] };
    const expectedLocation = scenario.expected.evidence[0];
    if (!expectedLocation)
        return { file: false, line: false, actual: [] };
    const expectedFinding = scenario.expected.findings[0];
    const actual = result.findings.find((finding) => finding.rule_id === expectedFinding.id ||
        (finding.kind === expectedFinding.kind &&
            finding.edge?.from === expectedFinding.from &&
            finding.edge?.to === expectedFinding.to));
    if (!actual)
        return { file: false, line: false, actual: [] };
    const matchingFile = actual.source_evidence.filter((evidence) => evidence.file === expectedLocation.file);
    return {
        file: matchingFile.length > 0,
        line: matchingFile.some((evidence) => evidence.line === expectedLocation.line),
        actual: actual.source_evidence,
    };
}
function round(value) {
    return Number(value.toFixed(6));
}
function roundedCounts(value) {
    return {
        ...value,
        precision: round(value.precision),
        recall: round(value.recall),
        f1: round(value.f1),
    };
}
export async function evaluatePhase2Benchmark(manifestPath, dependencies = {}) {
    const absoluteManifest = resolve(manifestPath);
    const baseDirectory = dirname(absoluteManifest);
    const groundTruth = JSON.parse(await readFile(absoluteManifest, "utf8"));
    const architectureResult = await loadArchitecture(resolve(baseDirectory, groundTruth.benchmark.architecture));
    if (!architectureResult.valid || !architectureResult.value) {
        throw new Error(`Invalid benchmark architecture: ${architectureResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join(", ")}`);
    }
    const expected = architectureResult.value;
    const repository = resolve(baseDirectory, groundTruth.benchmark.repository);
    const checker = dependencies.checkRepository ?? checkRepository;
    const baselineResult = await checker(expected, repository);
    const baselineRepeat = await checker(expected, repository);
    const baselineDeterministic = JSON.stringify(baselineResult) === JSON.stringify(baselineRepeat);
    const issues = [];
    if (baselineResult.classification !== "no-impact") {
        issues.push(`baseline: expected no-impact, found ${baselineResult.classification}`);
    }
    if (!baselineDeterministic)
        issues.push("baseline: analyzer output is nondeterministic");
    const fullGraphNodeCounts = [];
    const fullGraphEdgeCounts = [];
    const changedNodeCounts = [];
    const changedEdgeCounts = [];
    const cases = [];
    let evidenceCases = 0;
    let evidenceFileMatches = 0;
    let evidenceLineMatches = 0;
    let classificationMatches = 0;
    for (const scenario of groundTruth.cases) {
        const temporary = await mkdtemp(join(tmpdir(), `archsync-${scenario.id}-`));
        try {
            await cp(repository, temporary, { recursive: true });
            const patchPath = resolve(baseDirectory, scenario.patch);
            const applied = spawnSync("git", ["apply", "--whitespace=nowarn", patchPath], {
                cwd: temporary,
                encoding: "utf8",
                shell: false,
            });
            if (applied.status !== 0) {
                throw new Error(`${scenario.id}: patch failed: ${applied.stderr.trim()}`);
            }
            const actual = await checker(expected, temporary);
            const repeated = await checker(expected, temporary);
            const deterministic = JSON.stringify(actual) === JSON.stringify(repeated);
            const expectedObserved = applyBenchmarkDelta(expected, scenario.delta);
            const expectedFullNodes = new Set(Object.keys(expectedObserved.components));
            const actualFullNodes = new Set(Object.keys(actual.observed.components));
            fullGraphNodeCounts.push(metricCounts(expectedFullNodes, actualFullNodes));
            const expectedFullEdges = new Set(expectedObserved.relationships.map(edgeKey));
            const actualFullEdges = new Set(actual.observed.relationships.map(edgeKey));
            fullGraphEdgeCounts.push(metricCounts(expectedFullEdges, actualFullEdges));
            const expectedAddedNodes = sorted(Object.keys(scenario.delta.components_added ?? {}));
            const expectedRemovedNodes = sorted(scenario.delta.components_removed ?? []);
            const actualAddedNodes = sorted(actual.diff.added_nodes);
            const actualRemovedNodes = sorted(actual.diff.removed_nodes);
            const expectedChangedNodes = new Set([
                ...expectedAddedNodes.map((id) => `added:${id}`),
                ...expectedRemovedNodes.map((id) => `removed:${id}`),
            ]);
            const actualChangedNodes = new Set([
                ...actualAddedNodes.map((id) => `added:${id}`),
                ...actualRemovedNodes.map((id) => `removed:${id}`),
            ]);
            changedNodeCounts.push(metricCounts(expectedChangedNodes, actualChangedNodes));
            const expectedAdded = sorted((scenario.delta.relationships_added ?? []).map(edgeKey));
            const expectedRemoved = sorted((scenario.delta.relationships_removed ?? []).map(edgeKey));
            const actualAdded = sorted(actual.diff.added_edges);
            const actualRemoved = sorted(actual.diff.removed_edges);
            const expectedChanged = new Set([
                ...expectedAdded.map((key) => `added:${key}`),
                ...expectedRemoved.map((key) => `removed:${key}`),
            ]);
            const actualChanged = new Set([
                ...actualAdded.map((key) => `added:${key}`),
                ...actualRemoved.map((key) => `removed:${key}`),
            ]);
            changedEdgeCounts.push(metricCounts(expectedChanged, actualChanged));
            const expectedRules = sorted(scenario.expected.findings
                .filter((finding) => finding.kind !== "architecture-evolution")
                .map((finding) => finding.id));
            const actualRules = sorted(actual.findings
                .filter((finding) => finding.rule_id)
                .map((finding) => finding.rule_id));
            const evidence = expectedEvidenceMatch(scenario, actual);
            if (scenario.expected.findings.length > 0) {
                evidenceCases += 1;
                if (evidence.file)
                    evidenceFileMatches += 1;
                if (evidence.line)
                    evidenceLineMatches += 1;
            }
            const classificationMatch = actual.classification === scenario.expected.classification;
            if (classificationMatch)
                classificationMatches += 1;
            const ruleMatch = sameValues(expectedRules, actualRules);
            const caseResult = {
                id: scenario.id,
                expected: scenario.expected.classification,
                actual: actual.classification,
                classification_match: classificationMatch,
                expected_rule_ids: expectedRules,
                actual_rule_ids: actualRules,
                rule_match: ruleMatch,
                expected_added_nodes: expectedAddedNodes,
                actual_added_nodes: actualAddedNodes,
                expected_removed_nodes: expectedRemovedNodes,
                actual_removed_nodes: actualRemovedNodes,
                expected_added_edges: expectedAdded,
                actual_added_edges: actualAdded,
                expected_removed_edges: expectedRemoved,
                actual_removed_edges: actualRemoved,
                evidence_file_match: evidence.file,
                evidence_line_match: evidence.line,
                expected_evidence: scenario.expected.evidence.map(({ file, line }) => ({ file, line })),
                actual_evidence: evidence.actual,
                deterministic,
            };
            cases.push(caseResult);
            if (!classificationMatch)
                issues.push(`${scenario.id}: classification ${actual.classification} != ${scenario.expected.classification}`);
            if (!ruleMatch)
                issues.push(`${scenario.id}: rule findings [${actualRules.join(", ")}] != [${expectedRules.join(", ")}]`);
            if (!deterministic)
                issues.push(`${scenario.id}: analyzer output is nondeterministic`);
            if (!evidence.file)
                issues.push(`${scenario.id}: source evidence file does not match ground truth`);
            if (!evidence.line)
                issues.push(`${scenario.id}: source evidence line does not match ground truth`);
        }
        finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }
    const fullGraphNodes = mergeCounts(fullGraphNodeCounts);
    const fullGraphEdges = mergeCounts(fullGraphEdgeCounts);
    const changedNodes = mergeCounts(changedNodeCounts);
    const changedEdges = mergeCounts(changedEdgeCounts);
    if (fullGraphNodes.precision < 0.85 || fullGraphNodes.recall < 0.85) {
        issues.push("metrics: full graph node precision/recall is below 0.85");
    }
    if (fullGraphEdges.precision < 0.85 || fullGraphEdges.recall < 0.85) {
        issues.push("metrics: full graph edge precision/recall is below 0.85");
    }
    if (changedNodes.precision < 0.85 || changedNodes.recall < 0.85) {
        issues.push("metrics: changed node precision/recall is below 0.85");
    }
    if (changedEdges.precision < 0.85 || changedEdges.recall < 0.85) {
        issues.push("metrics: changed edge precision/recall is below 0.85");
    }
    return {
        contract_version: "0.1",
        benchmark: groundTruth.benchmark.id,
        valid: issues.length === 0,
        issues,
        baseline: {
            components: Object.keys(baselineResult.observed.components).length,
            relationships: baselineResult.observed.relationships.length,
            deterministic: baselineDeterministic,
            classification: baselineResult.classification,
        },
        metrics: {
            full_graph_nodes: roundedCounts(fullGraphNodes),
            full_graph_edges: roundedCounts(fullGraphEdges),
            changed_nodes: roundedCounts(changedNodes),
            changed_edges: roundedCounts(changedEdges),
            classification_accuracy: round(classificationMatches / groundTruth.cases.length),
            evidence_file_accuracy: round(evidenceCases === 0 ? 1 : evidenceFileMatches / evidenceCases),
            evidence_line_accuracy: round(evidenceCases === 0 ? 1 : evidenceLineMatches / evidenceCases),
            deterministic_cases: cases.filter((scenario) => scenario.deterministic).length,
            total_cases: groundTruth.cases.length,
        },
        cases,
    };
}
export function formatBenchmarkResult(result) {
    const status = result.valid ? "VALID" : "INVALID";
    const lines = [
        `${status} PHASE 2 BENCHMARK ${result.benchmark}`,
        `- baseline: ${result.baseline.components} components, ${result.baseline.relationships} relationships, ${result.baseline.classification}`,
        `- full graph nodes: precision ${result.metrics.full_graph_nodes.precision.toFixed(3)}, recall ${result.metrics.full_graph_nodes.recall.toFixed(3)}, F1 ${result.metrics.full_graph_nodes.f1.toFixed(3)}`,
        `- full graph edges: precision ${result.metrics.full_graph_edges.precision.toFixed(3)}, recall ${result.metrics.full_graph_edges.recall.toFixed(3)}, F1 ${result.metrics.full_graph_edges.f1.toFixed(3)}`,
        `- changed nodes: precision ${result.metrics.changed_nodes.precision.toFixed(3)}, recall ${result.metrics.changed_nodes.recall.toFixed(3)}, F1 ${result.metrics.changed_nodes.f1.toFixed(3)}`,
        `- changed edges: precision ${result.metrics.changed_edges.precision.toFixed(3)}, recall ${result.metrics.changed_edges.recall.toFixed(3)}, F1 ${result.metrics.changed_edges.f1.toFixed(3)}`,
        `- classification accuracy: ${result.metrics.classification_accuracy.toFixed(3)}`,
        `- source evidence: file ${result.metrics.evidence_file_accuracy.toFixed(3)}, exact line ${result.metrics.evidence_line_accuracy.toFixed(3)}`,
        `- deterministic: ${result.metrics.deterministic_cases}/${result.metrics.total_cases} cases`,
    ];
    lines.push(...result.issues.map((issue) => `- ERROR ${issue}`));
    return lines.join("\n");
}
//# sourceMappingURL=benchmark.js.map