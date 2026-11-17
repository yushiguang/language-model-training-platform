import type {FileStore, FileUploadOptions, Identity, TelemetryEvent, TelemetrySink, UploadedFileInfo} from '@tsp/contracts';

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

/**
 * Stand-in telemetry sink: nothing leaves the browser. Events are kept in a ring of the last 1,000
 * in local storage (`tsp-telemetry-events`); the latest metrics text is on
 * `globalThis.__tspMetrics`, so both can be inspected in the console. The company's adapter
 * replaces this (see docs/design/telemetry.md).
 */
export function localTelemetrySink(keep = 1000): TelemetrySink {
  const KEY = 'tsp-telemetry-events';
  return {
    async pushEvents(events: TelemetryEvent[]) {
      if (typeof localStorage === 'undefined') return;
      let all: TelemetryEvent[] = [];
      try {
        all = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      } catch {
        all = [];
      }
      all.push(...events);
      try {
        localStorage.setItem(KEY, JSON.stringify(all.slice(-keep)));
      } catch {
        // storage full: telemetry may be dropped
      }
    },
    async pushMetrics(exposition: string) {
      (globalThis as {__tspMetrics?: string}).__tspMetrics = exposition;
    },
  };
}
