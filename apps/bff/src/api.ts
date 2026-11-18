import type {BffContract, CallerUser, Identity, Locale, RequestContext, WorkflowContract} from '@yushiguang/sprint-contracts';
import {newId} from '@yushiguang/sprint-domain';

/**
 * The bff as its contract (`BffContract`): the one surface the web pages call, in-process or over
 * HTTP. A thin channel adapter (deployment readiness spec, 2): it finds out who the caller is,
 * builds the `RequestContext` of each call, keeps a repeated start from running twice, and hands
 * the call to the workflow (`WorkflowContract`). It holds no records and makes no business
 * decision; anything another channel (a CLI, a tool) would also need belongs to the workflow.
 */
export interface BffDeps {
  /** The application module: in this process, or an RPC client of it. */
  workflow: WorkflowContract;
  /** Who is signed in. */
  identity: Identity;
  /** The app's version, carried on every call's context. */
  appVersion?: string;
  /** The caller's time zone, when the channel knows it (a browser does). */
  timeZone?: () => string | undefined;
}

/** How many idempotency keys a bff keeps; the oldest go first. */
const KEPT_KEYS = 500;

export function createBffApi(deps: BffDeps): BffContract {
  const {workflow, identity} = deps;

  // The signed-in user, asked once; a failed sign-in check is asked again on the next call.
  let user: Promise<CallerUser> | null = null;
  const currentUser = (): Promise<CallerUser> => {
    if (!user) {
      user = identity.currentUser().then(u => ({id: u.id, name: u.name, ...(u.email ? {email: u.email} : {})}));
      user.catch(() => (user = null));
    }
    return user;
  };

  /** The context of one call: a new request id, the caller, and what the channel knows. */
  const context = async (locale?: Locale): Promise<RequestContext> => {
    const timeZone = deps.timeZone?.();
    return {
      requestId: newId('rq'),
      user: await currentUser(),
      caller: 'bff',
      ...(locale ? {locale} : {}),
      ...(timeZone ? {timeZone} : {}),
      ...(deps.appVersion ? {appVersion: deps.appVersion} : {}),
    };
  };

  /**
   * The same idempotency key never starts the same work twice: a repeat gets the first call's
   * result (or its error). Kept in this bff's memory; a split deployment keeps it in a store.
   */
  const seen = new Map<string, Promise<unknown>>();
  function idempotent<T>(method: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const k = `${method}:${key}`;
    const earlier = seen.get(k);
    if (earlier) return earlier as Promise<T>;
    const p = fn();
    seen.set(k, p);
    // A failed call may be retried with the same key: only a success is kept.
    p.catch(() => seen.delete(k));
    if (seen.size > KEPT_KEYS) seen.delete(seen.keys().next().value!);
    return p;
  }

  /** Every other method: the same arguments, with the context in front. */
  const pass = <K extends keyof WorkflowContract>(method: K) =>
    (async (...args: unknown[]) => (workflow[method] as (...a: unknown[]) => unknown)(await context(), ...args)) as unknown as BffContract[K & keyof BffContract];

  return {
    async getRuntimeInfo() {
      const ctx = await context();
      return {...(await workflow.runtimeInfo(ctx)), user: {id: ctx.user.id, name: ctx.user.name}, canSignOut: typeof identity.signOut === 'function'};
    },
    async signOut() {
      if (!identity.signOut) throw new Error('This site has no sign-out.');
      await identity.signOut();
      user = null;
    },

    listProjects: pass('listProjects'),
    createProject: pass('createProject'),
    getProject: pass('getProject'),
    loadProjectState: pass('loadProjectState'),
    projectStatus: pass('projectStatus'),
    approveNode: pass('approveNode'),
    deleteProject: pass('deleteProject'),
    renameProject: pass('renameProject'),
    tick: pass('tick'),
    saveSettings: pass('saveSettings'),
    listDataSources: pass('listDataSources'),
    getDataSource: pass('getDataSource'),
    createDataSource: pass('createDataSource'),
    addSourceFile: pass('addSourceFile'),
    exampleMedia: pass('exampleMedia'),
    takeExamples: pass('takeExamples'),
    stopSampleDataset: pass('stopSampleDataset'),
    removeExamples: pass('removeExamples'),
    restoreExamples: pass('restoreExamples'),
    pruneDataset: pass('pruneDataset'),
    addComment: pass('addComment'),
    saveGold: pass('saveGold'),
    uploadGold: pass('uploadGold'),
    uploadGoldText: pass('uploadGoldText'),
    importBundledGold: pass('importBundledGold'),
    mismatches: pass('mismatches'),
    reviewGold: pass('reviewGold'),
    rebuildReports: pass('rebuildReports'),

    createVersion: r => idempotent('createVersion', r.idempotencyKey, async () => workflow.createVersion(await context(), r)),
    scoreVersion: r => idempotent('scoreVersion', r.idempotencyKey, async () => workflow.scoreVersion(await context(), r)),
    stopRun: pass('stopRun'),
    startOptimiser: r => idempotent('startOptimiser', r.idempotencyKey, async () => workflow.startOptimiser(await context(), r)),
    stopOptimiser: pass('stopOptimiser'),
    retryOptimiser: pass('retryOptimiser'),
    improveWithAi: async (projectId, versionId, locale) => workflow.improveWithAi(await context(locale), projectId, versionId, locale),
    featureInfo: pass('featureInfo'),
    predictionsFor: pass('predictionsFor'),

    chatHistory: pass('chatHistory'),
    getAgentLive: pass('getAgentLive'),
    getAnsweringAgent: pass('getAnsweringAgent'),
    sendUserMessage: async r => workflow.sendUserMessage(await context(r.locale), r),
    openProposals: pass('openProposals'),
    proposals: pass('proposals'),
    closeProposal: pass('closeProposal'),
  };
}
