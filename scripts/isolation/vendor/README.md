# Pinned upstream seccomp profile

`moby-default-seccomp.json` is the unmodified Moby profile from
[moby/profiles at 61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31](https://github.com/moby/profiles/blob/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31/seccomp/default.json).
SHA-256: `de1f5327ca42b80be02daba8d39c0d087a530dc3c16f7028170fe068c9d66e61`.
Its Apache-2.0 license is retained in `LICENSE.moby`.

`../network-policy.mjs` verifies these source bytes and derives the candidate
policy only by removing syscall permissions. It retains the upstream default
deny action and existing conditional/architecture restrictions. Socket creation,
connect, bind, listen, accept, legacy socketcall and io_uring are denied. The
existing socketpair permission is narrowed to AF_UNIX for private subprocess
stdio; named Unix sockets and all IP sockets remain denied.

This profile is experimental and does not constitute Security/Lead approval.
