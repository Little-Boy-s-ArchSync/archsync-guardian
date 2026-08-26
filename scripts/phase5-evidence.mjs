import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeInfrastructureSources,
  evaluateInfrastructureSecurity,
  parseKubernetes,
  parseTerraform,
} from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = join(root, "evidence", "phase-5-evidence.json");
const fixture = (...parts) => join(root, "test", "fixtures", "iac", ...parts);
const writeMode = process.argv.includes("--write");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(path) {
  return sha256(await readFile(join(root, path)));
}

async function treeSha256(directory) {
  const absoluteDirectory = join(root, directory);
  const files = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(absoluteDirectory);
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(relative(absoluteDirectory, path).replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(await readFile(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function sourceEvidence(source, file) {
  return {
    source,
    file,
    range: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 2, offset: 1 },
    },
    snippet: file,
    detector: `${source}-phase5-evidence`,
    confidence: 1,
  };
}

function architectureObservation(source, nativeId, name, kind, boundary) {
  return {
    source,
    source_class: source,
    native_id: nativeId,
    name,
    namespace: "orders",
    aliases: [name],
    kind,
    exposure: kind === "database" ? "private" : "internal",
    approved: true,
    trust_boundary: boundary,
    attributes: {},
    evidence: [sourceEvidence(source, `${source}/${nativeId}`)],
  };
}

function materializeSecurityGraph(value) {
  return {
    version: "0.1",
    identity_contract_version: "0.1",
    nodes: value.nodes.map((node, index) => ({
      ...node,
      namespace: node.id.split("/")[0],
      aliases: [node.id],
      sources: ["iac"],
      observations: [],
      evidence: [sourceEvidence("kubernetes", `security/node-${index}.yaml`)],
    })),
    edges: value.edges.map((edge, index) => ({
      ...edge,
      key: `${edge.from}|${edge.type}|${edge.to}`,
      resolved: edge.resolved ?? true,
      sources: ["kubernetes"],
      evidence: [sourceEvidence("kubernetes", `security/edge-${index}.yaml`)],
    })),
    diagnostics: [],
  };
}

async function coverageEvidence() {
  const summary = JSON.parse(await readFile(join(root, "coverage", "coverage-summary.json"), "utf8"));
  const measured = {};
  for (const metric of ["statements", "branches", "functions", "lines"]) {
    const value = summary.total?.[metric];
    assert.ok(value, `Coverage summary is missing '${metric}'`);
    assert.equal(value.pct, 100, `${metric} coverage must be 100%`);
    assert.equal(value.covered, value.total, `${metric} coverage contains uncovered items`);
    measured[metric] = {
      percent: value.pct,
      all_items_covered: true,
    };
  }
  return measured;
}

const terraformPositiveSource = await readFile(fixture("terraform", "positive.tf"), "utf8");
const terraformNegativeSource = await readFile(
  fixture("terraform", "dynamic-and-negative.tf"),
  "utf8",
);
const kubernetesPositiveSource = await readFile(fixture("kubernetes", "positive.yaml"), "utf8");
const kubernetesNegativeSource = await readFile(
  fixture("kubernetes", "missing-and-negative.yaml"),
  "utf8",
);

const architectureObservations = [
  architectureObservation("spec", "spec-api", "orders-api", "service", "application"),
  architectureObservation("code", "code-api", "orders-api", "service", "application"),
  architectureObservation("spec", "spec-db", "orders-db", "database", "data"),
  architectureObservation("code", "code-db", "orders-db", "database", "data"),
];
const analysisInput = {
  terraform_files: { "infra/main.tf": terraformPositiveSource },
  kubernetes_files: { "deploy/orders.yaml": kubernetesPositiveSource },
  architecture_observations: architectureObservations,
  architecture_references: [],
  alias_rules: [
    { canonical_id: "orders/orders-api", namespace: "any", aliases: ["orders-api"] },
    {
      canonical_id: "orders/orders-db",
      namespace: "any",
      aliases: ["orders-db", "orders"],
    },
    {
      canonical_id: "orders/orders-cache",
      namespace: "any",
      aliases: ["orders-cache"],
    },
    {
      canonical_id: "orders/orders-events",
      namespace: "any",
      aliases: ["orders-events"],
    },
    {
      canonical_id: "orders/public-edge",
      namespace: "any",
      aliases: ["public-edge"],
    },
  ],
};
const analysis = analyzeInfrastructureSources(analysisInput);
assert.deepEqual(
  analyzeInfrastructureSources(analysisInput),
  analysis,
  "Phase 5 controlled analysis changed across identical executions",
);
assert.equal(analysis.contract_version, "0.1");
assert.equal(analysis.graph.version, "0.1");
assert.equal(analysis.terraform.resources.length, 5);
assert.equal(analysis.kubernetes.resources.length, 4);
assert.equal(analysis.kubernetes.references.length, 3);

const terraformNegative = parseTerraform(terraformNegativeSource, "infra/negative.tf");
const kubernetesNegative = parseKubernetes(kubernetesNegativeSource, "deploy/negative.yaml");
assert.ok(
  terraformNegative.diagnostics.some(({ code }) => code === "unsupported-dynamic-expression"),
  "Terraform dynamic input did not produce an explicit diagnostic",
);
assert.ok(
  kubernetesNegative.diagnostics.some(({ code }) => code === "missing-reference"),
  "Kubernetes missing input did not produce an explicit diagnostic",
);

const positiveFixture = JSON.parse(await readFile(fixture("security", "positive.json"), "utf8"));
const negativeFixture = JSON.parse(
  await readFile(fixture("security", "hard-negative.json"), "utf8"),
);
const positiveFindings = evaluateInfrastructureSecurity(materializeSecurityGraph(positiveFixture));
const hardNegativeFindings = evaluateInfrastructureSecurity(materializeSecurityGraph(negativeFixture));
const requiredRules = [
  "IAC-PUBLIC-DATABASE",
  "IAC-TRUST-BOUNDARY",
  "IAC-UNAPPROVED-DATA-SERVICE",
  "IAC-UNEXPECTED-INGRESS",
];
assert.deepEqual(
  [...new Set(positiveFindings.map(({ rule_id }) => rule_id))].sort(),
  requiredRules,
  "Positive security fixture does not exercise every Phase 5 rule",
);
assert.deepEqual(hardNegativeFindings, [], "Hard-negative security fixture produced a finding");

const classificationCounts = Object.fromEntries(
  ["aligned", "contradiction", "identity-uncertain", "missing-source"].map((classification) => [
    classification,
    analysis.claims.filter((claim) => claim.classification === classification).length,
  ]),
);
const identityMethodCounts = Object.fromEntries(
  ["ambiguous", "explicit-alias", "name-only", "namespace-and-name", "unknown"].map((method) => [
    method,
    analysis.identities.resolutions.filter((resolution) => resolution.method === method).length,
  ]),
);

const sourceFiles = [
  "src/iac.ts",
  "src/iac-contracts.ts",
  "src/index.ts",
  "src/iac-governance.test.ts",
  "src/iac-kubernetes.ts",
  "src/iac-normalize.ts",
  "src/iac-security.ts",
  "src/iac-terraform.ts",
  "src/iac.test.ts",
  "src/iac-kubernetes.test.ts",
  "src/iac-normalize.test.ts",
  "src/iac-security.test.ts",
  "src/iac-terraform.test.ts",
];
const governanceFiles = [
  "README.md",
  "docs/BOUNDARY.md",
  "docs/OPERATIONS-PRIVACY.md",
  "docs/phase-5.md",
  "docs/schemas/infrastructure-graph-v0.1.schema.json",
  "docs/adr/0005-phase-5-infrastructure-evidence-boundary.md",
  "evidence/README.md",
];
const dependencyFiles = [
  ".github/workflows/ci.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.test.json",
  "vitest.config.ts",
  "scripts/phase5-evidence.mjs",
  "scripts/verify-clean-worktree.mjs",
  "scripts/verify-offline.mjs",
];

const evidence = {
  phase: 5,
  objective: "Preparatory deterministic Infrastructure-as-Evidence technical foundation",
  contract_version: "0.1",
  governance: {
    adr_0005: "Proposed",
    phase_5_lead_approval: "Pending",
    security_approval: "Pending",
    p4_120_approval_claimed: false,
    phase_4_benchmark_freeze_claimed: false,
    phase_5_benchmark_freeze_claimed: false,
  },
  source_sha256: Object.fromEntries(
    await Promise.all(sourceFiles.map(async (path) => [path, await fileSha256(path)])),
  ),
  generated_dist_sha256: await treeSha256("dist"),
  input_sha256: {
    "test/fixtures/iac": await treeSha256("test/fixtures/iac"),
  },
  governance_sha256: Object.fromEntries(
    await Promise.all(governanceFiles.map(async (path) => [path, await fileSha256(path)])),
  ),
  dependency_sha256: Object.fromEntries(
    await Promise.all(dependencyFiles.map(async (path) => [path, await fileSha256(path)])),
  ),
  measured_coverage: await coverageEvidence(),
  coverage_count_policy:
    "Raw V8 item counts are verified covered=total at runtime but omitted because they vary across supported Node majors and instrumentation contexts",
  controlled_scenario: {
    deterministic_sha256: sha256(JSON.stringify(analysis)),
    terraform_resources: analysis.terraform.resources.length,
    terraform_diagnostics: terraformNegative.diagnostics.map(({ code }) => code),
    kubernetes_resources: analysis.kubernetes.resources.length,
    kubernetes_references: analysis.kubernetes.references.length,
    kubernetes_diagnostics: kubernetesNegative.diagnostics.map(({ code }) => code),
    normalized_nodes: analysis.graph.nodes.length,
    normalized_edges: analysis.graph.edges.length,
    identity_methods: identityMethodCounts,
    claim_classifications: classificationCounts,
    controlled_security_rules: [...new Set(analysis.security_findings.map(({ rule_id }) => rule_id))].sort(),
  },
  security_fixtures: {
    positive_findings: positiveFindings.map(({ rule_id, subject, edge }) => ({ rule_id, subject, edge })),
    hard_negative_findings: hardNegativeFindings.length,
    required_rules: requiredRules,
  },
  exclusions: [
    "ADR-0005 acceptance and Phase 5 Lead/Security approval",
    "P4-120 or Phase 4/Phase 5 benchmark freeze",
    "Terraform execution, modules, data sources, providers, state and dynamic expressions",
    "Helm, Kustomize, Jsonnet, CRDs, admission mutation and live-cluster state",
    "Cloud credentials, deployment mutation, automatic repair and approval",
  ],
};

const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (writeMode) {
  await writeFile(evidencePath, serialized, "utf8");
  console.log(`WROTE ${evidencePath}`);
} else {
  assert.equal(
    await readFile(evidencePath, "utf8"),
    serialized,
    "Phase 5 evidence is stale; run 'pnpm phase5:evidence:update' and commit the result",
  );
  console.log(`VALID PHASE 5 EVIDENCE ${evidencePath}`);
}
