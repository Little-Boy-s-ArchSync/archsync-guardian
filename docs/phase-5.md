# Phase 5 preparatory foundation: Infrastructure as Evidence

## Status and non-claims

This branch is a **technical preparation** for Phase 5. ADR-0005 remains
Proposed and requires separate Phase 5 Lead and Security approvals. The code and
evidence in this repository do not claim P4-120 approval, a Phase 4 benchmark
freeze, a Phase 5 benchmark freeze, production cloud coverage or permission to
merge/deploy infrastructure changes.

## Work-item traceability

| Work item | Preparatory artifact | Gate |
| --- | --- | --- |
| P5-101 | `docs/adr/0005-phase-5-infrastructure-evidence-boundary.md` | Lead + Security approval pending |
| P5-102 | `iac-normalize.ts#mapCrossSourceIdentities` | aliases, namespaces, ambiguity, unknowns, confidence and evidence tested |
| P5-103 | `iac-terraform.ts` | narrow literal parser; dynamic constructs are diagnostics |
| P5-104 | `iac-kubernetes.ts` | multi-document Deployment/Service/Ingress/ConfigMap parser and reference checks |
| P5-105 | `iac-normalize.ts#buildNormalizedInfrastructureGraph` | Graph v0.1 stable sort and de-duplication |
| P5-106 | `iac-normalize.ts#buildCrossSourceEvidenceClaims` | spec-code-IaC values and missing-source set retained |
| P5-107 | `iac-normalize.ts#classifyEvidenceClaims` | deterministic four-state classifier |
| P5-108 | `iac-security.ts` | four rules with positive and hard-negative fixtures |

Public exports are available from `@archsync/guardian`; this preparatory branch
does not add a Phase 5 CLI or change the Phase 3 merge-decision contract.

## Deterministic flow

```text
architecture observations ─┐
TypeScript observations ────┼─> identity map ─> normalized graph v0.1
Terraform literals ─────────┤                         │
Kubernetes YAML ────────────┘                         ├─> evidence claims/conflicts
unsupported diagnostics ─────────────────────────────└─> security findings
```

Every output is stable-sorted. Duplicate evidence is keyed by source, file,
range, detector and confidence. Duplicate edges are keyed by canonical
`from|type|to`; sources and evidence are merged without losing provenance.
The machine-readable Graph v0.1 contract is
`docs/schemas/infrastructure-graph-v0.1.schema.json`; unresolved edges retain
`resolved: false` and are not evaluated as trust-boundary transitions.

## Terraform subset

Guardian recognizes resource blocks and literal strings, booleans, numbers and
string lists. It records the full resource source range and supports these
resource families:

| Provider | Database | Cache | Broker | Public entry point |
| --- | --- | --- | --- | --- |
| AWS | `aws_db_instance`, `aws_rds_cluster`, `aws_redshift_cluster` | `aws_elasticache_cluster`, `aws_elasticache_replication_group` | `aws_mq_broker`, `aws_msk_cluster` | `aws_lb`, `aws_alb` |
| Azure | PostgreSQL/MySQL flexible server, MSSQL server, Cosmos DB | `azurerm_redis_cache` | Service Bus/Event Hub namespace | Application Gateway |
| GCP | Cloud SQL instance | Memorystore Redis instance | Pub/Sub topic | Compute forwarding rule |

Exposure is literal-only: public-access booleans, internet-facing schemes and
world CIDRs are recognized. Explicit false/internal values remain private or
internal. Unknown resource types remain graph observations of kind `unknown`
and produce `unsupported-resource` diagnostics.

Modules, data blocks, dynamic blocks, interpolation, references, functions,
conditionals, `for_each`, `count`, multi-line/non-string collections and malformed
blocks are not evaluated. Each produces an explicit ranged diagnostic. Guardian
does not run Terraform or access state, providers or cloud accounts.

## Kubernetes subset

The YAML parser handles streams containing:

- Deployment identity, pod labels, replicas and ConfigMap references from
  `envFrom`, `env.valueFrom` and volumes;
- Service type, selector resolution and public/internal exposure;
- Ingress default/rule backends, public/internal exposure and Service
  references; and
- ConfigMap identity used by reference resolution.

References are resolved after every document is parsed, so document order does
not affect the result. Missing and ambiguous selectors, missing ConfigMaps,
missing Ingress Services, malformed YAML, objects without identity, unsupported
kinds and unrendered templates are explicit diagnostics. Helm, Kustomize,
Jsonnet, CRD semantics, runtime defaults and admission mutation are not inferred.

Annotations used by the preparatory contract:

- `archsync.io/approved: "true"` records architecture approval evidence;
- `archsync.io/trust-boundary: <id>` records a boundary observation; and
- `archsync.io/approved-trust-transition: "true"` records an explicit edge
  approval observation.

These annotations are evidence inputs; their governance must be enforced by
CODEOWNERS or an equivalent human approval mechanism.

## Identity, claims and conflicts

Identity resolution order is explicit alias, namespace-and-name, constrained
name-only, ambiguous, then unknown. It never uses edit distance or an LLM.
Confidence is `1.00`, `0.99`, `0.75`, `0.00` or `0.25` respectively. Unknown and
ambiguous resources remain separate canonical IDs.

For each normalized node, Guardian creates claims for identity, kind, exposure
and trust boundary. Values retain their `spec`, `code` or `iac` source class and
evidence. Classification is:

| Classification | Deterministic condition |
| --- | --- |
| `identity-uncertain` | canonical identity is unknown or ambiguous |
| `contradiction` | at least two distinct reported values |
| `missing-source` | one value but at least one of spec/code/IaC is absent |
| `aligned` | all three source classes report one value |

The graph uses spec-then-code-then-IaC precedence only to provide a stable
display value. Claims preserve every disagreement, and security rules inspect
the underlying observations where a safer interpretation is required.

## Preparatory security rules

| Rule | Trigger | Severity |
| --- | --- | --- |
| `IAC-PUBLIC-DATABASE` | a database node or underlying observation is public | Critical |
| `IAC-UNEXPECTED-INGRESS` | public Ingress without explicit approval | High |
| `IAC-TRUST-BOUNDARY` | route/connect edge crosses known boundaries without edge approval | Critical |
| `IAC-UNAPPROVED-DATA-SERVICE` | broker or cache without explicit approval | High |

Fixtures under `test/fixtures/iac/security/` contain one positive corpus and a
hard-negative corpus covering private databases, approved ingress/data services,
approved transitions, same-boundary edges, unknown endpoints and irrelevant
edge types.

## Verification

```text
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm phase5:evidence:verify
```

`test:coverage` enforces 100% statements, branches, functions and lines across
the complete Guardian deterministic engine. The Phase 5 evidence verifier
re-runs the controlled IaC scenario, checks stable re-execution, validates all
four rule families and binds implementation, tests, fixtures, documentation,
package metadata and the lockfile by SHA-256.
