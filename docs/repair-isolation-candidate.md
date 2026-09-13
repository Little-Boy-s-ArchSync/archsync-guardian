# Docker isolation candidate for P4-112

Status: **UNAPPROVED — authored fixtures only, no production capability**.

The internal backend in `scripts/isolation/backend.mjs` creates and inspects real
Linux containers, transfers bounded project snapshots, executes fixed authored
processes, bounds output/runtime, and terminates/removes its exact owned
containers. It is not imported by the product
runtime or registered with `src/repair-isolation.ts`. That module's private
capability registry and all production reviewability decisions are unchanged.
The candidate is not a renamed Vitest executor: its explicit local probe runs
actual Node/npm subprocesses inside Docker, including a detached child, and
retains measured configuration and cleanup evidence.

## Run the authored experiment

Use a local Unix-socket Docker engine with Linux containers, built-in seccomp,
cgroup v2 and the required memory, CPU and PID controls. The current candidate
supports x86_64 and aarch64 engines. Windows named-pipe and remote daemons are
refused. Preload the fixed public image explicitly:

```text
docker pull docker.io/library/node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34
pnpm install --frozen-lockfile
pnpm build
pnpm isolation:probe
```

The probe itself uses `--pull=never` and refuses a missing or mismatched image.
Fixture files are now loaded through `scripts/isolation/workspace-git.mjs` from the
current `HEAD` commit object, not from the live working tree. The collector only
reads allowlisted paths and records the source object identity for each file in
the report; this makes the transfer source auditable and ignores unrelated working-tree edits.
The official image contains Node 22.16.0, matching the project's pinned local
verification toolchain. The pin identifies bytes and reproducibility; it is not
a security approval or an assertion that the older image is ready for hostile
production workloads.

The command accepts no project path, free-form command, custom image, mount or
security option. It checks the canonical fixture manifest and exact source
hashes, creates only its own temporary canary/configuration files and container
names, and writes a new ignored `.artifacts/isolation/<run>/result.json`.
Host home, credentials and daemon sockets are never mounted or copied into the
container. The only project currently exercised is the manifest-bound authored
project under `scripts/isolation/project`. There is no host execution
fallback and no external provider call or project dependency installation.

`pnpm isolation:verify` runs the deterministic contract tests. It is part of the
existing `phase4:assets` path, hence normal `phase4:verify`, `phase5:verify` and
CI execute it. The actual Docker experiment is explicit; a successful CI unit
suite does not imply that CI ran the Docker probes.

## Containment and observations

The payload contains manifest-bound helpers and authored fixture source. It
enters Node through stdin into a fixed image and entrypoint.
No host bind, socket, named or anonymous volume is allowed. Only a 16 MiB
container-owned tmpfs at `/workspace` is supplied for fixture output; no generated
file is copied back to the host or followed by a host-side project recheck.

The stopped container is inspected before start: non-root UID/GID 1000, read-only
image, all capabilities dropped, no-new-privileges, private PID/IPC/cgroup
namespaces, no exposed ports, no restart, bounded local logs, 256 MiB RAM/swap,
one CPU and at most 64 processes. The authored process separately checks Linux
`NoNewPrivs=1`, `Seccomp=2`, and zero effective/bounding capabilities. It writes
the intended workspace and requires an EROFS denial in the image's otherwise
world-writable `/tmp`, in addition to host-canary/path/symlink/root-write checks.

The network profile is **network socket creation denied; private AF_UNIX pairs
retained for subprocess stdio**. Docker's `none` network is combined with a
restricted seccomp profile derived from the complete, pinned Moby default
profile. The derivation only removes permissions and preserves its existing
default-deny, architecture and capability rules. It denies socket, socketcall,
connect, bind, listen, accept and io_uring. Socketpair is limited to AF_UNIX;
these private, connected pairs do not provide named Unix or IP connections.
The exact resolved profile is inspected before the container starts.

Bounded probes require EPERM/EACCES for IPv4/IPv6 TCP and UDP, the host-listener
address, IPv4/IPv6 loopback TCP and UDP, a TCP listener, and named Unix socket
listen/connect. Timeout, refusal and no-route results cannot pass those checks.
DNS failure is retained as an observation, not independently promoted to proof.
The spawned project test also verifies loopback-listener denial. Unsupported
test suites that need a server or named IPC will fail under this profile.

