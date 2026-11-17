import type {RpcResponse} from '@yushiguang/sprint-contracts';

/**
 * A service contract as it would be served behind RPC, in this process (deployment readiness
 * spec, 2): every argument, result and error goes through JSON on the way, exactly as it would
 * over the wire, so a call that leans on something JSON drops (a function, a class instance, an
 * `undefined` that matters, a `Map`) fails here first, in the tests and the browser check, and
 * not after the module moves out. Methods are called as `(ctx, ...args)`; the context crosses too.
 */
export function loopback<T extends object>(impl: T): T {
  const out = {} as Record<string, unknown>;
  for (const [method, fn] of Object.entries(impl)) {
    if (typeof fn !== 'function') continue;
    out[method] = async (...args: unknown[]) => {
      // Trailing undefined arguments are dropped, as a JSON array would lose them.
      let n = args.length;
      while (n > 0 && args[n - 1] === undefined) n--;
      const sent = JSON.parse(JSON.stringify(args.slice(0, n))) as unknown[];
      let res: RpcResponse;
      try {
        const result = await (fn as (...a: unknown[]) => unknown).apply(impl, sent);
        res = {result: result === undefined ? null : result};
      } catch (e) {
        res = {error: {code: (e as {code?: string}).code ?? 'error', message: e instanceof Error ? e.message : String(e)}};
      }
      const back = JSON.parse(JSON.stringify(res)) as RpcResponse;
      if ('error' in back) throw Object.assign(new Error(back.error.message), {code: back.error.code});
      return back.result;
    };
  }
  return out as T;
}
