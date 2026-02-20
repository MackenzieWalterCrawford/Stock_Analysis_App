import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { RatioData } from '../types/stock';
import styles from './RatioChart.module.css';

interface RatioChartProps {
  base: string;
  compare: string;
  ratioData: RatioData[];
  loading: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export function RatioChart({ base, compare, ratioData, loading }: RatioChartProps) {
  if (loading) {
    return <div className={styles.state}>Loading ratio chart...</div>;
  }

  if (ratioData.length === 0) {
    return <div className={styles.state}>No ratio data available.</div>;
  }

  const currentRatio = ratioData[ratioData.length - 1]?.ratio ?? 0;
  const startRatio = ratioData[0]?.ratio ?? 0;
  const percentChange = startRatio !== 0 ? ((currentRatio - startRatio) / startRatio) * 100 : 0;

  const chartData = ratioData.map((d) => ({
    date: d.date.split('T')[0],
    ratio: Number(d.ratio.toFixed(4)),
  }));

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          {base} / {compare} Ratio
        </h2>
        <div className={styles.stats}>
          <span className={styles.currentRatio}>
            Current: <strong>{currentRatio.toFixed(4)}</strong>
          </span>
          <span className={percentChange >= 0 ? styles.positive : styles.negative}>
            {percentChange >= 0 ? '+' : ''}
            {percentChange.toFixed(2)}%
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tickFormatter={formatDate} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={60} />
          <Tooltip
            formatter={(value: number) => [value.toFixed(4), 'Ratio']}
            labelFormatter={(label: string) => formatDate(label)}
          />
          <ReferenceLine y={startRatio} stroke="#ed8936" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="ratio"
            stroke="#805ad5"
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
