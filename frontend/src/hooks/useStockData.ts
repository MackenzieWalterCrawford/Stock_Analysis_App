import { useState, useEffect, useCallback } from 'react';
import type { FundamentalDataPoint, StockPriceData, Timeframe } from '../types/stock';
import * as api from '../api/stockApi';

export function useStockData() {
  const [symbol, setSymbol] = useState<string>('');
  const [timeframe, setTimeframe] = useState<Timeframe>('1Y');
  const [priceData, setPriceData] = useState<StockPriceData[]>([]);
  const [fundamentals, setFundamentals] = useState<FundamentalDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!symbol) {
      setPriceData([]);
      setFundamentals([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [prices, funds] = await Promise.all([
        api.getHistory(symbol, timeframe),
        api.getFundamentals(symbol, timeframe).catch(() => [] as FundamentalDataPoint[]),
      ]);

      setPriceData(prices);
      setFundamentals(funds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    symbol,
    setSymbol,
    timeframe,
    setTimeframe,
    priceData,
    fundamentals,
    loading,
    error,
    refresh: fetchData,
  };
}
