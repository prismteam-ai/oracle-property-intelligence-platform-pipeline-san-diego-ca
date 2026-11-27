import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

/**
 * Builds the serving function into `dist/lambda`: one bundled ESM file plus DuckDB's native
 * Linux binding, installed for the Lambda platform (the build machine may be Windows or macOS).
 * `npm run build:lambda`; the CDK stack ships this folder as the function code.
 */
const DUCKDB_VERSION = '2.0.1-r.1';
const out = path.resolve('dist/lambda');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ['src/serve/lambda.ts'],
  outfile: path.join(out, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: true,
  // The native binding is resolved at runtime from node_modules next to the bundle.
  external: ['@duckdb/node-bindings', '@duckdb/node-bindings-*'],
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
});

writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'oracle-pipeline-mcp', private: true, type: 'module' }, null, 2),
);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(
  npm,
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--force',
    '--os=linux',
    '--cpu=x64',
    '--libc=glibc',
    `@duckdb/node-bindings@${DUCKDB_VERSION}`,
    `@duckdb/node-bindings-linux-x64@${DUCKDB_VERSION}`,
  ],
  { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' },
);

process.stdout.write(`Lambda bundle ready in ${out}\n`);
