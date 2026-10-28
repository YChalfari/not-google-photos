import { createContext, useContext } from 'react';

export const StatusContext = createContext<(message: string, undo?: () => void) => void>(
  () => undefined,
);

export function useStatus() {
  return useContext(StatusContext);
}
