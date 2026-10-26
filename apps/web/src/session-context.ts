import { createContext, useContext } from 'react';
import type { MeResponse, ServerInfo } from '@ngp/shared';

export interface SessionValue {
  info: ServerInfo | undefined;
  infoError: unknown;
  me: MeResponse | null | undefined;
  meError: unknown;
  ready: boolean;
  refresh: () => Promise<void>;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
