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
 * `@yushiguang/sprint-platform-impl` = what sits behind the platform contracts. Default: the stand-ins.
 * A deployment sets SPRINT_PLATFORM_IMPL to a module (relative to the repo root) that exports
 * the same `createPlatform()` over its real adapters.
 */
const platformImpl = process.env.SPRINT_PLATFORM_IMPL || 'packages/platform/src/config.ts';

/**
 * `@yushiguang/sprint-client-impl` = the `BffClient` the pages call. Default: the in-process client (every
 * service runs in the page). A server deployment sets SPRINT_CLIENT_IMPL to a module (relative to
 * the repo root) that exports `client`, such as an HTTP client; the backend apps are then not
 * bundled into the site.
 */
const clientImpl = process.env.SPRINT_CLIENT_IMPL || 'apps/web/src/backend-api/in-process.ts';

/** A repo-root path as the bundler wants it: relative to this folder, starting with a dot. */
const fromWeb = p => {
  const rel = path.relative(webDir, path.resolve(repoRoot, p)).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

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
      '@yushiguang/sprint-platform-impl': fromWeb(platformImpl),
      '@yushiguang/sprint-client-impl': fromWeb(clientImpl),
    },
  },
};
