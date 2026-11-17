import type {BffContract, RuntimeInfo} from './bff-api.ts';
import type {RequestContext} from './platform-api.ts';

/**
 * Contract 6: the application module (`@sprint/workflow`, deployment readiness spec, 2).
 *
 * Everything a channel (the web pages' bff today; a CLI or a tool channel later) needs, with the
 * caller's `RequestContext` as the first argument of every method, so a server is multi-user from
 * the first version and the context never has to be added to every signature later. The methods
 * and their plain-JSON arguments are `BffContract`'s; the bff is a thin adapter that authenticates
 * the caller, builds the context and calls these.
 *
 * Deployed next to the bff (in-process) or behind RPC (`RpcRequest` / `RpcResponse`), without the
 * bff changing.
 */

/** `(ctx, ...args) => result` for a contract method `(...args) => result`. */
export type WithContext<F> = F extends (...args: infer A) => infer R ? (ctx: RequestContext, ...args: A) => R : never;

/** What the workflow knows of the runtime; the bff adds the signed-in user and Sign out. */
export type WorkflowRuntimeInfo = Omit<RuntimeInfo, 'user' | 'canSignOut'>;

export type WorkflowContract = {
  [K in Exclude<keyof BffContract, 'getRuntimeInfo' | 'signOut'>]: WithContext<BffContract[K]>;
} & {
  runtimeInfo(ctx: RequestContext): Promise<WorkflowRuntimeInfo>;
};

/**
 * One call across a process boundary: the method's name, the caller's context and the method's
 * arguments after the context, all plain JSON. Any service contract travels this way.
 */
export interface RpcRequest {
  method: string;
  ctx: RequestContext;
  args: unknown[];
}

/** A call's outcome: the result, or an error a client can show (`code` as in `errors.ts`). */
export type RpcResponse = {result: unknown} | {error: {code: string; message: string}};
