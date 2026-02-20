import type { ApiResponse, DateRange, RatioData, StockPriceData, Timeframe } from '../types/stock';

const BASE_URL = '/api/stocks';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const json: ApiResponse<T> = await res.json();
  if (!json.success || json.data === undefined) {
    throw new Error(json.error ?? 'Request failed');
  }
  return json.data;
}

export async function getHistory(symbol: string, timeframe: Timeframe): Promise<StockPriceData[]> {
  return fetchJson<StockPriceData[]>(`${BASE_URL}/${symbol}/history?timeframe=${timeframe}`);
}

export async function getLatest(symbol: string): Promise<StockPriceData> {
  return fetchJson<StockPriceData>(`${BASE_URL}/${symbol}/latest`);
}

export async function getRatio(
  base: string,
  compare: string,
  timeframe: Timeframe
): Promise<RatioData[]> {
  return fetchJson<RatioData[]>(
    `${BASE_URL}/ratio?base=${base}&compare=${compare}&timeframe=${timeframe}`
  );
}

export async function syncStock(symbol: string): Promise<unknown> {
  return fetchJson<unknown>(`${BASE_URL}/${symbol}/sync`, { method: 'POST' });
}

export async function getDateRange(symbol: string): Promise<DateRange | null> {
  try {
    return await fetchJson<DateRange>(`${BASE_URL}/${symbol}/date-range`);
  } catch {
    return null;
  }
}
