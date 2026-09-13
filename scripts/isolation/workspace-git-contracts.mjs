import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { collectGitSnapshot } from './workspace-git.mjs';
import { snapshotLimits, validateSnapshot } from './workspace-snapshot.mjs';
import { collectRepairedSnapshot, collectRepairedWorkspaceSnapshot } from './workspace-repaired.mjs';
import { createHash } from 'node:crypto';

const isGitEnvVariable = (key) => key.slice(0, 4).toUpperCase() === 'GIT_';
const safeGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isGitEnvVariable(key)));
safeGitEnv.GIT_NO_REPLACE_OBJECTS = '1';
safeGitEnv.GIT_NO_LAZY_FETCH = '1';

function createRunner(repository) {
  return (args, output = 'utf8', maxBuffer = 8 * 1024 * 1024) => {
    if (typeof output === 'object' && output !== null) {
      const options = output;
      output = options.output ?? 'utf8';
      maxBuffer = options.maxBuffer ?? maxBuffer;
      return execFileSync('git', ['-C', repository, ...args], {
        encoding: output === 'buffer' ? null : output,
        input: options.input,
        windowsHide: true,
        maxBuffer,
        env: safeGitEnv,
      });
    }
    return execFileSync('git', ['-C', repository, ...args], {
    encoding: output === 'buffer' ? null : output,
    windowsHide: true,
    maxBuffer,
    env: safeGitEnv,
  });
  };
}

async function withRepository(execute) {
  const repository = await mkdtemp(join(tmpdir(), 'archsync-git-snapshot-'));
  const git = createRunner(repository);
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'ArchSync Unit']);
    git(['config', 'user.email', 'unit@archsync.internal']);
    await execute(repository, git);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

test('collector reads committed files using explicit allowlisted paths and returns object identity metadata', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'project'), 'module');
    await writeFile(join(repository, 'notes.txt'), 'fixture-note');
    await writeFile(join(repository, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await mkdir(join(repository, 'dir'));
    await writeFile(join(repository, 'dir/file.txt'), 'nested');
    await git(['add', 'project', 'notes.txt', 'binary.bin', 'dir/file.txt']);
    await git(['commit', '-q', '-m', 'collectable commit']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    const result = await collectGitSnapshot({
      repository,
      commit,
      allowlist: ['project', 'notes.txt', 'binary.bin', 'dir/file.txt'],
      paths: ['notes.txt', 'dir/file.txt', 'binary.bin'],
    });
    assert.equal(result.sourceCommit, commit);
    assert.equal(result.snapshot.files.length, 3);
    assert.equal(result.objects['notes.txt'].object, git(['rev-parse', `${commit}:notes.txt`], 'utf8').trim());
    assert.equal(result.objects['binary.bin'].size, 4);
    assert.equal(result.objects['dir/file.txt'].size, 6);
    assert.equal(result.files['notes.txt'].toString(), 'fixture-note');
    assert.equal(result.files['dir/file.txt'].toString(), 'nested');
  });
});

test('collector preserves and indexes __proto__ filenames with explicit allowlist', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, '__proto__'), 'harmless');
    await git(['add', '__proto__']);
    await git(['commit', '-q', '-m', 'explicit proto filename']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    const result = await collectGitSnapshot({ repository, commit, allowlist: ['__proto__'], paths: ['__proto__'] });
    assert.equal(result.files['__proto__'].toString(), 'harmless');
    assert.equal(Object.hasOwn(result.files, '__proto__'), true);
    assert.equal(Object.hasOwn(result.objects, '__proto__'), true);
  });
});

test('collector rejects malformed or absent commit identifiers', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'source.txt'), 'stable');
    await git(['add', 'source.txt']);
    await git(['commit', '-q', '-m', 'base commit']);
    await assert.rejects(() => collectGitSnapshot({ repository, commit: 'short', allowlist: ['source.txt'] }));
    await assert.rejects(() => collectGitSnapshot({ repository, commit: '1234567890abcdef1234567890abcdef12345678', allowlist: ['source.txt'] }));
  });
});

