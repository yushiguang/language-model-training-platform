/** A piece of copy in both UI languages. Mock data and story text use this instead of message keys. */
export interface T {
  en: string;
  zh: string;
}

export function t(en: string, zh: string): T {
  return {en, zh};
}
