declare module 'busboy' {
  import type { Readable, Writable } from 'node:stream';

  interface FileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  interface BusboyParser extends Writable {
    on(event: 'field', listener: (name: string, value: string) => void): this;
    on(event: 'file', listener: (name: string, stream: Readable, info: FileInfo) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'finish', listener: () => void): this;
  }

  interface Limits {
    fieldSize?: number;
    fields?: number;
    files?: number;
    fileSize?: number;
  }

  function Busboy(options: {
    headers: { 'content-type': string };
    limits?: Limits;
  }): BusboyParser;

  export default Busboy;
}
