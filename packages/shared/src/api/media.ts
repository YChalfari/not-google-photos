import { z } from 'zod';
import { MAX_SIGN_BATCH } from '../constants';
import { defineEndpoints } from '../contract/define';
import { Id, IsoDateTime, MediaVariant } from '../primitives';

export const SignedMediaUrl = z
  .object({
    assetId: Id,
    variant: MediaVariant,
    /** Path relative to the server, e.g. `/api/media/<id>/thumbnail?exp=…&uid=…&sig=…`. */
    url: z.string(),
    expiresAt: IsoDateTime,
  })
  .meta({ id: 'SignedMediaUrl' });
export type SignedMediaUrl = z.infer<typeof SignedMediaUrl>;

export const SignMediaRequest = z.object({
  items: z
    .array(z.object({ assetId: Id, variant: MediaVariant }))
    .min(1)
    .max(MAX_SIGN_BATCH),
});

export const MediaParams = z.object({ assetId: Id, variant: MediaVariant });

export const SignedMediaQuery = z.object({
  exp: z.coerce.number().int().positive(),
  uid: Id,
  sig: z.string().min(16).max(128),
});

export const mediaEndpoints = defineEndpoints({
  'media.sign': {
    method: 'POST',
    path: '/api/media/sign',
    auth: 'user',
    tag: 'media',
    summary: 'Signed, short-lived URLs for assets you can see',
    description:
      'Items you cannot see, or variants that do not exist yet, are left out of the response. ' +
      'Other endpoints embed signed URLs directly (for example `thumbnailUrl` on assets).',
    body: SignMediaRequest,
    response: z.object({ urls: z.array(SignedMediaUrl) }),
    stability: 'stable',
  },
  'media.get': {
    method: 'GET',
    path: '/api/media/:assetId/:variant',
    auth: 'signed',
    tag: 'media',
    summary: 'Media bytes for a signed URL (supports Range and ETag)',
    description:
      'Works in `<img>` and `<video>` tags without cookies or tokens, so it loads in browsers and in the phone app. ' +
      'Access is re-checked on every request, so un-sharing takes effect immediately.',
    params: MediaParams,
    query: SignedMediaQuery,
    responseKind: 'binary',
    errors: ['forbidden', 'not_found'],
    stability: 'stable',
  },
});
