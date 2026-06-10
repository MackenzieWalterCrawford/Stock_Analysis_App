import type { ReactNode } from 'react';
import styles from './Layout.module.css';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <span className={styles.titleMark} aria-hidden />
          <h1 className={styles.title}>
            Stock <span className={styles.titleAccent}>Analysis</span>
          </h1>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
