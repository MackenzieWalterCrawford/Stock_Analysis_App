import { useEffect, useState } from 'react';

/**
 * Resolves Vantage CSS custom properties to concrete color strings for
 * use in places that can't consume CSS variables directly (e.g. Recharts
 * SVG stroke/fill props). Re-reads whenever the `data-theme` attribute on
 * <html> flips, so charts follow light/dark mode automatically.
 */
/**
 * Follows a `var(--foo, fallback)` chain to a concrete value. Some browsers
 * return the unsubstituted `var(...)` literal from getPropertyValue when a
 * semantic token aliases another custom property (e.g. `--text-strong:
 * var(--ink-900)`). Passing that literal to Recharts as an SVG stroke/fill
 * silently produces no color, so we resolve it ourselves.
 */
function resolveVar(styles: CSSStyleDeclaration, value: string, depth = 0): string {
  const v = value.trim();
  if (depth > 10) return v;
  const match = v.match(/^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/);
  if (!match) return v;
  const referenced = styles.getPropertyValue(match[1]).trim();
  if (referenced) return resolveVar(styles, referenced, depth + 1);
  if (match[2] != null) return resolveVar(styles, match[2], depth + 1);
  return v;
}

export function useThemeTokens<T extends Record<string, string>>(tokens: T): T {
  const read = (): T => {
    if (typeof window === 'undefined') return tokens;
    const styles = getComputedStyle(document.documentElement);
    const out = {} as T;
    for (const key in tokens) {
      const resolved = resolveVar(styles, styles.getPropertyValue(tokens[key]).trim());
      // Fall back to currentColor (the inherited text color) rather than the
      // raw token name, which would be an invalid SVG paint value.
      out[key] = (resolved || 'currentColor') as T[typeof key];
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
