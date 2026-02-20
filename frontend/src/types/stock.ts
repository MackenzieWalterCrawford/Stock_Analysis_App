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

export interface RatioData {
  date: string;
  ratio: number;
  symbol1Price: number;
  symbol2Price: number;
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
