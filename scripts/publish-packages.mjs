#!/usr/bin/env node
/**
 * Publishes the built packages (`scripts/build-packages.mjs`) in dependency order, skipping every
 * package already in the registry at that version. A release that failed halfway is resumed by
 * running it again: what was published stays, the rest is published, and each package ends up
 * there exactly once. Says what it published and what it skipped.
 *
 *   node scripts/build-packages.mjs 1.2.0 && node scripts/publish-packages.mjs
 *
 * `NPM` names the npm command (default `npm`; the test passes a stand-in registry).
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLISHED} from './published.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = process.env.SPRINT_PACKAGES_DIR ?? path.join(root, 'build/packages');
const npm = process.env.NPM ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');

/** Is `name@version` in the registry? A missing package or version is "no"; any other error stops. */
function published(name, version, cwd) {
  try {
    const out = execFileSync(npm, ['view', `${name}@${version}`, 'version', '--json'], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    // npm prints nothing for a package that exists without this version.
    return out.trim() !== '' && JSON.parse(out) === version;
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (/E404|404 Not Found|is not in this registry|not found/i.test(text)) return false;
    throw new Error(`Could not check ${name}@${version} in the registry:\n${text}`);
  }
}

const done = [];
const skipped = [];
for (const dir of PUBLISHED) {
  const pkgDir = path.join(built, dir.split('/')[1]);
  if (!existsSync(path.join(pkgDir, 'package.json'))) throw new Error(`${pkgDir} is not built: run scripts/build-packages.mjs first.`);
  const {name, version} = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  if (published(name, version, pkgDir)) {
    skipped.push(`${name}@${version}`);
    console.log(`Skipped ${name}@${version}: already published.`);
    continue;
  }
  execFileSync(npm, ['publish'], {cwd: pkgDir, stdio: 'inherit'});
  done.push(`${name}@${version}`);
  console.log(`Published ${name}@${version}.`);
}
console.log(`Published ${done.length}, skipped ${skipped.length} already published${skipped.length ? `: ${skipped.join(', ')}` : ''}.`);
