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
import type { FundamentalDataPoint, MetricKey, StockPriceData, Timeframe } from '../types/stock';
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
  timeframe: Timeframe;
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
  evEbitda: number | null;
  peg: number | null;
  roic: number | null;
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

      // Compute market cap from live price × current-quarter diluted share count
      const shares = fund?.dilutedShares ?? null;
      const marketCap = shares != null && shares > 0 ? p.close * shares : null;

      // P/FCF: live marketCap / TTM FCF; fall back to stored ratio if marketCap unavailable
      const priceToFcf =
        marketCap != null && fund?.fcf != null && fund.fcf > 0
          ? marketCap / fund.fcf
          : fund?.priceToFcf ?? null;

      // EV/EBITDA: (marketCap + totalDebt - cashAndEquivalents) / TTM EBITDA
      let evEbitda: number | null = null;
      if (
        marketCap != null &&
        fund?.ebitdaTtm != null &&
        fund.ebitdaTtm > 0 &&
        fund.totalDebt != null &&
        fund.cashAndEquivalents != null
      ) {
        evEbitda = (marketCap + fund.totalDebt - fund.cashAndEquivalents) / fund.ebitdaTtm;
      }

      // PEG: P/E divided by EPS growth rate (%). Growth ≤ 0 → null (meaningless)
      const pe =
        fund?.ttmEps != null && fund.ttmEps > 0 ? p.close / fund.ttmEps : null;
      const g =
        fund?.epsGrowthYoy != null ? fund.epsGrowthYoy * 100 : null; // fraction → percent
      const peg = pe != null && g != null && g > 0 ? pe / g : null;

      // ROIC: single multiply from decimal fraction to percent (0.18 → 18.0)
      const roic = fund?.roic != null ? fund.roic * 100 : null;

      return {
        date: dateKey,
        price: p.close,
        peRatio:
          fund?.ttmEps != null && fund.ttmEps > 0
            ? p.close / fund.ttmEps
            : fund?.peRatio ?? null,
        priceToFcf,
        fcf: fund?.fcf != null ? fund.fcf / 1e9 : null,
        eps: fund?.eps ?? null,
        revenueGrowthYoy: fund?.revenueGrowthYoy ?? null,
        roe: fund?.roe != null ? fund.roe * 100 : null,
        debtToEquity: fund?.debtToEquity ?? null,
        evEbitda,
        peg,
        roic,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

/**
 * Selects which x-axis dates get a tick, thinning them out on the longer
 * timeframes so the labels have room to breathe. Returns `undefined` for the
 * short views (`1W`/`1M`), which keep Recharts' default even spacing.
 * Picks are always real values from `data` so the categorical axis lines up.
 */
function computeXTicks(data: MergedRow[], timeframe: Timeframe): string[] | undefined {
  if (timeframe === '1W' || timeframe === '1M') return undefined;

  if (timeframe === '5Y') {
    // One tick per year — the first trading day seen in each calendar year.
    const ticks: string[] = [];
    let lastYear = '';
    for (const row of data) {
      const year = row.date.slice(0, 4);
      if (year !== lastYear) {
        ticks.push(row.date);
        lastYear = year;
      }
    }
    return ticks;
  }

  // YTD / 1Y — first trading day of each month, then keep every other one.
  const monthFirsts: string[] = [];
  let lastMonth = '';
  for (const row of data) {
    const month = row.date.slice(0, 7);
    if (month !== lastMonth) {
      monthFirsts.push(row.date);
      lastMonth = month;
    }
  }
  return monthFirsts.filter((_, i) => i % 2 === 0);
}

function formatXTick(dateStr: string, timeframe: Timeframe): string {
  if (timeframe === '5Y') return dateStr.slice(0, 4);
  return formatDate(dateStr);
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
  timeframe,
  loading,
}: AnalysisChartProps) {
  const c = useThemeTokens({
    grid: '--border-hairline',
    axis: '--text-body',
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
  const xTicks = computeXTicks(chartData, timeframe);
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
              tickFormatter={(v: string) => formatXTick(v, timeframe)}
              tick={{ fontSize: 11, fill: c.axis, fontFamily: 'IBM Plex Mono, monospace' }}
              ticks={xTicks}
              tickCount={xTicks ? undefined : 8}
              interval={xTicks ? 0 : 'preserveEnd'}
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
