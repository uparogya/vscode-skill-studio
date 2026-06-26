declare module 'yauzl' {
  import { EventEmitter } from 'events';

  export interface Entry {
    fileName: string;
  }

  export interface Options {
    lazyEntries?: boolean;
  }

  export class ZipFile extends EventEmitter {
    readEntry(): void;
    close(): void;
    openReadStream(
      entry: Entry,
      callback: (err: Error | null, readStream?: NodeJS.ReadableStream) => void
    ): void;
  }

  export function open(
    path: string,
    options: Options,
    callback: (err: Error | null, zipFile?: ZipFile) => void
  ): void;
}
