import type {FileStore, Identity} from '../interfaces';

/** Stand-in identity: one built-in user. */
export function localIdentity(name = 'Evelyn'): Identity {
  return {currentUser: async () => ({id: 'local-user', name})};
}

/** Stand-in file store: keeps files as data URLs, which is fine for small prompt images. */
export function browserFiles(): FileStore {
  return {
    upload: (file: Blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({url: String(reader.result)});
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }),
  };
}
