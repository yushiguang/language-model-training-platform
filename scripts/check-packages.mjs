#!/usr/bin/env node
/**
 * Checks the built packages (`scripts/build-packages.mjs`) the way a consumer uses them: packs each
 * one, installs the tarballs into an empty project, imports every package in Node, and typechecks
 * a small consumer that wires the modules together the way a server composition would.
 *
 *   node scripts/build-packages.mjs 0.0.0-check && node scripts/check-packages.mjs
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'build/packages');
const tarballs = path.join(root, 'build/tarballs');
const consumer = path.join(root, 'build/consumer');
rmSync(tarballs, {recursive: true, force: true});
rmSync(consumer, {recursive: true, force: true});
mkdirSync(tarballs, {recursive: true});
mkdirSync(consumer, {recursive: true});

const run = (cmd, args, cwd) => execFileSync(cmd, args, {cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8'});
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const names = [];
for (const dir of readdirSync(built)) {
  run(npm, ['pack', '--silent', '--pack-destination', tarballs], path.join(built, dir));
  names.push(JSON.parse(run('node', ['-p', 'JSON.stringify(require("./package.json").name)'], path.join(built, dir))));
}

writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({name: 'consumer', private: true, type: 'module'}, null, 2));
run(npm, ['install', '--no-audit', '--no-fund', '--offline', ...readdirSync(tarballs).map(f => path.join(tarballs, f))], consumer);

// Every package loads in plain Node, with no TypeScript.
for (const name of names) run('node', ['--input-type=module', '-e', `await import(${JSON.stringify(name)});`], consumer);

// A server composition typechecks against the published declarations.
writeFileSync(
  path.join(consumer, 'main.ts'),
  `import type {WorkflowContract, AgentRuntimeContract} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {createLabeling, memoryLocks} from '@yushiguang/sprint-labeling';
import {createWorkflow, systemContext} from '@yushiguang/sprint-workflow';
import {createJobs} from '@yushiguang/sprint-jobs';
import {createBffApi} from '@yushiguang/sprint-bff';
import {localDocRuntime, loopback, memoryJobStore, memorySharedState} from '@yushiguang/sprint-platform';

export function compose(agents: AgentRuntimeContract) {
  const db = localDocRuntime('consumer');
  const catalog = createCatalog(db);
  const labeling = createLabeling({db, catalog, gateway: {} as never, locks: memoryLocks()});
  const workflow = createWorkflow({catalog, labeling, gateway: {} as never, files: {} as never, examples: {} as never, standIns: [], sharedState: memorySharedState(), jobs: createJobs({store: memoryJobStore()}).api});
  workflow.connect({agents});
  const api: WorkflowContract = loopback(workflow.api) as WorkflowContract;
  return {api, ctx: systemContext('consumer'), createBffApi};
}
`,
);
writeFileSync(
  path.join(consumer, 'tsconfig.json'),
  JSON.stringify({compilerOptions: {target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, skipLibCheck: false, lib: ['es2023', 'dom'], types: []}, include: ['main.ts']}, null, 2),
);
run('node', [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumer);
console.log(`Packages check passed: ${names.length} packages install, load in Node and typecheck in a consumer.`);
