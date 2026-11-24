import {DEFAULT_TENANT, type Platform} from '@yushiguang/sprint-contracts';
import {localDocRuntime} from './standins/local-db.ts';
import {sampleExamples, sampleMedia} from './standins/sample-examples.ts';
import {sampleFeatureInfo} from './standins/feature-info.ts';
import {noDocuments} from './standins/documents.ts';
import {simulatedModels} from './standins/simulated-models.ts';
import {scriptedAgent} from './standins/scripted-agent.ts';
import {standInAuthorization, memoryAccessRequests, memoryPermissionAdmin} from './standins/enterprise.ts';
import {memoryConfig} from './standins/config-store.ts';
import {browserFiles, LOCAL_USER, localIdentity, localTelemetrySink} from './standins/local.ts';
import {localTickets} from './standins/tickets.ts';
import {logNotifications} from './standins/notifications.ts';
import {memorySharedState} from './standins/shared-state.ts';
import {memoryPeople, SAMPLE_PEOPLE} from './standins/people.ts';

/** Stand-in colleagues in the default tenant (#107), so label sets have someone to assign. */
const COLLEAGUES = SAMPLE_PEOPLE.slice(0, 4).map(p => ({userId: p.id, name: p.name, ...(p.email ? {email: p.email} : {})}));

/**
 * A stand-in switch this browser holds in its local storage, so a deployment's optional modes
 * can be tried without its platform (#120): `sprint-standin-min-admins` = a number of admins every
 * tenant needs, `sprint-standin-access-requests` = `redirect` for requests made on the permission
 * platform's own form.
 */
function standInSwitch(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The default platform: browser/local stand-ins, so the repository runs end to end without any
 * credentials.
 *
 * A deployment does not edit this file. It points the `@yushiguang/sprint-platform-impl` import
 * alias at its own module, which exports the same `createPlatform(): Platform` (see
 * docs/integration.md).
 */
export function createPlatform(): Platform {
  const minAdmins = Number(standInSwitch('sprint-standin-min-admins'));
  const redirect = standInSwitch('sprint-standin-access-requests') === 'redirect';
  return {
    ...(Number.isInteger(minAdmins) && minAdmins > 1 ? {config: {tenant: {minAdmins}}} : {}),
    // Single-label projects (2026-11-16): projects saved before are test data and start fresh.
    db: localDocRuntime('sprint-doc', ['tsp-doc', 'tsp-doc-v2']),
    models: simulatedModels(),
    agent: scriptedAgent(),
    identity: localIdentity(),
    files: browserFiles(),
    examples: sampleExamples(process.env.NEXT_PUBLIC_BASE_PATH ?? ''),
    media: sampleMedia(process.env.NEXT_PUBLIC_BASE_PATH ?? ''),
    featureInfo: sampleFeatureInfo(),
    documents: noDocuments(),
    telemetry: localTelemetrySink(),
    configStore: memoryConfig(),
    authorization: standInAuthorization(),
    // The local user is an admin of the tenant the sample data lives in, with a few made-up
    // colleagues to pick as labelers; tenants made here are kept in this browser.
    permissionAdmin: memoryPermissionAdmin({seed: [{tenantId: DEFAULT_TENANT, userId: LOCAL_USER, role: 'admin'}, ...COLLEAGUES.map(c => ({tenantId: DEFAULT_TENANT, ...c, role: 'member' as const}))], storageKey: 'sprint-permissions', people: SAMPLE_PEOPLE}),
    accessRequests: redirect
      ? memoryAccessRequests({mode: 'redirect', applyUrl: r => `https://permissions.example.com/apply?tenant=${encodeURIComponent(r.tenantId)}&permission=${r.permission}${r.projectId ? `&project=${encodeURIComponent(r.projectId)}` : ''}`})
      : memoryAccessRequests(),
    people: memoryPeople(),
    tickets: localTickets(),
    notifications: logNotifications(),
    sharedState: memorySharedState(),
    standIns: ['storage', 'labeling models', 'agent model', 'identity', 'files', 'examples', 'media', 'feature descriptions', 'document links', 'telemetry', 'problem reports', 'notifications', 'shared state', 'configuration', 'permissions', 'people directory'],
  };
}

