import { z } from 'zod';
import { BONJOUR_SERVICE_TYPE } from './constants';
import { Id } from './primitives';

/**
 * TXT record of the Bonjour service the Mac announces, e.g.
 * `dns-sd -R "Not Google Photos" _ngp._tcp local 4810 id=<serverId> name=<name> v=1 api=/api`.
 * Phones browse for {@link BONJOUR_SERVICE_TYPE}, match `id` against the paired server, and use the
 * resolved IP and port as the new home address.
 */
export const BonjourTxtRecord = z.object({
  id: Id,
  name: z.string(),
  v: z.coerce.number().int().positive(),
  api: z.string().default('/api'),
});
export type BonjourTxtRecord = z.output<typeof BonjourTxtRecord>;

export { BONJOUR_SERVICE_TYPE };
