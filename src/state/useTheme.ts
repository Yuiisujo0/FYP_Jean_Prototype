import { useCallback, useEffect, useState } from 'react';
import type { Density, ThemePreference } from '../types';
import { KEYS, readString, writeString } from '../lib/storage';

const isTheme = (v: string): v is ThemePreference => v === 'light' || v === 'dark' || v === 'system';

export function useAppearance() {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    const saved = readString(KEYS.theme, 'system');
    return isTheme(saved) ? saved : 'system';
  });
  const [density, setDensityState] = useState<Density>(() => (readString(KEYS.density, 'comfortable') === 'compact' ? 'compact' : 'comfortable'));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setTheme = useCallback((value: ThemePreference) => {
    setThemeState(value);
    writeString(KEYS.theme, value);
  }, []);

  const setDensity = useCallback((value: Density) => {
    setDensityState(value);
    writeString(KEYS.density, value);
  }, []);

  /** Flip between light and dark based on what is currently showing. */
  const toggleTheme = useCallback(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return { theme, setTheme, density, setDensity, toggleTheme };
}
