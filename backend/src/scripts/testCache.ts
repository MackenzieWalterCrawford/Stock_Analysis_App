/**
 * Test script for CacheService
 * Run with: npx ts-node src/scripts/testCache.ts
 */

import 'dotenv/config';
import { CacheService } from '../services/cache';

interface TestStockData {
  symbol: string;
  price: number;
  timestamp: Date;
}

async function runTests(): Promise<void> {
  console.log('=== CacheService Test Suite ===\n');

  const cache = new CacheService({ debug: true });

  try {
    // Test 1: Connect to Redis
    console.log('Test 1: Connecting to Redis...');
    await cache.connect();

    if (!cache.isConnected()) {
      console.error('Failed to connect to Redis. Make sure Redis is running.');
      process.exit(1);
    }
    console.log('Connected successfully!\n');

    // Test 2: Basic set/get operations
    console.log('Test 2: Basic set/get operations...');
    const testData: TestStockData = {
      symbol: 'AAPL',
      price: 185.50,
      timestamp: new Date(),
    };

    await cache.set('test:basic', testData, 60);
    const retrieved = await cache.get<TestStockData>('test:basic');

    if (retrieved && retrieved.symbol === testData.symbol) {
      console.log('Basic set/get: PASSED\n');
    } else {
      console.error('Basic set/get: FAILED');
      console.error('Expected:', testData);
      console.error('Got:', retrieved);
    }

    // Test 3: Stock history caching
    console.log('Test 3: Stock history caching...');
    const historyData = [
      { date: '2024-01-01', close: 180.00 },
      { date: '2024-01-02', close: 182.50 },
      { date: '2024-01-03', close: 185.00 },
    ];

    await cache.setStockHistory('AAPL', '1Y', historyData);
    const cachedHistory = await cache.getStockHistory<typeof historyData>('AAPL', '1Y');

    if (cachedHistory && cachedHistory.length === 3) {
      console.log('Stock history caching: PASSED\n');
    } else {
      console.error('Stock history caching: FAILED');
    }

    // Test 4: Price ratio caching
    console.log('Test 4: Price ratio caching...');
    const ratioData = { ratio: 1.25, correlation: 0.85 };

    await cache.setPriceRatio('AAPL', 'MSFT', '1M', ratioData);
    const cachedRatio = await cache.getPriceRatio<typeof ratioData>('AAPL', 'MSFT', '1M');

    if (cachedRatio && cachedRatio.ratio === 1.25) {
      console.log('Price ratio caching: PASSED\n');
    } else {
      console.error('Price ratio caching: FAILED');
    }

    // Test 5: TTL for timeframes
    console.log('Test 5: TTL values for timeframes...');
    const ttlTests = [
      { timeframe: '5Y', expected: 86400 },
      { timeframe: '1Y', expected: 43200 },
      { timeframe: 'YTD', expected: 21600 },
      { timeframe: '1M', expected: 10800 },
      { timeframe: '1W', expected: 3600 },
    ];

    let ttlTestsPassed = true;
    for (const test of ttlTests) {
      const ttl = cache.getTTLForTimeframe(test.timeframe);
      if (ttl !== test.expected) {
        console.error(`TTL for ${test.timeframe}: Expected ${test.expected}, got ${ttl}`);
        ttlTestsPassed = false;
      }
    }

    if (ttlTestsPassed) {
      console.log('TTL values: PASSED\n');
    } else {
      console.error('TTL values: FAILED\n');
    }

    // Test 6: Delete operation
    console.log('Test 6: Delete operation...');
    await cache.set('test:delete', { data: 'to be deleted' });
    await cache.delete('test:delete');
    const deleted = await cache.get('test:delete');

    if (deleted === null) {
      console.log('Delete operation: PASSED\n');
    } else {
      console.error('Delete operation: FAILED');
    }

    // Test 7: Cache miss
    console.log('Test 7: Cache miss handling...');
    const nonExistent = await cache.get('test:nonexistent:key');

    if (nonExistent === null) {
      console.log('Cache miss handling: PASSED\n');
    } else {
      console.error('Cache miss handling: FAILED');
    }

    // Cleanup: Flush test data
    console.log('Cleaning up test data...');
    await cache.flush();
    console.log('Cleanup complete!\n');

    // Disconnect
    await cache.disconnect();

    console.log('=== All Tests Completed ===');
  } catch (error) {
    console.error('Test error:', error);
    await cache.disconnect();
    process.exit(1);
  }
}

runTests().catch(console.error);
