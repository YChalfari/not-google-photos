import { ApiClientError } from '@/lib/api';
import { nativeFetchParts } from '@/lib/native';

async function sha1Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface UploadResult {
  assetId: string;
  status: 'created' | 'duplicate';
}

/** Sends one photo or video. Fields go before the file, which is what the server streams. */
export async function uploadAsset(file: File): Promise<UploadResult> {
  const bytes = await file.arrayBuffer();
  const body = new FormData();
  body.append('checksum', await sha1Hex(bytes));
  body.append('filename', file.name);
  if (file.lastModified > 0) body.append('capturedAt', new Date(file.lastModified).toISOString());
  body.append('file', file, file.name);

  const headers = new Headers();
  const { url, credentials } = nativeFetchParts('/api/assets', headers);
  const response = await fetch(url, { method: 'POST', body, credentials, headers });
  const json = (await response.json().catch(() => undefined)) as
    | { assetId?: string | null; status?: string; error?: { code?: string; message?: string; details?: unknown } }
    | undefined;
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      json?.error?.code ?? 'internal_error',
      json?.error?.message ?? `Upload failed (${response.status})`,
      json?.error?.details,
    );
  }
  if (!json?.assetId || json.status === 'rejected') {
    throw new ApiClientError(response.status, 'rejected', 'This photo was already left out.');
  }
  return { assetId: json.assetId, status: json.status === 'duplicate' ? 'duplicate' : 'created' };
}
