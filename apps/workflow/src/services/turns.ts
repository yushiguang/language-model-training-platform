import type {ClientDiagnostics, Locale, PageContext, RequestContext} from '@sprint/contracts';
import type {Scope} from './app.ts';

/**
 * The Ask AI turn running now, per project, in shared state (deployment readiness spec, 2), so
 * any instance that runs a helper's tool knows whose turn it is: the caller's context, their page,
 * language and the browser's record (`ClientDiagnostics`, spec 1.1.0, 3.2). Kept for the turn only.
 */
export interface TurnRecord {
  ctx: RequestContext;
  page: PageContext;
  locale: Locale;
  client: ClientDiagnostics | null;
}

/** A turn that never ended (its instance stopped) is forgotten after this. */
const TURN_TTL_MS = 10 * 60_000;
const key = (projectId: string) => `turn:${projectId}`;

export async function beginTurn(w: Scope, projectId: string, turn: Omit<TurnRecord, 'ctx'>): Promise<void> {
  await w.shared.set<TurnRecord>(key(projectId), {...turn, ctx: w.ctx}, TURN_TTL_MS);
}

export async function endTurn(w: Scope, projectId: string): Promise<void> {
  await w.shared.delete(key(projectId));
}

export async function currentTurn(w: Pick<Scope, 'shared'>, projectId: string): Promise<TurnRecord | null> {
  return w.shared.get<TurnRecord>(key(projectId));
}
