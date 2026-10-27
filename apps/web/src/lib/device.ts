import { ApiClientError, api } from '@/lib/api';
import { clearDeviceConnection } from '@/lib/native';

/** Revokes this phone on the server, then forgets the token stored on the device. */
export async function unpairThisPhone(): Promise<void> {
  try {
    await api('auth.logout');
  } catch (error) {
    if (!(error instanceof ApiClientError && error.status === 401)) throw error;
  }
  await clearDeviceConnection();
}
