import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { UserRef } from '../primitives';

export const userEndpoints = defineEndpoints({
  'users.directory': {
    method: 'GET',
    path: '/api/users',
    auth: 'user',
    tag: 'users',
    summary: 'Other active people on this server (for sharing pickers)',
    response: z.object({ users: z.array(UserRef) }),
    stability: 'stable',
  },
});
