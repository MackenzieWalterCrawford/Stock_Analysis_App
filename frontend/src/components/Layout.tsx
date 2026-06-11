import type { ReactNode } from 'react';
import { useTheme } from '../hooks/useTheme';
import { MoonIcon, SunIcon } from './icons';
import styles from './Layout.module.css';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { theme, toggle } = useTheme();

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden />
            <span className={styles.brandName}>Vantage</span>
          </div>
          <button
            type="button"
            className={styles.themeToggle}
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <span className={styles.eyebrow}>Vantage Markets</span>
          <h1 className={styles.heroTitle}>
            <span className={styles.heroLead}>Know your</span> position.
          </h1>
          <p className={styles.heroSub}>
            Search any ticker to chart its price history and overlay the fundamentals
            that actually move it — earnings, cash flow, returns, and leverage.
          </p>
        </section>

        {children}
      </main>
    </div>
  );
}