test('collector does not read paths outside the exact allowlist or pathspec tricks', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'kept.txt'), 'keep');
    await writeFile(join(repository, 'secret.txt'), 'deny');
    await mkdir(join(repository, 'deep'));
    await writeFile(join(repository, 'deep/data.txt'), 'inner');
    await git(['add', 'kept.txt', 'secret.txt', 'deep/data.txt']);
    await git(['commit', '-q', '-m', 'path allowlist']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    const allowlist = ['kept.txt', 'deep/data.txt'];
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist, paths: ['secret.txt'] }));
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist: ['missing.txt'], paths: ['missing.txt'] }));
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist: ['deep/data.txt'], paths: ['deep/../data.txt'] }));
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist: ['kept.txt'], paths: ['missing.txt'] }));
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist, paths: ['deep/data.txt', 'not-checked-out.txt'] }));
  });
});

test('collector rejects files that are symlink, tree or submodule entries', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'real-target.txt'), 'target');
    const linkBlob = git(['hash-object', '-w', '--stdin'], { output: 'utf8', input: 'real-target.txt' }).trim();
    await git(['add', 'real-target.txt']);
    await git(['update-index', '--add', '--cacheinfo', '120000', linkBlob, 'link.txt']);

    await mkdir(join(repository, 'tree'));
    await writeFile(join(repository, 'tree/file.txt'), 'nested');
    await git(['add', 'tree/file.txt']);

    await writeFile(join(repository, 'submodule-source.txt'), 'unused');
    await git(['add', 'submodule-source.txt']);
    await git(['commit', '-q', '-m', 'filesystem entries']);
    const rootCommit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    await assert.rejects(() => collectGitSnapshot({ repository, commit: rootCommit, allowlist: ['link.txt'], paths: ['link.txt'] }));
    await assert.rejects(() => collectGitSnapshot({ repository, commit: rootCommit, allowlist: ['tree'], paths: ['tree'] }));

    const sub = await mkdtemp(join(tmpdir(), 'archsync-git-submodule-'));
    await writeFile(join(sub, 'submodule.txt'), 'sub');
    const subGit = createRunner(sub);
    try {
      subGit(['init', '-q']);
      subGit(['config', 'user.name', 'ArchSync Unit']);
      subGit(['config', 'user.email', 'unit@archsync.internal']);
      await subGit(['add', 'submodule.txt']);
      await subGit(['commit', '-q', '-m', 'submodule commit']);
      const subCommit = subGit(['rev-parse', 'HEAD'], 'utf8').trim();
      await git(['update-index', '--add', '--cacheinfo', '160000', subCommit, 'submodule']);
      await git(['commit', '-q', '-m', 'with submodule']);
      const submoduleCommit = git(['rev-parse', 'HEAD'], 'utf8').trim();
      await assert.rejects(() => collectGitSnapshot({ repository, commit: submoduleCommit, allowlist: ['submodule'], paths: ['submodule'] }));
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });
});

test('collector verifies commit trees and prevents loose blob tampering with same-length payload', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'source.txt'), 'GOOD');
    await git(['add', 'source.txt']);
    await git(['commit', '-q', '-m', 'collectable commit']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    const blobOid = git(['rev-parse', `${commit}:source.txt`], 'utf8').trim();
    const blobPath = join(repository, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2));
    await chmod(blobPath, 0o600);
    await writeFile(
      blobPath,
      deflateSync(
        Buffer.concat([
          Buffer.from('blob 4', 'utf8'),
          Buffer.from([0]),
          Buffer.from('EVIL', 'utf8'),
        ]),
      ),
    );
    await assert.rejects(
      () => collectGitSnapshot({ repository, commit, allowlist: ['source.txt'] }),
      /object hash mismatch/i,
    );
  });
});

