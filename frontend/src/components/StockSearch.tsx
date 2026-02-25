import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import styles from './StockSearch.module.css';

interface StockSearchProps {
  symbol: string;
  onSymbolChange: (s: string) => void;
}

export function StockSearch({ symbol, onSymbolChange }: StockSearchProps) {
  const [input, setInput] = useState('');

  function handleSearch() {
    const trimmed = input.trim().toUpperCase();
    if (trimmed) {
      onSymbolChange(trimmed);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSearch();
  }

  function handleClear() {
    onSymbolChange('');
    setInput('');
  }

  return (
    <div className={styles.container}>
      <div className={styles.inputs}>
        <div className={styles.inputGroup}>
          <label className={styles.label}>Symbol</label>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. AAPL"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            maxLength={10}
          />
        </div>
        <button className={styles.button} onClick={handleSearch}>
          Search
        </button>
      </div>
      {symbol && (
        <div className={styles.tags}>
          <span className={styles.tag}>
            {symbol}
            <button
              className={styles.tagRemove}
              onClick={handleClear}
              aria-label={`Remove ${symbol}`}
            >
              ×
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