The host TCP and UDP listeners have positive controls through host loopback
before the experiment. These controls demonstrate that the listeners are live,
not that Docker-to-host routing works; the container checks separately require
actual policy denial. Only generated
canary data is used. All actual output is bounded and passed through the existing
Guardian log sanitizer. The report must contain neither the host's synthetic
secret nor the deliberately printed fixture secret.

## Workspace transfer

`workspace-snapshot.mjs` accepts an explicit list of file paths and byte buffers,
not a host directory or an archive. It creates a canonical, sorted packet with
per-file size/SHA-256 and a digest over the full packet. No file is discovered or
read from the host implicitly. Limits are 128 files, 256 KiB per file, 2 MiB
total content, 3 MB encoded packet and 16 path segments. Path traversal,
absolute paths, platform aliases, duplicate/case-colliding paths, file/directory
collisions, credential/control paths, extra file-type fields and noncanonical
or tampered bytes are rejected before transfer.

The packet is encoded as data inside the trusted stdin bootstrap. It is
validated again inside the inspected container before any project code runs.
The bootstrap creates a fresh `/workspace/project`, creates directories without
recursive traversal, opens regular files exclusively with O_NOFOLLOW, and
rechecks every materialized hash before launching the fixed offline `npm test`.
Pre/post npm lifecycle hooks are disabled. The report retains the observed
workspace digest; it must match the host packet. Success and deliberate test
failure are separate real executions. Project-generated symlinks/output stay
inside the container and are destroyed with it; nothing is extracted or followed
by a host-side recheck.

The generated probe report includes `source_snapshot` with the exact source commit
and collected object identities for each snapshot path, making it possible to
verify the payload came from a specific committed state.

This provides a bounded byte-transfer primitive. The candidate also exposes the
bounded repaired-file collection APIs and the restricted repaired-fixture runner
below. Offline dependency provisioning, arbitrary project/platform support and
binding a production capability to the repaired snapshot remain separate
integration work. The probes accept no arbitrary project or command arguments.

## Uncommitted repaired files

`scripts/isolation/workspace-repaired.mjs` provides two internal APIs. Both start
from a full, exact SHA-1 Git commit and the complete explicit list of regular
files to transfer. Each replacement names an existing allowlisted file and its
expected base SHA-256. Additions, deletions, renames, executable-mode changes,
symlinks, submodules and no-op replacements are unsupported and rejected; an
empty buffer means an empty regular file, not deletion. Paths outside the list
are never discovered or included, so this does not certify that an entire
repository is unchanged. The working tree and index are never written.

An editor or repair runner that already owns the proposed bytes can call the
portable API directly:

```js
import { collectRepairedSnapshot } from './scripts/isolation/workspace-repaired.mjs';

const repaired = await collectRepairedSnapshot({
  repository: trustedRepositoryRoot,
  commit: reviewedBaseCommit,              // full 40-character commit ID
  allowlist: ['package.json', 'src/add.mjs'],
  replacements: [{
    path: 'src/add.mjs',
    baseSha256: reviewedOriginalFileHash,
    bytes: repairResultBytes,              // owned Buffer, no SharedArrayBuffer
  }],
});
```

The API copies the replacement buffers and manifest synchronously before Git
lookup. It resolves and verifies the committed base objects, checks the expected
original hashes, and overlays only the supplied replacements. It does not read
repaired files or apply a shell patch. A stale base, alias path, extra field or
oversized request fails before a packet can be returned. Path/schema/byte-limit
validation precedes any Git lookup. This is the supported integration point on
macOS and Windows when a trusted producer supplies the bytes.

On **Linux only**, `collectRepairedWorkspaceSnapshot` reads the corresponding
uncommitted files from a live workspace:

```js
import { collectRepairedWorkspaceSnapshot } from './scripts/isolation/workspace-repaired.mjs';

const repaired = await collectRepairedWorkspaceSnapshot({
  repository: trustedRepositoryRoot,
  workspace: canonicalAbsoluteWorkspaceRoot,
  commit: reviewedBaseCommit,
  allowlist: ['package.json', 'src/add.mjs'],
  replacements: [{
    path: 'src/add.mjs',
    baseSha256: reviewedOriginalFileHash,
    sha256: expectedRepairResultHash,
  }],
});
```