test('collector verifies ancestor tree objects before resolving nested paths', async () => {
  await withRepository(async (repository, git) => {
    await mkdir(join(repository, 'dir'));
    await writeFile(join(repository, 'dir/source.txt'), 'GOOD');
    await git(['add', 'dir/source.txt']);
    await git(['commit', '-q', '-m', 'first']);
    const originalCommit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    const firstTree = git(['rev-parse', `${originalCommit}:dir`], 'utf8').trim();

    await writeFile(join(repository, 'dir/source.txt'), 'EVIL');
    await git(['add', 'dir/source.txt']);
    await git(['commit', '-q', '-m', 'second']);
    const secondTreeOid = git(['rev-parse', 'HEAD:dir'], 'utf8').trim();
    const secondTree = git(['cat-file', 'tree', secondTreeOid], 'buffer');
    const firstTreePath = join(repository, '.git', 'objects', firstTree.slice(0, 2), firstTree.slice(2));
    const secondTreeHeader = Buffer.concat([Buffer.from(`tree ${secondTree.length}`, 'utf8'), Buffer.from([0])]);
    await chmod(firstTreePath, 0o600);
    await writeFile(firstTreePath, deflateSync(Buffer.concat([secondTreeHeader, secondTree])));
    await assert.rejects(
      () => collectGitSnapshot({ repository, commit: originalCommit, allowlist: ['dir/source.txt'], paths: ['dir/source.txt'] }),
      /object hash mismatch/i,
    );
  });
});

test('collector rejects duplicate tree entries during tree parsing', async () => {
  await withRepository(async (repository, git) => {
    const duplicateBlob = git(['hash-object', '-w', '--stdin'], {
      output: 'utf8',
      input: 'DUPLICATE',
    }).trim();

    const duplicateTree = Buffer.concat([
      Buffer.from('100644 source.txt\0', 'utf8'),
      Buffer.from(duplicateBlob, 'hex'),
      Buffer.from('100644 source.txt\0', 'utf8'),
      Buffer.from(duplicateBlob, 'hex'),
    ]);

    const duplicateTreeOid = git(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], {
      output: 'utf8',
      input: duplicateTree,
    }).trim();

    const duplicateTreeCommit = git(['commit-tree', duplicateTreeOid, '-m', 'duplicate-tree'], 'utf8').trim();

    await assert.rejects(() => collectGitSnapshot({
      repository,
      commit: duplicateTreeCommit,
      allowlist: ['source.txt'],
      paths: ['source.txt'],
    }));
  });
});

test('repository helper reads declared root HEAD and dirty state despite inherited GIT_DIR/GIT_WORK_TREE', async () => {
  await withRepository(async (declared, git) => {
    await writeFile(join(declared, 'source.txt'), 'DECLARED');
    await git(['add', 'source.txt']);
    await git(['commit', '-q', '-m', 'declared commit']);
    const declaredCommit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    await writeFile(join(declared, 'source.txt'), 'DECLARED_DIRTY');

    const redirected = await mkdtemp(join(tmpdir(), 'archsync-git-probe-head-'));
    const redirectedRunner = createRunner(redirected);
    try {
      redirectedRunner(['init', '-q']);
      redirectedRunner(['config', 'user.name', 'ArchSync Unit']);
      redirectedRunner(['config', 'user.email', 'unit@archsync.internal']);
      await writeFile(join(redirected, 'source.txt'), 'REDIRECTED');
      redirectedRunner(['add', 'source.txt']);
      redirectedRunner(['commit', '-q', '-m', 'redirected commit']);
      const probeHelperPath = join(redirected, 'probe-helper.mjs');
      const repositoryGitModulePath = JSON.stringify(new URL('./repository-git.mjs', import.meta.url).href);
      await writeFile(
        probeHelperPath,
        [
          `import { repositoryHead, repositoryDirty } from ${repositoryGitModulePath};`,
          'const [,, repository] = process.argv;',
          'const result = {',
          '  source_commit: repositoryHead(repository),',
          '  source_dirty: repositoryDirty(repository),',
          '};',
          'process.stdout.write(JSON.stringify(result));',
          '',
        ].join('\n'),
      );

      const output = execFileSync(process.execPath, [probeHelperPath, declared], {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GIT_DIR: join(redirected, '.git'),
          GIT_WORK_TREE: redirected,
        },
      });
      const result = JSON.parse(output);
      assert.equal(result.source_commit, declaredCommit);
      assert.equal(result.source_dirty, true);
    } finally {
      await rm(redirected, { recursive: true, force: true });
    }
  });
});

