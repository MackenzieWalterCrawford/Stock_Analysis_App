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
import { useThemeTokens } from '../hooks/useThemeTokens';
import { LineChartIcon } from './icons';
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
  const sortedFunds = [...fundamentals].sort((a, b) => a.date.localeCompare(b.date));

  return priceData
    .map((p) => {
      const dateKey = p.date.split('T')[0];

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
        fcf: fund?.fcf != null ? fund.fcf / 1e9 : null,
        eps: fund?.eps ?? null,
        revenueGrowthYoy: fund?.revenueGrowthYoy ?? null,
        roe: fund?.roe != null ? fund.roe * 100 : null,
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
  const c = useThemeTokens({
    grid: '--border-hairline',
    axis: '--text-muted',
    axisLine: '--border-strong',
    price: '--text-strong',
    surface: '--surface-card',
    border: '--border-hairline',
    strong: '--text-strong',
    body: '--text-body',
  });

  if (loading) {
    return (
      <div className={styles.card}>
        <div className={styles.state}>Loading chart…</div>
      </div>
    );
  }

  if (!symbol) {
    return (
      <div className={styles.card}>
        <div className={styles.state}>
          <LineChartIcon size={28} className={styles.stateIcon} />
          Enter a symbol to view price data.
        </div>
      </div>
    );
  }

  if (priceData.length === 0) {
    return (
      <div className={styles.card}>
        <div className={styles.state}>
          <LineChartIcon size={28} className={styles.stateIcon} />
          No data available for {symbol}.
        </div>
      </div>
    );
  }

  const chartData = mergeData(priceData, fundamentals);
  const activeMetricConfigs = METRICS.filter((m) => activeMetrics.has(m.key));
  const showRightAxis = activeMetricConfigs.length > 0;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Price History</h2>
          <p className={styles.subtitle}>{symbol}</p>
        </div>
      </div>

      <div className={styles.metricsRow}>
        <span className={styles.metricsLabel}>Overlay</span>
        <div className={styles.metricsList}>
          {METRICS.map((metric) => {
            const active = activeMetrics.has(metric.key);
            return (
              <button
                key={metric.key}
                type="button"
                className={`${styles.metricPill} ${active ? styles.metricPillActive : ''}`}
                onClick={() => onToggleMetric(metric.key)}
                style={
                  active
                    ? {
                        borderColor: metric.color,
                        background: `${metric.color}1a`,
                        color: metric.color,
                      }
                    : undefined
                }
              >
                <span className={styles.metricDot} style={{ background: metric.color }} />
                {metric.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.chartArea}>
        <ResponsiveContainer width="100%" height={460}>
          <ComposedChart
            data={chartData}
            margin={{ top: 5, right: showRightAxis ? 70 : 20, left: 10, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fontSize: 11, fill: c.axis, fontFamily: 'IBM Plex Mono, monospace' }}
              tickCount={8}
              stroke={c.axisLine}
            />
            <YAxis
              yAxisId="price"
              orientation="left"
              tickFormatter={(v: number) => formatPrice(v)}
              tick={{ fontSize: 11, fill: c.axis, fontFamily: 'IBM Plex Mono, monospace' }}
              width={70}
              stroke={c.axisLine}
            />
            {showRightAxis && (
              <YAxis
                yAxisId="metric"
                orientation="right"
                tick={{ fontSize: 11, fill: c.axis, fontFamily: 'IBM Plex Mono, monospace' }}
                width={60}
                stroke={c.axisLine}
              />
            )}
            <Tooltip
              contentStyle={{
                background: c.surface,
                border: `1px solid ${c.border}`,
                borderRadius: '14px',
                boxShadow: '0 14px 38px rgba(22, 20, 15, 0.10), 0 5px 12px rgba(22, 20, 15, 0.05)',
                fontSize: '0.8rem',
                fontFamily: 'IBM Plex Mono, monospace',
                color: c.strong,
              }}
              labelStyle={{ color: c.body, fontFamily: 'Hanken Grotesk, sans-serif' }}
              itemStyle={{ color: c.strong }}
              formatter={(value, name) => {
                const numValue = typeof value === 'number' ? value : Number(value);
                const strName = String(name);
                if (strName === symbol) return [formatPrice(numValue), 'Price'];
                const metricCfg = METRICS.find((m) => m.key === strName);
                if (metricCfg && Number.isFinite(numValue)) {
                  return [metricCfg.formatValue(numValue), metricCfg.label];
                }
                return [numValue, strName];
              }}
              labelFormatter={(label) => (typeof label === 'string' ? formatDate(label) : String(label))}
            />
            <Legend
              wrapperStyle={{ fontSize: '0.8rem', paddingTop: '0.5rem' }}
              formatter={(value: string) => {
                if (value === symbol) return 'Price';
                const metricCfg = METRICS.find((m) => m.key === value);
                return metricCfg?.label ?? value;
              }}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="price"
              name={symbol}
              stroke={c.price}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
            {activeMetricConfigs.map((metric) => (
              <Line
                key={metric.key}
                yAxisId="metric"
                type="linear"
                dataKey={metric.key}
                name={metric.key}
                stroke={metric.color}
                dot={false}
                strokeWidth={1.75}
                strokeDasharray="5 3"
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
