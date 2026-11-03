import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Static export: the hosting platform serves plain files and runs no server code of ours.
 * Set NEXT_PUBLIC_BASE_PATH when the app is served under a sub-path.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default {
  output: 'export',
  trailingSlash: true,
  basePath,
  images: {unoptimized: true},
  experimental: {
    externalDir: true,
  },
  turbopack: {
    root: repoRoot,
  },
};
