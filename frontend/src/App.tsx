import { useState } from 'react';
import { Layout } from './components/Layout';
import { StockSearch } from './components/StockSearch';
import { TimeframeSelector } from './components/TimeframeSelector';
import { AnalysisChart } from './components/AnalysisChart';
import { DataTable } from './components/DataTable';
import { useStockData } from './hooks/useStockData';
import type { MetricKey } from './types/stock';
import './App.css';

function App() {
  const { symbol, setSymbol, timeframe, setTimeframe, priceData, fundamentals, loading, error } =
    useStockData();

  const [activeMetrics, setActiveMetrics] = useState<Set<MetricKey>>(new Set());

  function toggleMetric(key: MetricKey) {
    setActiveMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <Layout>
      <StockSearch symbol={symbol} onSymbolChange={setSymbol} />
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {error && <div className="error-banner">{error}</div>}
      {symbol && (
        <>
          <AnalysisChart
            symbol={symbol}
            priceData={priceData}
            fundamentals={fundamentals}
            activeMetrics={activeMetrics}
            onToggleMetric={toggleMetric}
            loading={loading}
          />
          <DataTable symbol={symbol} data={priceData} loading={loading} />
        </>
      )}
    </Layout>
  );
}

export default App;
