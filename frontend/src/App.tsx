import { Layout } from './components/Layout';
import { StockSearch } from './components/StockSearch';
import { TimeframeSelector } from './components/TimeframeSelector';
import { PriceChart } from './components/PriceChart';
import { RatioChart } from './components/RatioChart';
import { DataTable } from './components/DataTable';
import { useStockData } from './hooks/useStockData';
import './App.css';

function App() {
  const { symbols, setSymbols, timeframe, setTimeframe, priceData, ratioData, loading, error } =
    useStockData();

  const primary = symbols[0];
  const secondary = symbols[1];

  return (
    <Layout>
      <StockSearch symbols={symbols} onSymbolsChange={setSymbols} />
      <TimeframeSelector value={timeframe} onChange={setTimeframe} />
      {error && <div className="error-banner">{error}</div>}
      {primary !== undefined && (
        <>
          <PriceChart symbols={symbols} priceData={priceData} loading={loading} />
          {secondary !== undefined && (
            <RatioChart
              base={primary}
              compare={secondary}
              ratioData={ratioData}
              loading={loading}
            />
          )}
          <DataTable
            symbol={primary}
            data={priceData.get(primary) ?? []}
            loading={loading}
          />
        </>
      )}
    </Layout>
  );
}

export default App;
