import { useEffect, useState } from 'react';

/**
 * Resolves Vantage CSS custom properties to concrete color strings for
 * use in places that can't consume CSS variables directly (e.g. Recharts
 * SVG stroke/fill props). Re-reads whenever the `data-theme` attribute on
 * <html> flips, so charts follow light/dark mode automatically.
 */
export function useThemeTokens<T extends Record<string, string>>(tokens: T): T {
  const read = (): T => {
    if (typeof window === 'undefined') return tokens;
    const styles = getComputedStyle(document.documentElement);
    const out = {} as T;
    for (const key in tokens) {
      const resolved = styles.getPropertyValue(tokens[key]).trim();
      out[key] = (resolved || tokens[key]) as T[typeof key];
    }
    return out;
  };

  const [resolved, setResolved] = useState<T>(read);

  useEffect(() => {
    setResolved(read());
    const observer = new MutationObserver(() => setResolved(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return resolved;
}
