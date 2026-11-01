import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStatus } from '@/lib/status';
import { api } from '@/lib/api';

interface AssetPatch {
  ids: string[];
  isFavorite?: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
}

async function refreshLibrary(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: ['timeline'] });
  await queryClient.invalidateQueries({ queryKey: ['asset'] });
  await queryClient.invalidateQueries({ queryKey: ['albums'] });
  await queryClient.invalidateQueries({ queryKey: ['search'] });
}

/** Favorite, archive, or trash one photo or a selection, and say what happened. */
export function useAssetBatch() {
  const queryClient = useQueryClient();
  const announce = useStatus();
  return useMutation({
    mutationFn: (body: AssetPatch) => api('assets.update', { body }),
    onSuccess: (_result, body) => {
      const count = body.ids.length;
      if (body.isTrashed === true) {
        const message = count === 1 ? 'Moved to trash' : `Moved ${count} to trash`;
        if (count === 1) {
          announce(message, () => {
            void api('assets.update', { body: { ids: body.ids, isTrashed: false } }).then(() =>
              refreshLibrary(queryClient),
            );
          });
        } else {
          announce(message);
        }
      } else if (body.isTrashed === false) {
        announce(count === 1 ? 'Restored' : `Restored ${count}`);
      } else if (body.isFavorite === true) {
        announce(count === 1 ? 'Favorited' : `Favorited ${count}`);
      } else if (body.isFavorite === false) {
        announce(count === 1 ? 'Removed from favorites' : `Removed ${count} from favorites`);
      } else if (body.isArchived === true) {
        announce(count === 1 ? 'Archived' : `Archived ${count}`);
      } else if (body.isArchived === false) {
        announce(count === 1 ? 'Unarchived' : `Unarchived ${count}`);
      }
      void refreshLibrary(queryClient);
    },
  });
}
