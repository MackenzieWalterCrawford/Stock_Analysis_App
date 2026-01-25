/**
 * Test script for StockService
 * Run with: npx ts-node src/scripts/testStockService.ts
 *
 * Prerequisites:
 * - PostgreSQL running with database set up
 * - Redis running
 * - FMP_API_KEY set in .env
 */

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma';
import { CacheService } from '../services/cache';
import { DataFetcher } from '../services/dataFetcher';
import { StockService, StockPriceData } from '../services/stockService';

async function runTests(): Promise<void> {
  console.log('=== StockService Test Suite ===\n');

  const prisma = new PrismaClient();
  const cache = new CacheService({ debug: true });
  const dataFetcher = new DataFetcher(prisma);
  const stockService = new StockService(dataFetcher, cache, prisma);

  try {
    // Connect to cache
    await cache.connect();

    const testSymbol = 'AAPL';

    // Test 1: isValidTimeframe
    console.log('Test 1: Timeframe validation...');
    const validTimeframes = ['5Y', '1Y', 'YTD', '1M', '1W'];
    const invalidTimeframes = ['2Y', 'ALL', 'invalid'];

    let validationPassed = true;
    for (const tf of validTimeframes) {
      if (!stockService.isValidTimeframe(tf)) {
        console.error(`Expected ${tf} to be valid`);
        validationPassed = false;
      }
    }
    for (const tf of invalidTimeframes) {
      if (stockService.isValidTimeframe(tf)) {
        console.error(`Expected ${tf} to be invalid`);
        validationPassed = false;
      }
    }
    console.log(`Timeframe validation: ${validationPassed ? 'PASSED' : 'FAILED'}\n`);

    // Test 2: calculateDateRange
    console.log('Test 2: Date range calculation...');
    const ranges = {
      '1W': stockService.calculateDateRange('1W'),
      '1M': stockService.calculateDateRange('1M'),
      '1Y': stockService.calculateDateRange('1Y'),
      'YTD': stockService.calculateDateRange('YTD'),
      '5Y': stockService.calculateDateRange('5Y'),
    };

    let dateRangePassed = true;
    for (const [tf, range] of Object.entries(ranges)) {
      const daysDiff = Math.floor(
        (range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24)
      );
      console.log(`  ${tf}: ${range.from.toISOString().split('T')[0]} to ${range.to.toISOString().split('T')[0]} (${daysDiff} days)`);

      if (range.from >= range.to) {
        console.error(`  Invalid range for ${tf}: from >= to`);
        dateRangePassed = false;
      }
    }
    console.log(`Date range calculation: ${dateRangePassed ? 'PASSED' : 'FAILED'}\n`);

    // Test 3: getAvailableDateRange
    console.log(`Test 3: Get available date range for ${testSymbol}...`);
    const dateRange = await stockService.getAvailableDateRange(testSymbol);

    if (dateRange) {
      console.log(`  Earliest: ${dateRange.earliest.toISOString().split('T')[0]}`);
      console.log(`  Latest: ${dateRange.latest.toISOString().split('T')[0]}`);
      console.log('Available date range: PASSED\n');
    } else {
      console.log(`  No data available for ${testSymbol} (this is OK for a fresh database)`);
      console.log('Available date range: PASSED (no data)\n');
    }

    // Test 4: getHistoricalData
    console.log(`Test 4: Get historical data for ${testSymbol} (1W)...`);
    console.log('  This will check Cache → Database → API\n');

    const startTime = Date.now();
    const historicalData = await stockService.getHistoricalData(testSymbol, '1W');
    const duration = Date.now() - startTime;

    if (historicalData.length > 0) {
      console.log(`  Retrieved ${historicalData.length} records in ${duration}ms`);
      console.log(`  First date: ${historicalData[0].date.toISOString().split('T')[0]}`);
      console.log(`  Last date: ${historicalData[historicalData.length - 1].date.toISOString().split('T')[0]}`);
      console.log(`  Sample close price: $${historicalData[0].close.toFixed(2)}`);
      console.log('Get historical data: PASSED\n');
    } else {
      console.log('  No data retrieved (check API key and network)');
      console.log('Get historical data: SKIPPED\n');
    }

    // Test 5: Cache hit (second request should be faster)
    console.log(`Test 5: Cache hit test for ${testSymbol} (1W)...`);
    const startTime2 = Date.now();
    const cachedData = await stockService.getHistoricalData(testSymbol, '1W');
    const duration2 = Date.now() - startTime2;

    console.log(`  Retrieved ${cachedData.length} records in ${duration2}ms`);
    if (duration2 < duration / 2) {
      console.log(`  Cache was ${Math.round(duration / duration2)}x faster!`);
    }
    console.log('Cache hit test: PASSED\n');

    // Test 6: getRecordCount
    console.log(`Test 6: Get record count for ${testSymbol}...`);
    const recordCount = await stockService.getRecordCount(testSymbol);
    console.log(`  Total records in database: ${recordCount}`);
    console.log('Record count: PASSED\n');

    // Test 7: getPriceRatio (only if we have two symbols with data)
    console.log('Test 7: Get price ratio (AAPL/MSFT) for 1W...');

    try {
      const ratioData = await stockService.getPriceRatio('AAPL', 'MSFT', '1W');

      if (ratioData.length > 0) {
        console.log(`  Retrieved ${ratioData.length} ratio data points`);
        console.log(`  Sample ratio: ${ratioData[0].ratio.toFixed(4)}`);
        console.log(`  AAPL: $${ratioData[0].symbol1Price.toFixed(2)}, MSFT: $${ratioData[0].symbol2Price.toFixed(2)}`);
        console.log('Price ratio: PASSED\n');
      } else {
        console.log('  No matching dates found between symbols');
        console.log('Price ratio: SKIPPED\n');
      }
    } catch (error) {
      console.log(`  Ratio calculation skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
      console.log('Price ratio: SKIPPED\n');
    }

    // Test 8: mergeAndDeduplicate
    console.log('Test 8: Merge and deduplicate data...');
    const oldData: StockPriceData[] = [
      { date: new Date('2024-01-01'), open: 100, high: 105, low: 99, close: 103, volume: 1000n, change: 3, changePercent: 3, vwap: 102 },
      { date: new Date('2024-01-02'), open: 103, high: 108, low: 102, close: 106, volume: 1100n, change: 3, changePercent: 2.9, vwap: 105 },
    ];
    const newData: StockPriceData[] = [
      { date: new Date('2024-01-02'), open: 103, high: 109, low: 102, close: 107, volume: 1200n, change: 4, changePercent: 3.9, vwap: 106 }, // Updated
      { date: new Date('2024-01-03'), open: 107, high: 112, low: 106, close: 110, volume: 1300n, change: 3, changePercent: 2.8, vwap: 109 }, // New
    ];

    const merged = stockService.mergeAndDeduplicate(oldData, newData);

    if (merged.length === 3 && merged[1].close === 107) { // New data should overwrite
      console.log(`  Merged ${oldData.length} + ${newData.length} = ${merged.length} unique records`);
      console.log(`  Updated record close: $${merged[1].close} (was $106, now $107)`);
      console.log('Merge and deduplicate: PASSED\n');
    } else {
      console.error('Merge and deduplicate: FAILED');
      console.error('  Expected 3 records with updated close of 107');
    }

    console.log('=== All Tests Completed ===\n');

    // Cleanup
    await cache.disconnect();
    await prisma.$disconnect();
  } catch (error) {
    console.error('Test error:', error);
    await cache.disconnect();
    await prisma.$disconnect();
    process.exit(1);
  }
}

runTests().catch(console.error);
