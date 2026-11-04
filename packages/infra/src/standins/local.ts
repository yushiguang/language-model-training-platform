import type {FileStore, FileUploadOptions, Identity, UploadedFileInfo} from '../../../contracts/src/infra-api.ts';

/** Stand-in identity: one built-in user. */
export function localIdentity(name = 'Evelyn'): Identity {
  return {currentUser: async () => ({id: 'local-user', name})};
}

/** Stand-in file store: keeps files as data URLs, which is fine for small prompt images. */
export function browserFiles(): FileStore {
  return {
    upload: (file: Blob | string, name: string, options?: FileUploadOptions): Promise<UploadedFileInfo> =>
      new Promise((resolve, reject) => {
        const blob = typeof file === 'string' ? new Blob([file], {type: options?.mimeType ?? 'text/plain'}) : file;
        const reader = new FileReader();
        reader.onload = () => {
          options?.onProgress?.({uploadedBytes: blob.size, totalBytes: blob.size});
          resolve({url: String(reader.result), key: name, size: blob.size, mimeType: blob.type || options?.mimeType});
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }),
  };
}
