/**
 * Every catalog key the site uses (spec 1.1.0, 2.1), found in the source: `t('…')` in the web app,
 * `msg('…')` and `lab('…')` in the services and domain, and the plain-text tables of the web app
 * (page names and hints, option names). Used by the catalog test, and from the command line:
 * `node --experimental-strip-types packages/domain/src/locales/used-keys.ts`. Not part of the package's exports.
 * Keys built at run time (step names, helper names, feature names) are added by the test.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCES = ['apps', 'packages'];
const SKIP = /node_modules|\.next|\/out\/|\.test\.ts$|\/locales\//;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const unquote = (q: string, body: string) => body.replace(new RegExp(`\\\\${q}`, 'g'), q).replace(/\\\\/g, '\\');
/** String literals that start a call to one of the catalog helpers. */
const CALL = /\b(?:t|msg|lab)\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** Web tables of plain text: page names and hints, option names and lines. */
const PROP = /\b(label|hint|first|sub|text|placeholder|name):\s*(['"])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const CONST = /^const [A-Z_]+ = (['"])((?:\\.|(?!\1)[^\\\n])*)\1;/gm;
/** Record<…, string> tables whose values are UI text. */
const TABLE = /^const [A-Z_]+: Record<[^>]+, string> = \{([^}]*)\};/gm;

/** Words that are not UI text, though they sit in a text-like place. */
const NOT_TEXT = /^(new_field|[a-z_-]+|[A-Z][A-Za-z]*_[A-Za-z_]+|Figtree.*)$/;

export function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (k: string, file: string) => {
    if (!k || !/[A-Za-z]{2}/.test(k.replace(/\{\w+\}/g, ''))) return;
    if (!keys.has(k)) keys.set(k, relative(ROOT, file));
  };
  for (const dir of SOURCES)
    for (const f of files(join(ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(CALL)) add(unquote(m[1], m[2]), f);
      if (!f.includes(`apps${'/'}web${'/'}`)) continue;
      for (const m of src.matchAll(PROP)) if (!NOT_TEXT.test(m[3])) add(unquote(m[2], m[3]), f);
      for (const m of src.matchAll(CONST)) if (!NOT_TEXT.test(m[2])) add(unquote(m[1], m[2]), f);
      for (const m of src.matchAll(TABLE)) for (const v of m[1].matchAll(/:\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (!NOT_TEXT.test(v[2])) add(unquote(v[1], v[2]), f);
    }
  return keys;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) for (const [k, f] of usedKeys()) console.log(`${f}\t${k}`);
