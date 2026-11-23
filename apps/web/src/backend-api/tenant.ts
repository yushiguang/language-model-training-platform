/**
 * The tenant the page works in (#94). A person can be in several tenants, so every call names one
 * (`createBffApi({tenant})`): the address's `?t=` when it has one, else the tenant last opened in
 * this browser. Links inside the site carry `?t=`, so a shared link opens in its own tenant. An
 * HTTP client sends the same value as a request header.
 */
const KEY = 'sprint-tenant';

function stored(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** The tenant of this page: the address first, then this browser's last one. */
export function currentTenant(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  const fromUrl = new URLSearchParams(location.search).get('t')?.trim();
  if (fromUrl) {
    if (fromUrl !== stored()) rememberTenant(fromUrl);
    return fromUrl;
  }
  return stored();
}

/** Keeps the tenant for pages whose address names none; null forgets it (the caller is not in it). */
export function rememberTenant(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(KEY, id);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Storage blocked: the address still names the tenant.
  }
}
