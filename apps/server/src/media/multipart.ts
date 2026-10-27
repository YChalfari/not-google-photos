import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import Busboy from 'busboy';
import { ApiError } from '../http/errors';
import { PayloadTooLargeError } from '../storage/provider';

/** Originals up to 8 GB. The library drive's free-space check is the other limit. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

export interface ReceivedUpload<T> {
  fields: Record<string, string>;
  filename: string;
  mimeType: string;
  result: T;
}

/**
 * Reads one streamed multipart upload. Text fields and the `file` part may arrive in either
 * order: the file is stored while the rest of the form is still being read, and the checksum
 * is compared afterwards.
 */
export function receiveUpload<T>(
  request: Request,
  ingest: (stream: Readable) => Promise<T>,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<ReceivedUpload<T>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) {
    return Promise.reject(
      new ApiError('unsupported_media_type', 'Send the photo as multipart/form-data'),
    );
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) {
    return Promise.reject(new PayloadTooLargeError(maxBytes));
  }
  if (!request.body) return Promise.reject(new ApiError('bad_request', 'The upload has no file'));

  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let result: T | undefined;
    let filename = 'upload';
    let mimeType = 'application/octet-stream';
    let sawFile = false;
    let truncated = false;
    let failed = false;
    let ingesting: Promise<void> = Promise.resolve();

    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const parser = Busboy({
      headers: { 'content-type': type },
      limits: { files: 2, fields: 24, fieldSize: 8 * 1024, fileSize: maxBytes },
    });

    parser.on('field', (name: string, value: string) => {
      if (!(name in fields)) fields[name] = value;
    });

    parser.on(
      'file',
      (name: string, stream: Readable, info: { filename: string; mimeType: string }) => {
        if (name !== 'file' || sawFile) {
          stream.resume();
          return;
        }
        sawFile = true;
        filename = info.filename || filename;
        mimeType = info.mimeType || mimeType;
        stream.on('limit', () => {
          truncated = true;
        });
        ingesting = ingest(stream)
          .then((stored) => {
            result = stored;
          })
          .catch((error: unknown) => {
            stream.resume();
            fail(error);
          });
      },
    );

    parser.on('error', fail);
    parser.on('finish', () => {
      void ingesting.then(() => {
        if (failed) return;
        if (!sawFile || result === undefined) {
          fail(new ApiError('bad_request', 'The upload is missing the file'));
          return;
        }
        if (truncated) {
          fail(new PayloadTooLargeError(maxBytes));
          return;
        }
        resolve({ fields, filename, mimeType, result });
      }, fail);
    });

    const body = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);
    body.on('error', fail);
    body.pipe(parser);
  });
}
