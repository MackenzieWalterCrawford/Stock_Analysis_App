import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { FundamentalDataPoint, MetricKey, StockPriceData } from '../types/stock';
import { METRICS } from '../types/stock';
import styles from './AnalysisChart.module.css';

interface AnalysisChartProps {
  symbol: string;
  priceData: StockPriceData[];
  fundamentals: FundamentalDataPoint[];
  activeMetrics: Set<MetricKey>;
  onToggleMetric: (key: MetricKey) => void;
  loading: boolean;
}

interface MergedRow {
  date: string;
  price: number;
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: number | null;
  eps: number | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
}

function mergeData(
  priceData: StockPriceData[],
  fundamentals: FundamentalDataPoint[]
): MergedRow[] {
  // Sort fundamentals ascending
  const sortedFunds = [...fundamentals].sort((a, b) => a.date.localeCompare(b.date));

  return priceData
    .map((p) => {
      const dateKey = p.date.split('T')[0];

      // Forward-fill: find the latest fundamental on or before this price date
      let fund: FundamentalDataPoint | null = null;
      for (const f of sortedFunds) {
        if (f.date <= dateKey) {
          fund = f;
        } else {
          break;
        }
      }

      return {
        date: dateKey,
        price: p.close,
        peRatio: fund?.peRatio ?? null,
        priceToFcf: fund?.priceToFcf ?? null,
        fcf: fund?.fcf != null ? fund.fcf / 1e9 : null, // convert to billions
        eps: fund?.eps ?? null,
        revenueGrowthYoy: fund?.revenueGrowthYoy ?? null,
        roe: fund?.roe != null ? fund.roe * 100 : null, // convert to percentage
        debtToEquity: fund?.debtToEquity ?? null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function formatPrice(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function AnalysisChart({
  symbol,
  priceData,
  fundamentals,
  activeMetrics,
  onToggleMetric,
  loading,
}: AnalysisChartProps) {
  if (loading) {
    return <div className={styles.state}>Loading chart...</div>;
  }

  if (!symbol) {
    return <div className={styles.state}>Enter a symbol to view price data.</div>;
  }

  if (priceData.length === 0) {
    return <div className={styles.state}>No data available for {symbol}.</div>;
  }

  const chartData = mergeData(priceData, fundamentals);
  const activeMetricConfigs = METRICS.filter((m) => activeMetrics.has(m.key));
  const showRightAxis = activeMetricConfigs.length > 0;

  return (
    <div className={styles.wrapper}>
      <div className={styles.chartArea}>
        <h2 className={styles.title}>Price History — {symbol}</h2>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={chartData} margin={{ top: 5, right: showRightAxis ? 70 : 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fontSize: 11 }}
              tickCount={8}
            />
            {/* Left axis: price */}
            <YAxis
              yAxisId="price"
              orientation="left"
              tickFormatter={(v: number) => formatPrice(v)}
              tick={{ fontSize: 11 }}
              width={70}
            />
            {/* Right axis: metric values — only shown when a metric is active */}
            {showRightAxis && (
              <YAxis
                yAxisId="metric"
                orientation="right"
                tick={{ fontSize: 11 }}
                width={60}
              />
            )}
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === symbol) return [formatPrice(value), 'Price'];
                const metricCfg = METRICS.find((m) => m.key === name);
                if (metricCfg && value != null) {
                  return [metricCfg.formatValue(value), metricCfg.label];
                }
                return [value, name];
              }}
              labelFormatter={(label: string) => formatDate(label)}
            />
            <Legend
              formatter={(value: string) => {
                if (value === symbol) return 'Price';
                const metricCfg = METRICS.find((m) => m.key === value);
                return metricCfg?.label ?? value;
              }}
            />
            {/* Price line */}
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="price"
              name={symbol}
              stroke="#4299e1"
              dot={false}
              strokeWidth={2}
              connectNulls
            />
            {/* Active metric overlay lines */}
            {activeMetricConfigs.map((metric) => (
              <Line
                key={metric.key}
                yAxisId="metric"
                type="linear"
                dataKey={metric.key}
                name={metric.key}
                stroke={metric.color}
                dot={false}
                strokeWidth={1.5}
                strokeDasharray="5 3"
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Sidebar */}
      <div className={styles.sidebar}>
        <h3 className={styles.sidebarTitle}>Overlay Metrics</h3>
        <div className={styles.metricList}>
          {METRICS.map((metric) => (
            <label key={metric.key} className={styles.metricLabel}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={activeMetrics.has(metric.key)}
                onChange={() => onToggleMetric(metric.key)}
              />
              <span
                className={styles.colorDot}
                style={{ background: metric.color }}
              />
              <span className={styles.metricName}>{metric.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
