import type {SqlRuntime} from '../interfaces';

/**
 * Stand-in storage: real Postgres compiled to WebAssembly (PGlite), kept in the browser's
 * IndexedDB. The app's SQL is plain Postgres, so the same statements run on the real
 * storage runtime once it is plugged in.
 */
export function pgliteSql(dbName = 'training-set-platform'): SqlRuntime {
  let ready: Promise<import('@electric-sql/pglite').PGlite> | null = null;
  const db = () =>
    (ready ??= import('@electric-sql/pglite').then(async ({PGlite}) => {
      const pg = new PGlite(typeof indexedDB === 'undefined' ? undefined : `idb://${dbName}`);
      await pg.waitReady;
      return pg;
    }));
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await (await db()).query<T>(sql, params);
      return res.rows;
    },
    async exec(sql: string) {
      await (await db()).exec(sql);
    },
  };
}
