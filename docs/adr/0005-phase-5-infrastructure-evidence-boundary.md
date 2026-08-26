# ADR-0005: Proposed infrastructure evidence boundary

## Status

**Proposed — not approved.** Adoption requires an explicit approval from the
designated Phase 5 Lead and an independent Security reviewer. A passing test,
commit, pull request, code review comment, or generated evidence manifest is
not approval of this ADR unless both approvals are recorded below against the
exact commit.

| Required role | Status | Reviewer | Commit | Approval link |
| --- | --- | --- | --- | --- |
| Phase 5 Lead | Pending | — | — | — |
| Security reviewer | Pending | — | — | — |

This preparatory implementation also does not claim that P4-120, a Phase 4
benchmark freeze, or any Phase 5 benchmark has been approved.

## Context

Architecture intent, application source and Infrastructure as Code describe
different views of the same deployed system. Joining them by an unqualified
name can silently merge unrelated resources; executing Terraform or rendering
arbitrary templates during analysis would make the result environment-dependent
and unsafe. Conversely, ignoring unsupported constructs would make an incomplete
graph look authoritative.

Phase 5 therefore needs a deterministic evidence contract before broader IaC
coverage or a merge decision can be proposed.

## Proposed decision

If approved, Guardian will use the following boundary:

1. The approved architecture specification remains intent. TypeScript analysis
   remains code observation. Terraform and Kubernetes parsing add IaC
   observations; none of the observations silently rewrites intent.
2. Terraform is parsed as text. Guardian does not run `terraform`, providers,
   modules, data sources, functions, `for_each`, `count` or dynamic blocks.
   Unsupported expressions produce ranged diagnostics and are never interpreted
   as literal exposure or approval.
3. Kubernetes input is parsed as a multi-document YAML stream. Phase 5 covers
   Deployment, Service, Ingress and ConfigMap references. It does not render
   Helm, Kustomize, Jsonnet, operators or admission mutations. Unrendered
   templates and missing references remain explicit diagnostics.
4. Cross-source identity uses explicit aliases first, then namespace and name.
   A name-only join is allowed only when one side is intentionally unscoped and
   all scoped candidates agree on one namespace. Ambiguous and unknown
   identities remain separate nodes with confidence and source evidence.
5. The normalized graph is versioned, stable-sorted and de-duplicated. Every
   node, edge, claim, conflict and finding retains file/range evidence.
6. Spec-code-IaC claims report `aligned`, `contradiction`, `missing-source` or
   `identity-uncertain`. Guardian does not choose a winner for a contradiction.
7. The preparatory security policy reports public databases, unexpected public
   ingress, unapproved trust-boundary transitions and unapproved broker/cache
   resources. It does not provision, delete, quarantine or approve resources.
8. Unsupported or incomplete analysis is visible in diagnostics and cannot be
   represented as a successful full-infrastructure assessment.

## Proposed adoption gates

The ADR may move to Accepted only after:

- the Phase 5 Lead approves the exact contract and supported-resource table;
- the Security reviewer approves rule scope, severity and hard-negative
  fixtures against the exact commit;
- both approvals are independently attributable and linked in the table above;
- the repository verification gate remains at 100% statement, branch, function
  and line coverage; and
- benchmark ownership, ground truth and freeze status are documented separately
  rather than inferred from this technical foundation.

## Consequences if accepted

- Static IaC findings are reproducible and reviewable without cloud credentials.
- Dynamic configurations remain incomplete until rendered input or a future
  separately approved evaluator is supplied.
- Alias governance becomes part of architecture review rather than a fuzzy
  matching heuristic.
- A security finding is evidence for review, not authorization to change the
  architecture or deployed environment.
