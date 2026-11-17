#!/usr/bin/env node
/**
 * Builds the publishable npm packages into `build/packages/<folder>`: compiled JavaScript and type
 * declarations from `tsconfig.packages.json`, with a package.json whose entry point is the build.
 * Inside the repo the workspaces keep pointing at their TypeScript sources; only these copies are
 * published. Every package gets the same version, and depends on the exact same version of the
 * sibling packages it imports.
 *
 *   node scripts/build-packages.mjs 1.2.0
 *
 * The agent runtime (`apps/agents`) and the web app are not published.
 */
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@yushiguang/';
const REGISTRY = 'https://npm.pkg.github.com';
const REPO = 'https://github.com/yushiguang/language-model-training-platform';

/** The published workspaces, in dependency order. */
export const PUBLISHED = [
  'packages/contracts',
  'packages/domain',
  'packages/platform',
  'apps/llm-gateway',
  'apps/catalog',
  'apps/labeling',
  'apps/optimiser',
  'apps/jobs',
  'apps/workflow',
  'apps/bff',
  'apps/telemetry',
];

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/build-packages.mjs <version>   (for example 1.2.0)');
  process.exit(1);
}

const out = path.join(root, 'build');
rmSync(out, {recursive: true, force: true});
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.packages.json'], {cwd: root, stdio: 'inherit'});

function files(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, acc);
    else acc.push(p);
  }
  return acc;
}

const names = new Map(PUBLISHED.map(dir => [JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')).name, dir]));

for (const dir of PUBLISHED) {
  const src = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  if (!src.name.startsWith(SCOPE)) throw new Error(`${dir}: the package name must start with ${SCOPE}`);
  const target = path.join(out, 'packages', dir.split('/')[1]);
  const dist = path.join(target, 'dist');
  mkdirSync(target, {recursive: true});
  cpSync(path.join(out, 'tsc', dir, 'src'), dist, {recursive: true});
  const deps = new Set();
  for (const f of files(dist)) {
    let text = readFileSync(f, 'utf8');
    // Declarations keep the sources' `.ts` specifiers; the published files are `.js`.
    if (f.endsWith('.d.ts')) {
      text = text.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts\1/g, '$1$2.js$1');
      writeFileSync(f, text);
    }
    for (const m of text.matchAll(/['"](@yushiguang\/[a-z0-9-]+)['"]/g)) if (m[1] !== src.name) deps.add(m[1]);
  }
  for (const d of deps) if (!names.has(d)) throw new Error(`${dir} imports ${d}, which is not published`);
  const pkg = {
    name: src.name,
    version,
    description: src.description ?? `Sprint: ${dir.split('/')[1]}`,
    type: 'module',
    exports: {'.': {types: './dist/index.d.ts', default: './dist/index.js'}},
    files: ['dist'],
    dependencies: Object.fromEntries([...deps].sort().map(d => [d, version])),
    repository: {type: 'git', url: `git+${REPO}.git`, directory: dir},
    publishConfig: {registry: REGISTRY},
  };
  writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const readme = path.join(root, dir, 'README.md');
  writeFileSync(
    path.join(target, 'README.md'),
    existsSync(readme) ? readFileSync(readme, 'utf8') : `# ${src.name}\n\nPart of Sprint. Source, docs and the integration guide: ${REPO}\n`,
  );
}
console.log(`Built ${PUBLISHED.length} packages at version ${version} in build/packages`);
