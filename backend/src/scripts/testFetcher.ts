import 'dotenv/config';
import { DataFetcher } from '../services/dataFetcher';

async function main() {
  const fetcher = new DataFetcher();

  try {
    console.log('=== Testing DataFetcher with AAPL ===\n');

    // Check last stored date
    const lastDate = await fetcher.getLastStoredDate('AAPL');
    console.log(`Last stored date: ${lastDate ? lastDate.toISOString().split('T')[0] : 'None'}\n`);

    // Sync stock data (last 30 days to avoid huge data pull)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    console.log(`Syncing AAPL data from ${thirtyDaysAgo.toISOString().split('T')[0]}...\n`);

    const result = await fetcher.syncStock('AAPL', thirtyDaysAgo);

    console.log('\n=== Sync Results ===');
    console.log(`Symbol: ${result.symbol}`);
    console.log(`Records fetched: ${result.recordsFetched}`);
    console.log(`Records saved: ${result.recordsSaved}`);
    if (result.dateRange.from && result.dateRange.to) {
      console.log(`Date range: ${result.dateRange.from.toISOString().split('T')[0]} to ${result.dateRange.to.toISOString().split('T')[0]}`);
    }
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.join(', ')}`);
    }

    // Get total stored count
    const totalCount = await fetcher.getStoredCount('AAPL');
    console.log(`\nTotal AAPL records in database: ${totalCount}`);

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await fetcher.disconnect();
  }
}

main();