The expected repaired digest must come from the trusted repair artifact, not an
unverified read of the same mutable path. The adapter checks every selected live
file: replacement bytes must match that digest and remaining files must match
the committed base. It anchors each directory and leaf open through held Linux
`/proc/self/fd` directory descriptors with `O_NOFOLLOW`, refuses hardlinks and
mount crossings beneath the selected root, and bounds file/total bytes and the
number of open directory descriptors. Nonblocking opens allow special files
such as FIFOs to be rejected without waiting for a writer. It retains the file
descriptors until collection ends, checks device/inode/mode/link count/size and
nanosecond timestamps before/after reads, and rejects observed path replacement
or mutation. Descriptors are closed on success and failure.

This requires a trusted Linux kernel and local filesystem, usable `/proc`, and
an exclusively controlled repair operation. It does **not** establish an atomic
filesystem-wide snapshot, prevent future edits, detect every temporary change
between observations, or guarantee completion on a hung filesystem. No project
code should run concurrently during collection. A packet contains a bounded copy
matching the expected hashes; later verification must use that packet rather
than reopen its original live paths. Node has no portable descriptor-relative
open primitive, so the live adapter fails closed on macOS and Windows before
Git/file lookup. A path checked with `lstat` and then opened normally is not used
as a substitute.

Both APIs return the existing transferable `snapshot` plus a separate `binding`
and its `bindingSha256`. The binding retains the exact base commit, verified Git
object/mode/size for every selected source file, base and repaired snapshot
identities, each changed file's before/after digest, and the collection method.
The Linux variant adds observed filesystem identities, not host paths. A caller
must retain the binding with the packet and compare the container's observed
workspace digest to `binding.repaired_snapshot.sha256`; the binding digest is an
integrity value, not a reviewer signature. `status` remains `UNAPPROVED` and
`production_capability` remains `NOT_ISSUED`.

These contracts run in the existing `pnpm isolation:verify` suite; Linux CI
executes the real filesystem cases and other platforms check explicit refusal.
The existing `pnpm isolation:probe` continues to run the fixed committed authored
project. Its result is not evidence that a live repaired workspace was executed
inside the isolation backend. The separate runner below consumes collected
repaired bytes for one fixed authored fixture. An approved runner, offline
dependencies and a capability issuer remain open.

## Restricted repaired-fixture execution

`scripts/isolation/repaired-execution.mjs` connects both collectors to the same
inspected Docker backend. Its only supported fixture is `authored-add-v1`: the
three existing regular files under `scripts/isolation/project`, with their exact
base hashes and non-executable Git modes. Only `lib/add.mjs` may be replaced.
The package manifest and test suite stay byte-bound to this fixed contract.
Dependency changes, arbitrary projects, command overrides and other replacement
paths are rejected before Docker is invoked. No dependencies are installed.

```js
import {
  prepareRepairedFixture,
  executePreparedRepairedFixture,
} from './scripts/isolation/repaired-execution.mjs';

const prepared = await prepareRepairedFixture({
  repository: trustedRepositoryRoot,
  commit: reviewedBaseCommit,
  fixture: 'authored-add-v1',
  replacements: [{
    path: 'scripts/isolation/project/lib/add.mjs',
    baseSha256: reviewedOriginalFileHash,
    bytes: repairResultBytes,
  }],
});
const result = await executePreparedRepairedFixture(prepared, { signal });
```

`prepareRepairedWorkspaceFixture` accepts the same request plus the canonical
Linux `workspace`, and replaces `bytes` with the expected repaired `sha256`.
It retains the descriptor-relative collector's platform refusal and consistency
limits. Both preparation APIs retain the complete collector binding and its
digest in a deeply frozen result. The actual payload is sealed privately in the
module instance. A serialized, forged or altered preparation cannot be executed;
the caller must retain the original preparation object. Repaired paths are never
reopened after collection, and changing the producer's buffer or live files
cannot change the prepared payload.

The packet keeps the full collector paths rather than rebasing them, so the
container observes precisely `binding.repaired_snapshot.sha256`. Its fixed npm
working directory is the nested authored fixture path. The trusted bootstrap
validates and materializes every packet byte before starting project code. The
runner requires the first stdout line to be the exact `WORKSPACE_BOUND` identity,
and a final parent-generated `WORKSPACE_RESULT` matching the real Docker/npm exit.
The committed base digest cannot substitute for the repaired digest. Bootstrap
errors, missing/mismatched observations, Docker setup errors, timeout,
cancellation, output overflow and uncertain cleanup remain `INCONCLUSIVE`.
A genuine nonzero npm exit remains `FIXTURE_FAILED` only after binding and final
state checks. This is input and process evidence, not an assertion that hostile
project logs or a repair's correctness can be trusted.