test('collector ignores inherited GIT_DIR and binds repository argument', async () => {
  await withRepository(async (declared, git) => {
    await writeFile(join(declared, 'source.txt'), 'DECLARED');
    await git(['add', 'source.txt']);
    await git(['commit', '-q', '-m', 'authored declared repo']);
    const declaredCommit = git(['rev-parse', 'HEAD'], 'utf8').trim();

    const redirected = await mkdtemp(join(tmpdir(), 'archsync-git-collector-redirect-'));
    const redirectedRunner = createRunner(redirected);
    try {
      redirectedRunner(['init', '-q']);
      redirectedRunner(['config', 'user.name', 'ArchSync Unit']);
      redirectedRunner(['config', 'user.email', 'unit@archsync.internal']);
      await writeFile(join(redirected, 'source.txt'), 'OTHER_REPOSITORY');
      redirectedRunner(['add', 'source.txt']);
      redirectedRunner(['commit', '-q', '-m', 'authored other repo']);

      const workspaceGitModulePath = JSON.stringify(new URL('./workspace-git.mjs', import.meta.url).href);
      const harnessPath = join(redirected, 'harness.mjs');
      await writeFile(
        harnessPath,
        [
          `import { collectGitSnapshot } from ${workspaceGitModulePath};`,
          'const [,, repository, commit] = process.argv;',
          'const result = await collectGitSnapshot({ repository, commit, allowlist: [\'source.txt\'] });',
          "process.stdout.write(result.files['source.txt'].toString('utf8'));",
          '',
        ].join('\n'),
      );

      const output = execFileSync(process.execPath, [harnessPath, declared, declaredCommit], {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...safeGitEnv,
          GIT_DIR: join(redirected, '.git'),
          GIT_WORK_TREE: redirected,
        },
      });
      assert.equal(output, 'DECLARED');
    } finally {
      await rm(redirected, { recursive: true, force: true });
    }
  });
});

test('collector resolves linked-worktree repositories via gitdir file', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'source.txt'), 'WORKTREE');
    await git(['add', 'source.txt']);
    await git(['commit', '-q', '-m', 'linked worktree commit']);

    const linked = await mkdtemp(join(tmpdir(), 'archsync-git-linked-worktree-'));
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    try {
      git(['worktree', 'add', linked, commit]);
      const linkedSnapshot = await collectGitSnapshot({ repository: linked, commit, allowlist: ['source.txt'] });
      assert.equal(linkedSnapshot.files['source.txt'].toString(), 'WORKTREE');
      const linkedGitPointer = await readFile(join(linked, '.git'), 'utf8');
      assert.ok(linkedGitPointer.replaceAll('\\\\', '/').includes('worktrees/'));
    } finally {
      await execFileSync('git', ['worktree', 'remove', linked], { cwd: repository, windowsHide: true, env: safeGitEnv });
      await rm(linked, { recursive: true, force: true });
    }
  });
});

