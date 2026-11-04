import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Static export: the hosting platform serves plain files and runs no server code of ours.
 * Set NEXT_PUBLIC_BASE_PATH when the app is served under a sub-path.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, '../..');

/**
 * `@tsp/platform-impl` = what sits behind the platform contracts. Default: the stand-ins.
 * The internal build sets TSP_PLATFORM_IMPL to a module (relative to the repo root) that
 * exports the same `createPlatform()` over the real adapters.
 */
const platformImpl = process.env.TSP_PLATFORM_IMPL || 'packages/platform/src/config.ts';

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
    resolveAlias: {
      '@tsp/platform-impl': path.relative(webDir, path.resolve(repoRoot, platformImpl)),
    },
  },
};
