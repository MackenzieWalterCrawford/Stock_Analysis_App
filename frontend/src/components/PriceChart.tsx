import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { StockPriceData } from '../types/stock';
import styles from './PriceChart.module.css';

const COLORS = ['#4299e1', '#ed8936'];

interface PriceChartProps {
  symbols: string[];
  priceData: Map<string, StockPriceData[]>;
  loading: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function PriceChart({ symbols, priceData, loading }: PriceChartProps) {
  if (loading) {
    return <div className={styles.state}>Loading chart...</div>;
  }

  if (symbols.length === 0) {
    return <div className={styles.state}>Enter a symbol to view price data.</div>;
  }

  const primaryData = priceData.get(symbols[0]) ?? [];
  if (primaryData.length === 0) {
    return <div className={styles.state}>No data available for {symbols[0]}.</div>;
  }

  // Merge all symbols by date for the chart
  const dateMap = new Map<string, Record<string, number | string>>();
  for (const symbol of symbols) {
    const data = priceData.get(symbol) ?? [];
    for (const point of data) {
      const dateKey = point.date.split('T')[0];
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { date: dateKey });
      }
      dateMap.get(dateKey)![symbol] = point.close;
    }
  }

  const chartData = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Price History — {symbols.join(' vs ')}</h2>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tickFormatter={formatDate} tick={{ fontSize: 11 }} tickCount={8} />
          <YAxis
            tickFormatter={(v: number) => formatPrice(v)}
            tick={{ fontSize: 11 }}
            width={70}
          />
          <Tooltip
            formatter={(value: number, name: string) => [formatPrice(value), name]}
            labelFormatter={(label: string) => formatDate(label)}
          />
          <Legend />
          {symbols.map((symbol, i) => (
            <Line
              key={symbol}
              type="monotone"
              dataKey={symbol}
              stroke={COLORS[i % COLORS.length]}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
