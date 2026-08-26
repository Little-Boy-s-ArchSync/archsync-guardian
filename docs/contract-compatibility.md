# Core–Guardian contract compatibility

This document records the downstream Guardian side of CORE-101. Package versions and data-contract versions are separate: `@archsync/core` package `0.1.1` contains several independently versioned contracts, while Guardian owns richer source-observation contracts with their own versions.

## Exact dependency status

This integration consumes the exact head commit of merged Core integration pull request [#3](https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/3):

```text
503b5fe97aa39a78d5e5de80b794a94508e106cc
```

The integration commit combines CORE-101 pull request [#1](https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/1) commit `a1f0143aa8eb917aa0d93e28101b1893347453e2` and the proposed Phase 6 quality-goal commit `783716d7961690b1e8c1cda4acb956777977a853`. The active vendored `@archsync/core` package has SHA-256 `7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9`. Its [machine-readable provenance](../vendor/archsync-core-0.1.1-integration-503b5fe.provenance.json) records two byte-identical clean pack runs. This is test evidence for an exact merged source commit, not a claim that the package is released or available from a registry.

## Contract map

| Owner | Contract | Read/write version | Guardian use |
| --- | --- | --- | --- |
| Core | Architecture Model | current `0.1.1`; previous `0.1.0`; deprecated alias `0.1` | Guardian passes the Core-validated document into source analysis and conformance. Other versions fail before interpretation. |
| Core | Normalized graph / graph diff | `1.0.0` | Core builds and diffs the expected/observed model graphs. Guardian converts its observed source graph into a Core `ArchitectureDocument` but does not claim ownership of Core graph semantics. |
| Core | Finding | `1.0.0` | Core produces deterministic rule/evolution findings. Guardian enriches them into Guardian Finding `0.1`; it does not relabel the richer record as a Core finding. |
| Core | Evidence location | `1.0.0` | Preserved as `GuardianFinding.model_evidence`, including `schema_version`, `document`, and JSON path. It is distinct from Guardian source evidence. |
| Core | Conformance result | `1.0.0` | Core owns classification, summary, diff, and rule semantics. Guardian maps the result into its own result envelope and decision labels. |
| Core | CLI JSON envelope | `1.0.0` | Guardian's `archsync model graph`, `model diff`, and `model check-json` adapter calls Core serializers and preserves the Core `schema_version`, `kind`, and `contracts` map. |
| Guardian | Analyzer | `0.2` | TypeScript/Node.js source detector implementation. |
| Guardian | Observed Graph | `0.1` | Components, relationships, source evidence, analyzer identity, and scan metadata reconstructed from source. |
| Guardian | Finding | `0.1` | Core finding fields plus Guardian-owned source locations and the Core-owned model evidence record. |
| Guardian | Source evidence | `0.1` | `file`, `line`, `column`, snippet, detector, and confidence. It is versioned by its containing Observed Graph or Guardian Finding `0.1` envelope; no standalone source-evidence envelope is claimed. |
| Guardian | Result | `0.1` | Guardian decision, enriched findings, normalized diff keys, and full observed graph. |
| Guardian | Git gate | `0.3` | Diff scoping, baseline cache, introduced/resolved findings, PR report, and merge decision. |

The executable form of this table is [`src/compatibility.ts`](../src/compatibility.ts). `archsync version --json` reports the same versions plus `dependencies.core.source_commit` and `dependencies.core.vendored_sha256`. Any disagreement between documentation, code constants, the vendored package, or its checksum fails the compatibility gate.

## Transformation boundary

```text
Core-validated Architecture Model
             +
Guardian Observed Graph 0.1
             |
             v
Guardian removes only source evidence to form an observed Core model
             |
             v
Core graph/conformance/finding/evidence 1.0.0
             |
             v
Guardian Result 0.1 adds source evidence and PASS/BLOCK/REVIEW
```

Core continues to own the architecture schema, graph identity, rule matching, finding meaning, evidence paths, and conformance classification. Guardian owns source detection, source-location evidence, the observed-source contract, enrichment, and Git/PR policy. The adapter does not copy or fork Core's `deny`, `allow`, `require`, or `require-path` implementation.

## Compatibility guarantees

- Current `0.1.1` and previous `0.1.0` models with identical content replay to a byte-structurally identical Guardian result.
- The deprecated `0.1` spelling remains accepted by Core and is exercised by Guardian's model-adapter tests. Maintained models should use `0.1.1`.
- Unknown string versions fail at `/version` with the supported list. Direct Guardian API calls also reject an unsupported runtime version before conformance.
- Core model JSON commands emit the versioned Core CLI envelope. Guardian source `scan` and source `check --json` remain Guardian-owned contracts and are not falsely labeled as Core CLI JSON.
- Compatibility is limited to the exact vendored Core commit and checksum above until a later change deliberately re-pins, replays, and updates this matrix.

## Verification evidence

[`src/compatibility.test.ts`](../src/compatibility.test.ts) covers the mapping, current/previous replay, unsupported versions, and detector evidence. [`scripts/core-compatibility.mjs`](../scripts/core-compatibility.mjs) independently checks the package manifest, vendored checksum, provenance, Core serializers, both replays, and unsupported input. The generated [Phase 2 evidence](../evidence/phase-2-evidence.json) binds those inputs and normalized outputs by SHA-256.

Run:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm core:compatibility:verify
pnpm phase3:verify
```

See the [support matrix](support-matrix.md) and [0.1.0 → 0.1.1 migration guide](migrations/core-0.1.0-to-0.1.1.md) before changing a consumer.
