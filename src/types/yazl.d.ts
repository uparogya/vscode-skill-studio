declare module 'yazl' {
  import { Readable } from 'stream';

  export class ZipFile {
    outputStream: Readable;
    addFile(realPath: string, metadataPath: string): void;
    addEmptyDirectory(metadataPath: string): void;
    end(): void;
  }
}
