import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import styles from './StockSearch.module.css';

interface StockSearchProps {
  symbols: string[];
  onSymbolsChange: (symbols: string[]) => void;
}

export function StockSearch({ symbols, onSymbolsChange }: StockSearchProps) {
  const [primary, setPrimary] = useState('');
  const [compare, setCompare] = useState('');

  function handleSearch() {
    const newSymbols: string[] = [];
    if (primary.trim()) newSymbols.push(primary.trim().toUpperCase());
    if (compare.trim()) newSymbols.push(compare.trim().toUpperCase());
    if (newSymbols.length > 0) {
      onSymbolsChange(newSymbols);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSearch();
  }

  function removeSymbol(symbol: string) {
    const updated = symbols.filter((s) => s !== symbol);
    onSymbolsChange(updated);
    if (symbol === symbols[0]) setPrimary('');
    if (symbol === symbols[1]) setCompare('');
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
            value={primary}
            onChange={(e) => setPrimary(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            maxLength={10}
          />
        </div>
        <div className={styles.inputGroup}>
          <label className={styles.label}>Compare (optional)</label>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. MSFT"
            value={compare}
            onChange={(e) => setCompare(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            maxLength={10}
          />
        </div>
        <button className={styles.button} onClick={handleSearch}>
          Search
        </button>
      </div>
      {symbols.length > 0 && (
        <div className={styles.tags}>
          {symbols.map((symbol) => (
            <span key={symbol} className={styles.tag}>
              {symbol}
              <button
                className={styles.tagRemove}
                onClick={() => removeSymbol(symbol)}
                aria-label={`Remove ${symbol}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