The fixed image, seccomp network profile, no-mount policy, output/runtime limits
and owned-container cleanup are unchanged. Only the collected packet goes in;
no file or generated output is extracted, copied back or subjected to a host
recheck. Every report remains `UNAPPROVED`, `production_ready: false`, and
`production_capability: NOT_ISSUED`. The private product capability registry is
not called or changed.

After committing runner changes, run `pnpm isolation:repaired:probe` for a
separate actual Docker experiment. It records success, genuine test failure,
timeout, cancellation and both output-overflow cases using distinct uncommitted
caller-owned replacement bytes. Each case requires the repaired source's marker,
the exact base commit and before/after hashes, the matching container digest,
an unchanged synthetic host canary, and verified owned-container removal. The
probe deliberately overwrites the producer buffer after preparation to check
that execution consumes the sealed copy. Reports go to a fresh ignored
`.artifacts/isolation/repaired-<run>/result.json`; normal verification runs the
deterministic contracts and does not imply that Docker experiments ran.

## Lifecycle and outcome handling

Every Docker subprocess, including preflight, create, inspect, start, logs,
kill, removal and inventory, has bounded runtime and output. No shell command
string is accepted. Docker client configuration is harness-owned, a local socket
is explicit, inherited daemon/TLS/context overrides are refused and user Docker
configuration, credentials and host secrets are not forwarded.

A unique random name and label bind each container. The immutable ID and
ownership are checked before execution and cleanup. Timeout, cancellation,
overflow or client failure causes container-level termination/removal; killing
only the attached Docker client is insufficient. A previously inspected immutable
ID permits a narrow removal attempt if a later inspect fails. Removal and an
empty inventory for that exact random ownership label must both be verified.
There is no broad container cleanup command.

The timeout and cancellation fixtures print a readiness marker **from the actual
child**, followed by a delayed marker at 1.5 seconds. Their one-second deadline
terminates the container. The harness observes stopped state and PID zero,
waits a further 1.8 seconds, verifies child readiness without the delayed marker,
then removes the container and checks absence. It does not infer a running child
from a parent's successful `spawn` call.

Fixture success, a genuine nonzero fixture exit, setup/client failure, timeout,
cancellation, overflow and cleanup uncertainty remain distinguishable. Null,
signaled or errored npm outcomes are infrastructure failures; they cannot become
`process.exit(null)` and false success. Docker setup codes and a mismatch with the
container's actual final state are inconclusive. An uncertain create result
cannot be turned into a confirmed clean run merely because a subsequent name
lookup is empty; delayed daemon creation may still be possible. The report
retains the exact random name so a failed cleanup can be investigated safely.

Every report remains `UNAPPROVED`, with `production_ready: false` and
`production_capability: NOT_ISSUED`. `probe_result: PASS` means all authored
observations and cleanup checks passed for the measured configuration; it does
not approve a repair or establish universal resistance to kernel/runtime escape.

## Production adoption remains open

The Docker daemon and its runtime are trusted host components; Docker access can
control the host. No experiment against a few authored inputs removes that trust.
Broader repaired-file operations and arbitrary-project collection, project
dependency/platform support, any approved treatment of test-modified
files, image/security approval and a reviewed capability issuer remain open.
The bounded snapshot transfer rejects file-type metadata and never returns
hostile outputs to a host recheck. It is not yet an arbitrary-project adapter.

Adoption requires the real independent Security/Lead/code review and exact
policy/image/issuer approval required by the existing ADR and task criteria.
No `approval_id`, named signer, production capability, `APPROVED` assessment or
`ACCEPTABLE_FOR_REVIEW` decision is generated. P4-112 and P4-127 remain open.

References: [Docker execution and limits](https://docs.docker.com/engine/containers/run/),
[none network and loopback](https://docs.docker.com/engine/network/drivers/none/),
[default seccomp](https://docs.docker.com/engine/security/seccomp/), and
[daemon trust](https://docs.docker.com/engine/security/).
The exact upstream profile and Apache-2.0 license are retained under
[`scripts/isolation/vendor`](../scripts/isolation/vendor/README.md).
