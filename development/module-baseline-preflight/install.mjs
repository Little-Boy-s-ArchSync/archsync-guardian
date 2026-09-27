import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, newReceiptFolder, writeJSON, inventory } from './capture.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (process.version !== 'v22.16.0') throw new Error('MBP-001 requires Node 22.16.0');
const npmCLI = process.argv[2];
if (!npmCLI || !existsSync(npmCLI)) throw new Error('Supply the installed npm-cli.js path');
const out = newReceiptFolder(root, 'install');
writeJSON(resolve(out, 'inputs-before.json'), { purpose: 'development-only-not-D3', node: process.version, platform: process.platform, arch: process.arch, files: inventory(root) });
const run = capture(out, 'npm-install', process.execPath,
  [npmCLI, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'],
  resolve(root, 'comparator'), 120000);
if (run.exit_code !== 0 || run.launch_error) throw new Error(`Installation failed; retained at ${out}`);
const lock = JSON.parse(readFileSync(resolve(root, 'comparator/package-lock.json')));
const pkg = lock.packages['node_modules/dependency-cruiser'];
const expectedIntegrity = 'sha512-LqZl/eyG/9zROxe02TLQfXujJIwcYj6HwIjDkeI11JzW3ADmO93hZ2zwjQHNnfeXKlYujq1hgU3O5TdeupO7zQ==';
if (pkg.version !== '18.3.0' || pkg.integrity !== expectedIntegrity || pkg.resolved !== 'https://registry.npmjs.org/dependency-cruiser/-/dependency-cruiser-18.3.0.tgz') throw new Error(`Comparator artifact mismatch; stop. ${out}`);
writeJSON(resolve(out, 'verified-install.json'), { lifecycle_scripts_disabled: true, comparator_version: pkg.version, comparator_integrity: pkg.integrity, files: inventory(resolve(root, 'comparator')), installed_files: inventory(resolve(root, 'comparator/node_modules'), new Set()) });
console.log(out);
