import type { SignedMediaUrl } from '@ngp/shared';
import { eq } from 'drizzle-orm';
import { canViewAsset, filterVisibleAssetIds } from '../authz/access';
import { users } from '../db/schema';
import type { Handlers } from '../http/contract';
import { ApiError } from '../http/errors';
import { availableVariants, resolveMediaFile, sendMediaFile } from '../media/serve';

export const mediaHandlers: Handlers = {
  'media.sign': async ({ ctx, auth, body }) => {
    const visible = await filterVisibleAssetIds(
      ctx.db,
      auth.user.id,
      body.items.map((item) => item.assetId),
    );
    const variants = await availableVariants(ctx.db, [...visible]);
    const urls: SignedMediaUrl[] = [];
    for (const { assetId, variant } of body.items) {
      if (!visible.has(assetId) || !variants.get(assetId)?.has(variant)) continue;
      const signed = ctx.media.sign({ assetId, variant, userId: auth.user.id });
      urls.push({ assetId, variant, url: signed.url, expiresAt: signed.expiresAt.toISOString() });
    }
    return { urls };
  },

  'media.get': async ({ c, ctx, params, query }) => {
    const verdict = ctx.media.verify({
      assetId: params.assetId,
      variant: params.variant,
      userId: query.uid,
      exp: query.exp,
      sig: query.sig,
    });
    if (verdict === 'expired') {
      throw new ApiError('forbidden', 'This media link has expired. Reload to get a new one.');
    }
    if (verdict !== 'ok') throw new ApiError('forbidden', 'This media link is not valid');

    // Access is checked again on every request, so un-sharing or disabling takes effect at once.
    const [user] = await ctx.db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, query.uid));
    if (!user || user.disabledAt) throw new ApiError('forbidden', 'This media link is not valid');
    if (!(await canViewAsset(ctx.db, query.uid, params.assetId))) {
      throw new ApiError('not_found', 'Not found');
    }
    const media = await resolveMediaFile(ctx.db, params.assetId, params.variant);
    if (!media) throw new ApiError('not_found', 'This version of the photo is not ready yet');
    return sendMediaFile(c, ctx.files, media, { maxAgeSeconds: query.exp - Date.now() / 1000 });
  },
};
