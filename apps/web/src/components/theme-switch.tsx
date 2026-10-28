import { Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { applyTheme, readTheme, type ThemeName } from '@/lib/theme';

let current = readTheme();
const listeners = new Set<(theme: ThemeName) => void>();

function useTheme() {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const listener = (next: ThemeName) => setTheme(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const toggle = useCallback(() => {
    const next: ThemeName = current === 'dark' ? 'light' : 'dark';
    current = next;
    applyTheme(next);
    for (const listener of listeners) listener(next);
  }, []);
  return { theme, toggle };
}

/** Shows the current appearance. Activating it switches to the other one. */
export function ThemeSwitch() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Switch to ${next}`}
      onClick={toggle}
    >
      {theme === 'dark' ? <Moon /> : <Sun />}
      {theme === 'dark' ? 'Dark' : 'Light'}
    </Button>
  );
}
