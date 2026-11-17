import type {AgentPreset, ClientDiagnostics, Locale, PageContext, RequestContext} from '@sprint/contracts';
import type {Scope} from './app.ts';

/**
 * One Ask AI turn, in shared state under its id (deployment readiness spec, 2 and 6), so any
 * instance that runs a helper's tool or receives the turn's progress knows whose turn it is: the
 * project, the caller's context, their page, language and the browser's record
 * (`ClientDiagnostics`, spec 1.1.0, 3.2). Kept for the turn only.
 */
export interface TurnRecord {
  projectId: string;
  ctx: RequestContext;
  page: PageContext;
  /** The helper that took the turn first: the live line falls back to it. */
  entry: AgentPreset;
  locale: Locale;
  client: ClientDiagnostics | null;
}

/** A turn that never ended (its instance stopped) is forgotten after this. */
const TURN_TTL_MS = 10 * 60_000;
const key = (turnId: string) => `turn:${turnId}`;

export async function beginTurn(w: Scope, turnId: string, turn: Omit<TurnRecord, 'ctx'>): Promise<void> {
  await w.shared.set<TurnRecord>(key(turnId), {...turn, ctx: w.ctx}, TURN_TTL_MS);
}

export async function endTurn(w: Pick<Scope, 'shared'>, turnId: string): Promise<void> {
  await w.shared.delete(key(turnId));
}

/** The turn, when it is still running and belongs to the project; otherwise null. */
export async function turnOf(w: Pick<Scope, 'shared'>, turnId: string | null, projectId: string): Promise<TurnRecord | null> {
  if (!turnId) return null;
  const t = await w.shared.get<TurnRecord>(key(turnId));
  return t && t.projectId === projectId ? t : null;
}
