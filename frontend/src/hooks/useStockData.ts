import { useState, useEffect, useCallback } from 'react';
import type { RatioData, StockPriceData, Timeframe } from '../types/stock';
import * as api from '../api/stockApi';

export function useStockData() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>('1M');
  const [priceData, setPriceData] = useState<Map<string, StockPriceData[]>>(new Map());
  const [ratioData, setRatioData] = useState<RatioData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (symbols.length === 0) {
      setPriceData(new Map());
      setRatioData([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const newPriceData = new Map<string, StockPriceData[]>();

      await Promise.all(
        symbols.map(async (symbol) => {
          const data = await api.getHistory(symbol, timeframe);
          newPriceData.set(symbol, data);
        })
      );

      setPriceData(newPriceData);

      if (symbols.length >= 2) {
        const ratio = await api.getRatio(symbols[0], symbols[1], timeframe);
        setRatioData(ratio);
      } else {
        setRatioData([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [symbols, timeframe]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    symbols,
    setSymbols,
    timeframe,
    setTimeframe,
    priceData,
    ratioData,
    loading,
    error,
    refresh: fetchData,
  };
}
