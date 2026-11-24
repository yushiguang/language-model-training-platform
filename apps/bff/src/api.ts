import {DEFAULT_TENANT, type BffContract, type CallerUser, type Identity, type Locale, type RequestContext, type WorkflowContract} from '@yushiguang/sprint-contracts';
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
  /**
   * The tenant the caller is working in, as the channel says it (#94): the page's tenant in the
   * browser, a request header over HTTP. Left out or empty: the identity's organization, else
   * `default`. The workflow checks the caller is in it (`AuthorizationPort`), so naming another
   * tenant gains nothing.
   */
  tenant?: () => string | undefined;
}

/** How many idempotency keys a bff keeps; the oldest go first. */
const KEPT_KEYS = 500;

export function createBffApi(deps: BffDeps): BffContract {
  const {workflow, identity} = deps;

  // The signed-in user, asked once; a failed sign-in check is asked again on the next call. Their
  // organization is the tenant: what a tenant owns (data sources, #29) is kept per organization.
  let user: Promise<{user: CallerUser; tenantId?: string; tenantName?: string}> | null = null;
  const currentUser = (): Promise<{user: CallerUser; tenantId?: string; tenantName?: string}> => {
    if (!user) {
      user = identity.currentUser().then(u => ({user: {id: u.id, name: u.name, ...(u.email ? {email: u.email} : {})}, ...(u.organization ? {tenantId: u.organization} : {}), ...(u.organizationName ? {tenantName: u.organizationName} : {})}));
      user.catch(() => (user = null));
    }
    return user;
  };

  /** The context of one call: a new request id, the caller, and what the channel knows. */
  const context = async (locale?: Locale, known?: Awaited<ReturnType<typeof currentUser>>): Promise<RequestContext> => {
    const timeZone = deps.timeZone?.();
    const who = known ?? (await currentUser());
    const tenantId = deps.tenant?.()?.trim() || who.tenantId;
    return {
      requestId: newId('rq'),
      user: who.user,
      ...(tenantId ? {tenantId} : {}),
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

  /**
   * A tenant with no record (#94): the identity's own tenant (its organization, else `default`)
   * is called by the organization's name; any other by its id.
   */
  const nameOf = (who: Awaited<ReturnType<typeof currentUser>>, tenantId: string) => ((who.tenantId ?? DEFAULT_TENANT) === tenantId ? (who.tenantName ?? tenantId) : tenantId);

  /** Every other method: the same arguments, with the context in front. */
  const pass = <K extends keyof WorkflowContract>(method: K) =>
    (async (...args: unknown[]) => (workflow[method] as (...a: unknown[]) => unknown)(await context(), ...args)) as unknown as BffContract[K & keyof BffContract];

  return {
    async getRuntimeInfo() {
      // One read of the caller, so a sign-out during the call can't mix two users in the answer.
      const who = await currentUser();
      const ctx = await context(undefined, who);
      const {tenantRole, tenantName, ...info} = await workflow.runtimeInfo(ctx);
      const tenantId = ctx.tenantId ?? DEFAULT_TENANT;
      return {
        ...info,
        user: {id: ctx.user.id, name: ctx.user.name},
        canSignOut: typeof identity.signOut === 'function',
        // No role: the caller is not in this tenant, and the site sends them home.
        ...(tenantRole ? {tenant: {id: tenantId, name: tenantName ?? nameOf(who, tenantId), role: tenantRole}} : {}),
      };
    },
    async signOut() {
      if (!identity.signOut) throw new Error('This site has no sign-out.');
      await identity.signOut();
      user = null;
    },
    requestAccess: pass('requestAccess'),
    // Tenants without a record are named as the top bar names them.
    async listTenants() {
      const who = await currentUser();
      const list = await workflow.listTenants(await context(undefined, who));
      return list.map(t => (t.name === t.id ? {...t, name: nameOf(who, t.id)} : t));
    },
    createTenant: pass('createTenant'),
    listTenantMembers: pass('listTenantMembers'),

    listProjects: pass('listProjects'),
    createProject: pass('createProject'),
    listProjectRows: pass('listProjectRows'),
    async getTenant() {
      const who = await currentUser();
      const t = await workflow.getTenant(await context(undefined, who));
      return t.name === t.id ? {...t, name: nameOf(who, t.id)} : t;
    },
    projectDefaults: pass('projectDefaults'),
    renameTenant: pass('renameTenant'),
    deleteTenant: pass('deleteTenant'),
    addTenantMembers: pass('addTenantMembers'),
    setTenantRole: pass('setTenantRole'),
    removeTenantMember: pass('removeTenantMember'),
    searchPeople: pass('searchPeople'),
    newProject: pass('newProject'),
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
    renameDataSource: pass('renameDataSource'),
    deleteDataSource: pass('deleteDataSource'),
    listModels: pass('listModels'),
    addModel: pass('addModel'),
    updateModel: pass('updateModel'),
    removeModel: pass('removeModel'),
    setDefaultModel: pass('setDefaultModel'),
    exampleMedia: pass('exampleMedia'),
    getExampleFeatures: pass('getExampleFeatures'),
    takeExamples: pass('takeExamples'),
    stopSampleDataset: pass('stopSampleDataset'),
    removeExamples: pass('removeExamples'),
    listSamples: pass('listSamples'),
    listLabelSets: pass('listLabelSets'),
    previewLabelSets: pass('previewLabelSets'),
    createLabelSet: pass('createLabelSet'),
    createLabelSets: pass('createLabelSets'),
    updateLabelSet: pass('updateLabelSet'),
    goldLabelsCleared: pass('goldLabelsCleared'),
    restoreExamples: pass('restoreExamples'),
    pruneDataset: pass('pruneDataset'),
    addComment: pass('addComment'),
    editComment: pass('editComment'),
    deleteComment: pass('deleteComment'),
    saveGold: pass('saveGold'),
    uploadGold: pass('uploadGold'),
    uploadGoldText: pass('uploadGoldText'),
    importBundledGold: pass('importBundledGold'),
    mismatches: pass('mismatches'),
    reviewGold: pass('reviewGold'),
    rebuildReports: pass('rebuildReports'),
    rescore: pass('rescore'),

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
