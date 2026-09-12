import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { collectGitSnapshot } from './workspace-git.mjs';
import { snapshotLimits } from './workspace-snapshot.mjs';

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
