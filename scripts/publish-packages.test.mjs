import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {PUBLISHED} from './published.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish-packages.mjs');

/**
 * A stand-in npm over a registry kept in a JSON file: `view` answers E404 for what is not there,
 * `publish` adds the package (and refuses one already there, as a registry does), and fails once
 * for the package named in FAIL_ONCE.
 */
function fakeNpm(dir) {
  const bin = path.join(dir, 'npm');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const reg = process.env.REGISTRY_FILE;
const db = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, 'utf8')) : {published: [], failed: []};
const save = () => fs.writeFileSync(reg, JSON.stringify(db));
const [cmd, spec] = process.argv.slice(2);
if (cmd === 'view') {
  if (db.published.includes(spec)) { console.log(JSON.stringify(spec.slice(spec.lastIndexOf('@') + 1))); process.exit(0); }
  console.error('npm error code E404'); process.exit(1);
}
if (cmd === 'publish') {
  const {name, version} = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const id = name + '@' + version;
  if (db.published.includes(id)) { console.error('npm error 409 Conflict: cannot publish over the previously published version'); process.exit(1); }
  if (process.env.FAIL_ONCE === name && !db.failed.includes(name)) { db.failed.push(name); save(); console.error('npm error network'); process.exit(1); }
  db.published.push(id); save(); process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test('a release that failed halfway resumes: a re-run skips what was published and publishes the rest, each once (#27)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprint-publish-'));
  const packages = path.join(dir, 'packages');
  for (const ws of PUBLISHED) {
    const d = path.join(packages, ws.split('/')[1]);
    mkdirSync(d, {recursive: true});
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({name: `@test/${ws.split('/')[1]}`, version: '1.2.0'}));
  }
  const registry = path.join(dir, 'registry.json');
  const env = {...process.env, NPM: fakeNpm(dir), SPRINT_PACKAGES_DIR: packages, REGISTRY_FILE: registry, FAIL_ONCE: '@test/labeling'};
  const run = () => execFileSync(process.execPath, [script], {env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

  // The first run stops at the package that fails, after publishing the ones before it.
  assert.throws(run);
  const first = JSON.parse(readFileSync(registry, 'utf8')).published;
  assert.deepEqual(first, ['@test/contracts@1.2.0', '@test/domain@1.2.0', '@test/platform@1.2.0', '@test/llm-gateway@1.2.0', '@test/catalog@1.2.0']);

  // The re-run says what it skipped and ends with every package there exactly once.
  const out = run();
  assert.match(out, /Skipped @test\/contracts@1\.2\.0: already published\./);
  assert.match(out, /Published 6, skipped 5 already published/);
  const all = JSON.parse(readFileSync(registry, 'utf8')).published;
  assert.equal(all.length, PUBLISHED.length);
  assert.equal(new Set(all).size, PUBLISHED.length);

  // A third run publishes nothing.
  assert.match(run(), /Published 0, skipped 11 already published/);
});
