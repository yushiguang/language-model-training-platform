#!/usr/bin/env node
/**
 * Boundary check: each package and app may import only the workspace packages listed here.
 * Apps never import each other's code; they talk through the contracts in @tsp/contracts.
 * The web composition root (apps/web/src/backend-api) is the one place that wires apps together.
 *
 * Run: npm run check:boundaries
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Folder -> workspace packages it may import. `*` = anything. */
const RULES = [
  {dir: 'packages/contracts/src', allow: []},
  {dir: 'packages/domain/src', allow: ['@tsp/contracts']},
  {dir: 'packages/platform/src', allow: ['@tsp/contracts', '@tsp/domain']},
  {dir: 'apps/llm-gateway/src', allow: ['@tsp/contracts', '@tsp/domain']},
  {dir: 'apps/catalog/src', allow: ['@tsp/contracts', '@tsp/domain', '@tsp/platform']},
  {dir: 'apps/labeling/src', allow: ['@tsp/contracts', '@tsp/domain', '@tsp/platform']},
  {dir: 'apps/agents/src', allow: ['@tsp/contracts', '@tsp/domain']},
  {dir: 'apps/bff/src', allow: ['@tsp/contracts', '@tsp/domain']},
  {dir: 'apps/telemetry/src', allow: ['@tsp/contracts']},
  {dir: 'apps/web/src/backend-api', allow: '*'},
  {dir: 'apps/web/src', allow: ['@tsp/contracts', '@tsp/domain', '@/backend-api', '@/components', '@/ui', '@/app']},
];

/** Tests may also use the stand-ins and the app under test's neighbours to build fixtures. */
const TEST_EXTRA = ['@tsp/platform', '@tsp/catalog'];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const ruleFor = rel => RULES.find(r => rel === r.dir || rel.startsWith(r.dir + '/'));

const problems = [];
for (const rule of RULES) {
  const abs = path.join(root, rule.dir);
  let files = [];
  try {
    files = walk(abs);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (ruleFor(rel) !== rule) continue;
    const src = readFileSync(file, 'utf8');
    const isTest = /\.test\.tsx?$/.test(file);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (rule.allow === '*') continue;
      if (spec.startsWith('.')) {
        // Relative imports must stay inside the same package or app.
        const target = path.relative(root, path.resolve(path.dirname(file), spec)).split(path.sep).join('/');
        const home = rule.dir.split('/').slice(0, 2).join('/');
        if (!target.startsWith(home + '/')) problems.push(`${rel}: relative import "${spec}" leaves ${home}`);
        continue;
      }
      if (!spec.startsWith('@tsp/') && !spec.startsWith('@/')) continue; // npm packages and node: builtins
      const base = spec.startsWith('@/') ? '@/' + spec.slice(2).split('/')[0] : spec.split('/').slice(0, 2).join('/');
      const allowed = rule.allow.includes(base) || (isTest && TEST_EXTRA.includes(base));
      if (!allowed) problems.push(`${rel}: may not import "${spec}" (allowed: ${rule.allow.join(', ') || 'nothing'})`);
    }
  }
}

if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Boundary check passed.');