test('collector enforces count and file-size limits before returning a workspace snapshot', async () => {
  await withRepository(async (repository, git) => {
    for (let i = 0; i < snapshotLimits.files + 1; i++) {
      await writeFile(join(repository, `too-many-${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const allowlist = Array.from({ length: snapshotLimits.files + 1 }, (_, i) => `too-many-${String(i).padStart(3, '0')}.txt`);
    await git(['add', ...allowlist]);
    await git(['commit', '-q', '-m', 'many files']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist }));
  });

  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'oversized.txt'), Buffer.alloc(snapshotLimits.fileBytes + 1));
    await git(['add', 'oversized.txt']);
    await git(['commit', '-q', '-m', 'oversized file']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    await assert.rejects(() => collectGitSnapshot({ repository, commit, allowlist: ['oversized.txt'] }));
  });
});

test('dirty working-tree changes do not affect committed artifact collection', async () => {
  await withRepository(async (repository, git) => {
    await writeFile(join(repository, 'tracked.txt'), 'clean-tree');
    await git(['add', 'tracked.txt']);
    await git(['commit', '-q', '-m', 'committed state']);
    const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
    await writeFile(join(repository, 'tracked.txt'), 'dirty-tree-override');
    const collected = await collectGitSnapshot({ repository, commit, allowlist: ['tracked.txt'] });
    assert.equal(collected.files['tracked.txt'].toString(), 'clean-tree');
    assert.equal(git(['rev-parse', `${commit}:tracked.txt`], 'utf8').trim(), collected.objects['tracked.txt'].object);
  });
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function withRepairRepository(execute) {
  await withRepository(async (repository, git) => {
    await mkdir(join(repository, 'src'));
    await writeFile(join(repository, 'src/add.mjs'), 'export const add = (a, b) => a - b;\n');
    await writeFile(join(repository, 'package.json'), '{"private":true}\n');
    git(['add', 'src/add.mjs', 'package.json']);
    git(['commit', '-q', '-m', 'authored repair base']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    const before = await readFile(join(repository, 'src/add.mjs'));
    const repaired = Buffer.from('export const add = (a, b) => a + b;\n');
    const options = {
      repository, commit, allowlist: ['package.json', 'src/add.mjs'],
      replacements: [{ path: 'src/add.mjs', baseSha256: sha256(before), bytes: repaired }],
    };
    await execute({ repository, git, before, repaired, options });
  });
}

const workspaceOptions = ({ repository, options, repaired }) => ({
  ...options, workspace: repository,
  replacements: [{ path: 'src/add.mjs', baseSha256: options.replacements[0].baseSha256, sha256: sha256(repaired) }],
});

test('repaired bytes execute the intended change and bind both snapshots without changing Git', async () => {
  await withRepairRepository(async ({ repository, git, repaired, options }) => {
    const beforeStatus = git(['status', '--porcelain']);
    const result = await collectRepairedSnapshot(options);
    const captured = Buffer.from(result.snapshot.files.find((file) => file.path === 'src/add.mjs').base64, 'base64');
    const module = await import('data:text/javascript;base64,' + captured.toString('base64'));
    assert.equal(module.add(7, 4), 11);
    assert.equal(result.binding.source_commit, options.commit);
    assert.equal(result.binding.changes[0].base_object, git(['rev-parse', options.commit + ':src/add.mjs']).trim());
    assert.equal(result.binding.changes[0].repaired_sha256, sha256(repaired));
    assert.deepEqual(result.binding.repaired_snapshot, validateSnapshot(result.snapshot));
    assert.equal(result.bindingSha256, sha256(JSON.stringify(result.binding)));
    assert.notEqual(result.binding.base_snapshot.sha256, result.binding.repaired_snapshot.sha256);
    assert.equal(result.binding.status, 'UNAPPROVED');
    assert.equal(result.binding.production_capability, 'NOT_ISSUED');
    assert.equal(git(['status', '--porcelain']), beforeStatus);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), options.commit);
    assert.equal((await readFile(join(repository, 'src/add.mjs'))).includes('a - b'), true);
  });
});

test('repaired collector snapshots caller buffers and manifests before asynchronous Git lookup', async () => {
  await withRepairRepository(async ({ options, repaired }) => {
    const expected = Buffer.from(repaired);
    const collection = collectRepairedSnapshot(options);
    repaired.fill(0);
    options.commit = '0'.repeat(40);
    options.allowlist.splice(0, 2, '.env');
    options.replacements[0].path = '.env';
    options.replacements[0].baseSha256 = '0'.repeat(64);
    const result = await collection;
    assert.deepEqual(Buffer.from(result.snapshot.files.find((file) => file.path === 'src/add.mjs').base64, 'base64'), expected);
    assert.deepEqual(result.snapshot.files.map(({ path }) => path), ['package.json', 'src/add.mjs']);
  });
});

test('malformed repaired requests fail before repository lookup', async () => {
  const valid = { repository: '/not-a-repository', commit: 'a'.repeat(40), allowlist: ['ok.mjs'], replacements: [{ path: 'ok.mjs', baseSha256: 'b'.repeat(64), bytes: Buffer.from('ok') }] };
  const invalid = [
    { ...valid, allowlist: ['ok.mjs', 'OK.mjs'] },
    { ...valid, allowlist: ['src', 'src/file.mjs'] },
    { ...valid, allowlist: ['../ok.mjs'] },
    { ...valid, allowlist: ['.env'] },
    { ...valid, allowlist: ['aux.txt'] },
    { ...valid, allowlist: ['ok.mjs', 'ok.mjs'] },
    { ...valid, allowlist: new Array(1) },
    { ...valid, replacements: [...valid.replacements, ...valid.replacements] },
    { ...valid, replacements: [{ ...valid.replacements[0], path: 'elsewhere' }] },
    { ...valid, replacements: [{ ...valid.replacements[0], bytes: Buffer.alloc(snapshotLimits.fileBytes + 1) }] },
    { ...valid, replacements: [{ ...valid.replacements[0], bytes: Buffer.from(new SharedArrayBuffer(2)) }] },
    { ...valid, replacements: [{ ...valid.replacements[0], deleted: true }] },
    { ...valid, replacements: [{ ...valid.replacements[0], baseSha256: 'short' }] },
    { ...valid, commit: 'HEAD' },
    { ...valid, command: 'npm test' },
  ];
  for (const options of invalid) {
    await assert.rejects(collectRepairedSnapshot(options), (error) => {
      assert.equal(error.code, 'ERR_ASSERTION');
      return true;
    });
  }
});

test('repaired collector rejects stale base, no-op, additions, deletions and over-budget final snapshots', async () => {
  await withRepairRepository(async ({ repository, git, before, options }) => {
    await assert.rejects(collectRepairedSnapshot({ ...options, replacements: [{ ...options.replacements[0], baseSha256: '0'.repeat(64) }] }), /base digest mismatch/);
    await assert.rejects(collectRepairedSnapshot({ ...options, replacements: [{ ...options.replacements[0], bytes: before }] }), /must change/);
    await assert.rejects(collectRepairedSnapshot({ ...options, allowlist: ['new.mjs'], replacements: [{ path: 'new.mjs', baseSha256: sha256(''), bytes: Buffer.from('new') }] }), /missing from committed/);
    await assert.rejects(collectRepairedSnapshot({ ...options, replacements: [{ path: 'src/add.mjs', baseSha256: sha256(before), bytes: null }] }), /Buffer/);
    const paths = Array.from({ length: 8 }, (_, i) => `large-${i}.txt`);
    for (const path of paths) await writeFile(join(repository, path), Buffer.alloc(snapshotLimits.fileBytes));
    git(['add', ...paths]);
    git(['commit', '-q', '-m', 'bounded base']);
    await assert.rejects(collectRepairedSnapshot({
      repository, commit: git(['rev-parse', 'HEAD']).trim(), allowlist: [...paths, 'package.json'],
      replacements: [{ path: 'large-0.txt', baseSha256: sha256(Buffer.alloc(snapshotLimits.fileBytes)), bytes: Buffer.from('repair') }],
    }));
  });
});

test('live repaired collector fails closed on hosts without descriptor-relative Linux opens', { skip: process.platform === 'linux' }, async () => {
  const options = { repository: '/not-a-repository', workspace: '/not-a-workspace', commit: 'a'.repeat(40), allowlist: ['file.mjs'], replacements: [{ path: 'file.mjs', baseSha256: 'b'.repeat(64), sha256: 'c'.repeat(64) }] };
  await assert.rejects(collectRepairedWorkspaceSnapshot(options), /requires Linux descriptor-relative opens/);
});

test('Linux live repaired workspace captures real uncommitted bytes with original source identity', { skip: process.platform !== 'linux' }, async () => {
  await withRepairRepository(async (context) => {
    const { repository, repaired, options, git } = context;
    await writeFile(join(repository, 'src/add.mjs'), repaired);
    await writeFile(join(repository, '.env'), 'NOT_ALLOWED_IN_SNAPSHOT');
    const beforeStatus = git(['status', '--porcelain']);
    const result = await collectRepairedWorkspaceSnapshot(workspaceOptions(context));
    assert.equal(result.binding.source_commit, options.commit);
    assert.equal(result.binding.collection.kind, 'LINUX_DESCRIPTOR_RELATIVE_WORKSPACE');
    assert.equal(result.binding.collection.observed_files.length, 2);
    assert.deepEqual(result.snapshot, (await collectRepairedSnapshot(options)).snapshot);
    assert.equal(JSON.stringify(result).includes('NOT_ALLOWED_IN_SNAPSHOT'), false);
    assert.equal(git(['status', '--porcelain']), beforeStatus);
  });
});

test('Linux live repaired workspace refuses leaf and parent symlinks, root aliases and hardlinks', { skip: process.platform !== 'linux' }, async () => {
  await withRepairRepository(async (context) => {
    const { repository, repaired } = context;
    const input = workspaceOptions(context);
    const external = await mkdtemp(join(tmpdir(), 'archsync-repair-external-'));
    try {
      await writeFile(join(external, 'add.mjs'), repaired);
      await rm(join(repository, 'src/add.mjs'));
      await symlink(join(external, 'add.mjs'), join(repository, 'src/add.mjs'));
      await assert.rejects(collectRepairedWorkspaceSnapshot(input), /ELOOP/);
      await rm(join(repository, 'src/add.mjs'));
      await link(join(external, 'add.mjs'), join(repository, 'src/add.mjs'));
      await assert.rejects(collectRepairedWorkspaceSnapshot(input), /single-link/);
      await rm(join(repository, 'src'), { recursive: true });
      await symlink(external, join(repository, 'src'));
      await assert.rejects(collectRepairedWorkspaceSnapshot(input), /ENOTDIR|ELOOP/);
      const alias = join(external, 'alias');
      await symlink(repository, alias);
      await assert.rejects(collectRepairedWorkspaceSnapshot({ ...input, workspace: alias }), /ENOTDIR|ELOOP/);
    } finally { await rm(external, { recursive: true, force: true }); }
  });
});

test('Linux live repaired workspace rejects unexpected changes, stale expectations, missing and special files', { skip: process.platform !== 'linux' }, async () => {
  await withRepairRepository(async (context) => {
    const { repository, repaired } = context;
    const input = workspaceOptions(context);
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /unexpected workspace bytes/);
    await writeFile(join(repository, 'src/add.mjs'), repaired);
    await chmod(join(repository, 'src/add.mjs'), 0o755);
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /executable mode changed/);
    await chmod(join(repository, 'src/add.mjs'), 0o644);
    await writeFile(join(repository, 'package.json'), '{"private":false}\n');
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /unexpected workspace bytes/);
    await writeFile(join(repository, 'package.json'), '{"private":true}\n');
    await assert.rejects(collectRepairedWorkspaceSnapshot({ ...input, workspace: '/nonexistent', replacements: [{ ...input.replacements[0], baseSha256: '0'.repeat(64) }] }), /base digest mismatch/);
    await rm(join(repository, 'src/add.mjs'));
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /ENOENT/);
    execFileSync('mkfifo', [join(repository, 'src/add.mjs')]);
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /single-link regular/);
    await rm(join(repository, 'src/add.mjs'));
    await mkdir(join(repository, 'src/add.mjs'));
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /single-link regular/);
    await rm(join(repository, 'src/add.mjs'), { recursive: true });
    await writeFile(join(repository, 'src/add.mjs'), Buffer.alloc(snapshotLimits.fileBytes + 1));
    await assert.rejects(collectRepairedWorkspaceSnapshot(input), /too large/);
  });
});

test('Linux live repaired workspace detects a file replacement during read and closes held descriptors', { skip: process.platform !== 'linux' }, async () => {
  await withRepairRepository(async (context) => {
    const { repository, repaired } = context;
    await writeFile(join(repository, 'src/add.mjs'), repaired);
    const harness = join(repository, 'race-harness.mjs');
    await writeFile(harness, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { collectRepairedWorkspaceSnapshot } from ${JSON.stringify(new URL('./workspace-repaired.mjs', import.meta.url).href)};
      const input = JSON.parse(process.argv[2]);
      const originalRead = fs.readSync;
      const baselineFds = fs.readdirSync('/proc/self/fd').length;
      let changed = false;
      fs.readSync = (...args) => {
        const result = originalRead(...args);
        if (!changed && fs.readlinkSync('/proc/self/fd/' + args[0]).endsWith('/src/add.mjs')) {
          changed = true;
          fs.renameSync(input.workspace + '/src/add.mjs', input.workspace + '/src/moved.mjs');
          fs.writeFileSync(input.workspace + '/src/add.mjs', 'SUBSTITUTE');
        }
        return result;
      };
      syncBuiltinESMExports();
      await assert.rejects(collectRepairedWorkspaceSnapshot(input), /changed/);
      assert.equal(changed, true);
      fs.readSync = originalRead;
      syncBuiltinESMExports();
      assert.equal(fs.readdirSync('/proc/self/fd').length, baselineFds);
    `);
    execFileSync(process.execPath, [harness, JSON.stringify(workspaceOptions(context))], { timeout: 15000, encoding: 'utf8' });
  });
});
