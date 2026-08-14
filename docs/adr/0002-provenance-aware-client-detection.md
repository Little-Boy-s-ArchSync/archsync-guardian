# ADR-0002: Require package provenance for infrastructure client detection

**Status:** Accepted

**Date:** 2026-08-14

## Context

The v0.1 TypeScript analyzer used package presence plus method names such as `query`, `get`, `publish` and `consume`. This was deterministic, but an unused infrastructure import could cause unrelated objects with the same method names to be reported as architecture edges. The initial Redis operation list also omitted common commands such as `hSet` and `lPush`.

## Decision

Guardian v0.2 records the local bindings introduced by `pg`, `redis` and `amqplib` imports. It recognizes named aliases and namespace imports, then propagates endpoints only through clients, connections and channels constructed from those tracked bindings. Infrastructure operations are accepted only on the resulting variables. The supported Redis operation set is expanded to common string, hash, list, set, sorted-set and expiry commands.

`fetch` remains a global-call detector because the Node.js runtime exposes it globally. Its endpoint must still resolve to a string or template literal that maps to an architecture component.

## Consequences

- Unrelated objects with method names such as `query`, `get`, `publish` or `consume` no longer create edges merely because an infrastructure package is imported elsewhere in the file.
- Named aliases and namespace imports remain detectable.
- The implementation is still intentionally intra-file and syntactic. Factory wrappers, dependency injection, re-exports and dynamically constructed endpoints remain outside the v0.2 claim.
- The separate detector challenge corpus records both positive and hard-negative signals so future changes can be measured against this decision.
