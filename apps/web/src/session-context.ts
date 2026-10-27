import { createContext, useContext } from 'react';
import type { MeResponse, ServerInfo } from '@ngp/shared';

export interface SessionValue {
  info: ServerInfo | undefined;
  infoError: unknown;
  me: MeResponse | null | undefined;
  meError: unknown;
  ready: boolean;
  /** True when this WebView is the installed app and must use the device token. */
  deviceAuth: boolean;
  /** True when that token is stored and a server address is known. */
  paired: boolean;
  refresh: () => Promise<void>;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
