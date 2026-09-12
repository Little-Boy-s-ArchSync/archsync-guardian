import { execFileSync } from 'node:child_process';

const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const isGitEnvVariable = (key) => key.slice(0, 4).toUpperCase() === 'GIT_';
const safeGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isGitEnvVariable(key)));
Object.assign(safeGitEnvironment, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: nullDevice,
  GIT_CONFIG_GLOBAL: nullDevice,
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
});
const gitDirCache = new Map();

function getGitDir(repository) {
  let gitDir = gitDirCache.get(repository);
  if (!gitDir) {
    gitDir = execFileSync('git', ['-C', repository, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      windowsHide: true,
      env: safeGitEnvironment,
    }).trim();
    gitDirCache.set(repository, gitDir);
  }
  return gitDir;
}

function gitOutput(repository, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', [
    '-C',
    repository,
    `--git-dir=${getGitDir(repository)}`,
    `--work-tree=${repository}`,
    '--no-replace-objects',
    '--no-optional-locks',
    '-c',
    'protocol.allow=never',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${nullDevice}`,
    ...args,
  ], {
    encoding,
    windowsHide: true,
    env: safeGitEnvironment,
  });
}

export function repositoryHead(repository) {
  return gitOutput(repository, ['rev-parse', 'HEAD']).trim();
}

export function repositoryDirty(repository) {
  return gitOutput(repository, ['status', '--porcelain']).trim() !== '';
}

export function repositoryMetadata(repository) {
  return {
    source_commit: repositoryHead(repository),
    source_dirty: repositoryDirty(repository),
  };
}
