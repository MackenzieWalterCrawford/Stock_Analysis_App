import { useState, useMemo } from 'react';
import type { StockPriceData } from '../types/stock';
import styles from './DataTable.module.css';

type SortKey = 'date' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'changePercent';
type SortDir = 'asc' | 'desc';

interface DataTableProps {
  symbol: string;
  data: StockPriceData[];
  loading: boolean;
}

const PAGE_SIZE = 50;

function formatDate(dateStr: string): string {
  return dateStr.split('T')[0];
}

function formatNumber(n: number): string {
  return n.toFixed(2);
}

function formatVolume(v: string): string {
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return v;
}

export function DataTable({ symbol, data, loading }: DataTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(0);
  }

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      let va: number | string;
      let vb: number | string;
      if (sortKey === 'date') {
        va = a.date;
        vb = b.date;
      } else if (sortKey === 'volume') {
        va = Number(a.volume);
        vb = Number(b.volume);
      } else {
        va = a[sortKey];
        vb = b[sortKey];
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'date', label: 'Date' },
    { key: 'open', label: 'Open' },
    { key: 'high', label: 'High' },
    { key: 'low', label: 'Low' },
    { key: 'close', label: 'Close' },
    { key: 'volume', label: 'Volume' },
    { key: 'changePercent', label: 'Change %' },
  ];

  if (loading) {
    return <div className={styles.state}>Loading table...</div>;
  }

  if (data.length === 0) {
    return <div className={styles.state}>No data available for {symbol}.</div>;
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>{symbol} — Price Data</h2>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map(({ key, label }) => (
                <th key={key} className={styles.th} onClick={() => handleSort(key)}>
                  {label}{' '}
                  <span className={styles.sortIcon}>
                    {key === sortKey ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.map((row, i) => {
              const isPositive = row.changePercent >= 0;
              return (
                <tr key={i} className={styles.row}>
                  <td className={styles.td}>{formatDate(row.date)}</td>
                  <td className={styles.td}>${formatNumber(row.open)}</td>
                  <td className={styles.td}>${formatNumber(row.high)}</td>
                  <td className={styles.td}>${formatNumber(row.low)}</td>
                  <td className={styles.td}>${formatNumber(row.close)}</td>
                  <td className={styles.td}>{formatVolume(row.volume)}</td>
                  <td
                    className={`${styles.td} ${isPositive ? styles.positive : styles.negative}`}
                  >
                    {isPositive ? '+' : ''}
                    {formatNumber(row.changePercent)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className={styles.pageInfo}>
            Page {page + 1} of {totalPages}
          </span>
          <button
            className={styles.pageBtn}
            disabled={page === totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
