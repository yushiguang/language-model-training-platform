// Bundles the demo into one HTML file with inline CSS and JS, for sharing as a private link.
// Usage: node scripts/build-artifact.mjs [out-file]
import {build} from 'esbuild';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const outFile = resolve(process.argv[2] ?? 'dist-artifact/index.html');

const result = await build({
  entryPoints: ['src/artifact/main.tsx'],
  bundle: true,
  minify: true,
  write: false,
  outdir: 'dist-artifact',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  define: {'process.env.NODE_ENV': '"production"'},
  alias: {'next/link': './src/artifact/Link.tsx'},
  logLevel: 'warning',
});

const js = result.outputFiles.find(f => f.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
const css = result.outputFiles.find(f => f.path.endsWith('.css')).text.replaceAll('</style', '<\\/style');

// Google Sans titles; the page falls back to system sans if Google Fonts is unreachable.
const fonts = 'https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&display=swap';

const html = `<title>Language Model Training Platform</title>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>
<div id="root"></div>
<script>${js}</script>
`;

mkdirSync(dirname(outFile), {recursive: true});
writeFileSync(outFile, html);
console.log(`${outFile} (${(html.length / 1024).toFixed(0)} KB)`);
