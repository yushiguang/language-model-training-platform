/**
 * The workspaces published as npm packages, in dependency order (a package comes after every
 * package it imports). The agent runtime (`apps/agents`) and the web app are not published.
 */
export const PUBLISHED = [
  'packages/contracts',
  'packages/domain',
  'packages/platform',
  'apps/llm-gateway',
  'apps/catalog',
  'apps/labeling',
  'apps/optimiser',
  'apps/jobs',
  'apps/workflow',
  'apps/bff',
  'apps/telemetry',
];
