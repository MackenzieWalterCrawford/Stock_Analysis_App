/**
 * Regression tests for two fundamental-data bug fixes:
 *
 *  Bug #1 — calculateDateRange: '1M' timeframe must produce a `from` date at
 *            least 6 months in the past so quarterly data is always included.
 *
 *  Bug #2 — fetchKeyMetrics: HTTP 402 / 403 from FMP must surface as a non-empty
 *            `result.errors` array, never silently return empty data.
 */

import axios from 'axios';
import { FundamentalService } from '../fundamentalService';
import { FundamentalFetcher } from '../fundamentalFetcher';
import { subMonths } from 'date-fns';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal Prisma mock. `findMany` resolves to [] by default. */
function makePrismaMock(findManyImpl?: jest.Mock) {
  return {
    financialRatio: {
      findMany: findManyImpl ?? jest.fn().mockResolvedValue([]),
    },
  } as unknown as import('../../generated/prisma').PrismaClient;
}

/** Build a minimal CacheService mock that always misses. */
function makeCacheMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../cache').CacheService;
}

// ---------------------------------------------------------------------------
// Bug #1 — '1M' date range must be at least 6 months in the past
// ---------------------------------------------------------------------------

describe('FundamentalService.getFundamentals — 1M timeframe date range (Bug #1)', () => {
  it('passes a `date.gte` that is at most 6 months ago when timeframe is "1M"', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = makePrismaMock(findMany);
    const cache = makeCacheMock();

    // Fetcher mock: syncFundamentals returns an empty success so the service
    // falls through to the second queryDatabase call without throwing.
    const fetcher = {
      syncFundamentals: jest.fn().mockResolvedValue({ errors: [], recordsFetched: 0, recordsSaved: 0 }),
    } as unknown as FundamentalFetcher;

    const service = new FundamentalService(fetcher, cache, prisma);
    await service.getFundamentals('AAPL', '1M');

    // findMany is called at least once; inspect the first call's where clause.
    expect(findMany).toHaveBeenCalled();
    const whereClause = findMany.mock.calls[0][0].where as { date: { gte: Date } };
    const passedFrom: Date = whereClause.date.gte;

    // The bug: before the fix `from` was only 30 days ago, missing quarterly data.
    // After the fix the floor is 6 months ago. Assert that `from` is no more
    // recent than 6 months ago (allow a 1-second tolerance for test execution time).
    const sixMonthsAgo = subMonths(new Date(), 6);
    expect(passedFrom.getTime()).toBeLessThanOrEqual(sixMonthsAgo.getTime() + 1000);
  });
});

// ---------------------------------------------------------------------------
// Bug #2 — HTTP 402 from key-metrics must appear in result.errors
// ---------------------------------------------------------------------------

describe('FundamentalFetcher.syncFundamentals — HTTP 402 must not be swallowed (Bug #2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('puts a PLAN_REQUIRED error in result.errors when key-metrics returns 402', async () => {
    // Build a 402 AxiosError the same way axios would produce it.
    const axiosError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: { status: 402, data: 'Upgrade required' },
    });

    // Spy on axios.get: key-metrics URL (v3) throws 402; income-statement succeeds.
    const getSpy = jest.spyOn(axios, 'get').mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/key-metrics/')) {
        return Promise.reject(axiosError);
      }
      // income-statement: return empty array so merged result is also empty.
      return Promise.resolve({ data: [] });
    });
    // Make axios.isAxiosError recognise our hand-crafted error.
    jest.spyOn(axios, 'isAxiosError').mockImplementation(
      (err): err is import('axios').AxiosError => !!(err as { isAxiosError?: boolean }).isAxiosError
    );

    process.env.FMP_API_KEY = 'test-key';
    const fetcher = new FundamentalFetcher(makePrismaMock());
    const result = await fetcher.syncFundamentals('AAPL');

    // The bug: before the fix a 402 on key-metrics would be caught and
    // silently swallowed, returning an empty result with no errors.
    // After the fix the error must be surfaced.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/PLAN_REQUIRED|paid|402/i);

    getSpy.mockRestore();
    delete process.env.FMP_API_KEY;
  });
});
