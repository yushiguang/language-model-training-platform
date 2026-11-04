#!/usr/bin/env node
/**
 * Boundary check: each package and app may import only the workspace packages listed here.
 * Apps never import each other's code; they talk through the contracts in @tsp/contracts.
 * The web composition root (apps/web/src/backend-api) is the one place that wires apps together.
 *
 * What it reads: every source file under apps/* and packages/* (ts, tsx, mts, cts, js, jsx, mjs,
 * cjs; not node_modules or build output), including files outside `src` (scripts, config). It
 * finds static imports and re-exports, side-effect imports, dynamic `import()` and `require()`;
 * an `import()` or `require()` whose target is not a plain string is refused, since it can't be
 * checked. It also checks the path aliases in the tsconfig files and in next.config.mjs, so an
 * alias can't point a permitted name at a forbidden place.
 *
 * Run: npm run check:boundaries
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Folder -> workspace packages it may import. `*` = anything. `tests`: what its tests may import
 * on top, to build fixtures from the stand-ins and the apps it talks to. The most specific folder
 * wins; a file in an app or package outside every listed folder (scripts, config) may import no
 * workspace package.
 */
const RULES = [
  {dir: 'packages/contracts/src', allow: []},
  {dir: 'packages/domain/src', allow: ['@tsp/contracts']},
  {dir: 'packages/platform/src', allow: ['@tsp/contracts', '@tsp/domain']},
  {dir: 'apps/llm-gateway/src', allow: ['@tsp/contracts', '@tsp/domain']},
  {dir: 'apps/catalog/src', allow: ['@tsp/contracts', '@tsp/domain', '@tsp/platform']},
  {dir: 'apps/labeling/src', allow: ['@tsp/contracts', '@tsp/domain', '@tsp/platform'], tests: ['@tsp/catalog']},
  {dir: 'apps/agents/src', allow: ['@tsp/contracts', '@tsp/domain'], tests: ['@tsp/platform']},
  {dir: 'apps/bff/src', allow: ['@tsp/contracts', '@tsp/domain'], tests: ['@tsp/platform', '@tsp/catalog', '@tsp/labeling']},
  {dir: 'apps/telemetry/src', allow: ['@tsp/contracts']},
  {dir: 'apps/web/src/backend-api', allow: '*'},
  {dir: 'apps/web/src', allow: ['@tsp/contracts', '@tsp/domain', '@/backend-api', '@/components', '@/ui']},
];

/** npm packages only one folder may import (Astryx is wrapped in our own components). */
const ONLY_IN = [{prefix: '@astryxdesign/', dir: 'apps/web/src/ui'}];

/** Where each alias must point (relative to the repo root). Any other alias is refused. */
const ALIASES = {
  '@tsp/contracts': 'packages/contracts/src/index.ts',
  '@tsp/domain': 'packages/domain/src/index.ts',
  '@tsp/platform': 'packages/platform/src/index.ts',
  '@tsp/platform-impl': 'packages/platform/src/config.ts',
  '@tsp/llm-gateway': 'apps/llm-gateway/src/index.ts',
  '@tsp/catalog': 'apps/catalog/src/index.ts',
  '@tsp/labeling': 'apps/labeling/src/index.ts',
  '@tsp/agents': 'apps/agents/src/index.ts',
  '@tsp/bff': 'apps/bff/src/index.ts',
  '@tsp/telemetry': 'apps/telemetry/src/index.ts',
  '@/*': 'apps/web/src/*',
};

const SKIP_DIRS = new Set(['node_modules', 'out', '.next', 'public', 'dist', 'coverage']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SOURCE.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const relOf = p => path.relative(root, p).split(path.sep).join('/');
const ruleFor = rel =>
  RULES.filter(r => rel === r.dir || rel.startsWith(r.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0] ?? {dir: rel.split('/').slice(0, 2).join('/'), allow: []};

/** Comments out, so an example in a comment is not read as an import. */
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const PATTERNS = [
  /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'a', export * from 'a'
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g, // import 'a'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('a')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('a'), import x = require('a')
];
/** import() or require() of something other than a plain string. */
const UNCHECKABLE = /\b(?:import|require)\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/g;

const problems = [];

for (const top of ['apps', 'packages']) {
  for (const pkg of readdirSync(path.join(root, top))) {
    const dir = path.join(root, top, pkg);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of walk(dir)) {
      const rel = relOf(file);
      const rule = ruleFor(rel);
      const src = stripComments(readFileSync(file, 'utf8'));
      const isTest = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file);
      for (const m of src.matchAll(UNCHECKABLE)) problems.push(`${rel}: an import() or require() of a computed name can't be checked ("${src.slice(m.index, m.index + 40).split('\n')[0]}")`);
      const specs = new Set(PATTERNS.flatMap(re => [...src.matchAll(re)].map(m => m[1])));
      for (const spec of specs) {
        for (const o of ONLY_IN) if (spec.startsWith(o.prefix) && !rel.startsWith(o.dir + '/')) problems.push(`${rel}: "${spec}" may only be imported in ${o.dir}`);
        if (rule.allow === '*') continue;
        if (spec.startsWith('.')) {
          // Relative imports must stay inside the same package or app.
          const target = relOf(path.resolve(path.dirname(file), spec));
          const home = rel.split('/').slice(0, 2).join('/');
          if (!target.startsWith(home + '/')) problems.push(`${rel}: relative import "${spec}" leaves ${home}`);
          continue;
        }
        if (!spec.startsWith('@tsp/') && !spec.startsWith('@/')) continue; // npm packages and node: builtins
        const base = spec.startsWith('@/') ? '@/' + spec.slice(2).split('/')[0] : spec.split('/').slice(0, 2).join('/');
        const allowed = rule.allow.includes(base) || (isTest && (rule.tests ?? []).includes(base));
        if (!allowed) problems.push(`${rel}: may not import "${spec}" (allowed: ${rule.allow.join(', ') || 'nothing'})`);
      }
    }
  }
}

// Aliases: tsconfig paths and the bundler's resolveAlias may only point where ALIASES says.
for (const cfg of ['tsconfig.base.json', 'tsconfig.json', 'apps/web/tsconfig.json']) {
  let json;
  try {
    json = JSON.parse(readFileSync(path.join(root, cfg), 'utf8'));
  } catch {
    continue;
  }
  const paths = json.compilerOptions?.paths ?? {};
  for (const [alias, targets] of Object.entries(paths)) {
    const want = ALIASES[alias];
    if (!want) {
      problems.push(`${cfg}: alias "${alias}" is not in the boundary check's alias list`);
      continue;
    }
    for (const t of targets) {
      const got = relOf(path.resolve(path.dirname(path.join(root, cfg)), t));
      if (got !== want) problems.push(`${cfg}: alias "${alias}" points to ${got}, expected ${want}`);
    }
  }
}
const nextConfig = readFileSync(path.join(root, 'apps/web/next.config.mjs'), 'utf8');
const aliasBlock = /resolveAlias\s*:\s*\{([\s\S]*?)\}/.exec(nextConfig)?.[1] ?? '';
for (const m of aliasBlock.matchAll(/['"]([^'"]+)['"]\s*:/g)) {
  if (m[1] !== '@tsp/platform-impl') problems.push(`apps/web/next.config.mjs: resolveAlias "${m[1]}" is not allowed (only @tsp/platform-impl, the platform adapters)`);
}
if (/\balias\s*:/.test(nextConfig.replace(/resolveAlias/g, ''))) problems.push('apps/web/next.config.mjs: webpack aliases are not allowed; use turbopack.resolveAlias for @tsp/platform-impl only');

if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Boundary check passed.');
