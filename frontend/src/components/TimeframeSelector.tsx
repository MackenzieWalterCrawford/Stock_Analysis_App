import type { Timeframe } from '../types/stock';
import styles from './TimeframeSelector.module.css';

const TIMEFRAMES: Timeframe[] = ['1W', '1M', 'YTD', '1Y', '5Y'];

interface TimeframeSelectorProps {
  value: Timeframe;
  onChange: (timeframe: Timeframe) => void;
}

export function TimeframeSelector({ value, onChange }: TimeframeSelectorProps) {
  return (
    <div className={styles.container}>
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          className={`${styles.button} ${value === tf ? styles.active : ''}`}
          onClick={() => onChange(tf)}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
