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
  ttmEps: number | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
  ebitdaTtm: number | null;
  dilutedShares: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;
  totalEquity: number | null;
  epsGrowthYoy: number | null;
  roic: number | null;
}

export type MetricKey =
  | 'peRatio'
  | 'eps'
  | 'revenueGrowthYoy'
  | 'evEbitda'
  | 'peg'
  | 'roic'
  | 'fcfYield'
  | 'priceToBook'
  | 'debtToEbitda';

export interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
  formatValue: (v: number) => string;
}

// Colors come from the Vantage categorical chart series (NOT market
// green/red, which are reserved strictly for price up/down).
export const METRICS: MetricConfig[] = [
  { key: 'peRatio',          label: 'P/E Ratio',       color: '#9264DC', formatValue: (v) => v.toFixed(1) + 'x' },
  { key: 'eps',              label: 'EPS (TTM)',        color: '#4A6B8A', formatValue: (v) => '$' + v.toFixed(2) },
  { key: 'revenueGrowthYoy', label: 'Revenue Growth',  color: '#C9A227', formatValue: (v) => v.toFixed(1) + '%' },
  { key: 'evEbitda',         label: 'EV/EBITDA',       color: '#3A7DCF', formatValue: (v) => v.toFixed(1) + 'x' },
  { key: 'peg',              label: 'PEG Ratio',        color: '#B5446E', formatValue: (v) => v.toFixed(2) },
  // ROIC: stored as decimal fraction (0.18 = 18%). mergeData multiplies by 100 once;
  // formatValue appends % with no second multiply. Net: 0.18 → 18.0%.
  { key: 'roic',             label: 'ROIC',             color: '#2E9E5B', formatValue: (v) => v.toFixed(1) + '%' },
  { key: 'fcfYield',         label: 'FCF Yield',        color: '#2F8E8E', formatValue: (v) => v.toFixed(1) + '%' },
  { key: 'priceToBook',      label: 'P/B Ratio',        color: '#CF7A3A', formatValue: (v) => v.toFixed(2) + 'x' },
  { key: 'debtToEbitda',     label: 'Debt/EBITDA',      color: '#565044', formatValue: (v) => v.toFixed(2) + 'x' },
];
