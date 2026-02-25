export type Timeframe = '5Y' | '1Y' | 'YTD' | '1M' | '1W';

export interface StockPriceData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string; // BigInt serialized as string from backend
  change: number;
  changePercent: number;
  vwap: number;
}

export interface DateRange {
  earliest: string;
  latest: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface FundamentalDataPoint {
  date: string;
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: number | null;
  eps: number | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
}

export type MetricKey =
  | 'peRatio'
  | 'priceToFcf'
  | 'fcf'
  | 'eps'
  | 'revenueGrowthYoy'
  | 'roe'
  | 'debtToEquity';

export interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
  formatValue: (v: number) => string;
}

export const METRICS: MetricConfig[] = [
  { key: 'peRatio',          label: 'P/E Ratio',        color: '#e53e3e', formatValue: (v) => v.toFixed(1) + 'x' },
  { key: 'priceToFcf',       label: 'P/FCF',            color: '#dd6b20', formatValue: (v) => v.toFixed(1) + 'x' },
  { key: 'fcf',              label: 'Free Cash Flow',   color: '#38a169', formatValue: (v) => '$' + (v / 1e9).toFixed(1) + 'B' },
  { key: 'eps',              label: 'EPS',              color: '#805ad5', formatValue: (v) => '$' + v.toFixed(2) },
  { key: 'revenueGrowthYoy', label: 'Revenue Growth',  color: '#3182ce', formatValue: (v) => v.toFixed(1) + '%' },
  { key: 'roe',              label: 'Return on Equity', color: '#00b5d8', formatValue: (v) => (v * 100).toFixed(1) + '%' },
  { key: 'debtToEquity',     label: 'Debt / Equity',    color: '#b7791f', formatValue: (v) => v.toFixed(2) + 'x' },
];
