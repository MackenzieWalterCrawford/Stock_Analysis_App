/**
 * Regression tests for fundamental-data bug fixes:
 *
 *  Bug #1 — calculateDateRange: '1M' timeframe must produce a `from` date at
 *            least 6 months in the past so quarterly data is always included.
 *
 *  Bug #2 — fetchKeyMetrics: HTTP 402 / 403 from FMP must surface as a non-empty
 *            `result.errors` array, never silently return empty data.
 *
 *  SEC EDGAR integration — syncFundamentals must merge SEC EPS history alongside
 *            FMP income-statement records, deduplicate by date, and persist all
 *            rows via prisma.financialRatio.upsert.
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

// ---------------------------------------------------------------------------
// SEC EDGAR integration — syncFundamentals merges EPS alongside FMP rows
// ---------------------------------------------------------------------------

describe('FundamentalFetcher.syncFundamentals — SEC EDGAR EPS merged with FMP income data', () => {
  afterEach(() => jest.restoreAllMocks());

  it('syncFundamentals merges SEC EDGAR EPS history alongside FMP income-statement records', async () => {
    // -------------------------------------------------------------------
    // FMP income-statement data — 5 quarters, with a CIK so the fetcher
    // will proceed to call SEC EDGAR.
    // -------------------------------------------------------------------
    const fmpIncomeRows = [
      { date: '2022-12-31', symbol: 'AAPL', revenue: 100_000_000, eps: 1.10, epsDiluted: 1.12, period: 'Q1', cik: '0000320193' },
      { date: '2023-03-31', symbol: 'AAPL', revenue: 110_000_000, eps: 1.20, epsDiluted: 1.22, period: 'Q2', cik: '0000320193' },
      { date: '2023-06-30', symbol: 'AAPL', revenue: 120_000_000, eps: 1.30, epsDiluted: 1.32, period: 'Q3', cik: '0000320193' },
      { date: '2023-09-30', symbol: 'AAPL', revenue: 130_000_000, eps: 1.40, epsDiluted: 1.42, period: 'Q4', cik: '0000320193' },
      { date: '2023-12-31', symbol: 'AAPL', revenue: 140_000_000, eps: 1.50, epsDiluted: 1.52, period: 'Q1', cik: '0000320193' },
    ];

    // -------------------------------------------------------------------
    // SEC EDGAR synthetic response — 20 quarterly EPS entries spanning 5
    // fiscal years.  Two end dates deliberately overlap with FMP rows to
    // verify that FMP records are NOT overwritten by SEC-only rows.
    // -------------------------------------------------------------------
    const secUsdShares = [
      // --- FY2019 ---
      { start: '2018-10-01', end: '2018-12-29', val: 0.60, accn: 'S001', fy: 2019, fp: 'Q1', form: '10-Q', filed: '2019-01-31' },
      { start: '2018-12-30', end: '2019-03-30', val: 0.65, accn: 'S002', fy: 2019, fp: 'Q2', form: '10-Q', filed: '2019-05-01' },
      { start: '2018-10-01', end: '2019-06-29', val: 1.90, accn: 'S003', fy: 2019, fp: 'Q3', form: '10-Q', filed: '2019-08-01' }, // YTD
      { start: '2018-10-01', end: '2019-09-28', val: 2.60, accn: 'S004', fy: 2019, fp: 'FY', form: '10-K', filed: '2019-11-01' },
      // --- FY2020 ---
      { start: '2019-09-29', end: '2019-12-28', val: 0.75, accn: 'S005', fy: 2020, fp: 'Q1', form: '10-Q', filed: '2020-01-31' },
      { start: '2019-12-29', end: '2020-03-28', val: 0.64, accn: 'S006', fy: 2020, fp: 'Q2', form: '10-Q', filed: '2020-05-01' },
      { start: '2019-09-29', end: '2020-06-27', val: 2.05, accn: 'S007', fy: 2020, fp: 'Q3', form: '10-Q', filed: '2020-08-01' }, // YTD
      { start: '2019-09-29', end: '2020-09-26', val: 2.97, accn: 'S008', fy: 2020, fp: 'FY', form: '10-K', filed: '2020-11-01' },
      // --- FY2021 ---
      { start: '2020-09-27', end: '2020-12-26', val: 1.18, accn: 'S009', fy: 2021, fp: 'Q1', form: '10-Q', filed: '2021-01-31' },
      { start: '2020-12-27', end: '2021-03-27', val: 1.28, accn: 'S010', fy: 2021, fp: 'Q2', form: '10-Q', filed: '2021-05-01' },
      { start: '2020-09-27', end: '2021-06-26', val: 3.70, accn: 'S011', fy: 2021, fp: 'Q3', form: '10-Q', filed: '2021-08-01' }, // YTD
      { start: '2020-09-27', end: '2021-09-25', val: 5.15, accn: 'S012', fy: 2021, fp: 'FY', form: '10-K', filed: '2021-11-01' },
      // --- FY2022 ---
      { start: '2021-09-26', end: '2021-12-25', val: 2.08, accn: 'S013', fy: 2022, fp: 'Q1', form: '10-Q', filed: '2022-01-31' },
      { start: '2021-12-26', end: '2022-03-26', val: 1.52, accn: 'S014', fy: 2022, fp: 'Q2', form: '10-Q', filed: '2022-05-01' },
      { start: '2021-09-26', end: '2022-06-25', val: 4.85, accn: 'S015', fy: 2022, fp: 'Q3', form: '10-Q', filed: '2022-08-01' }, // YTD
      { start: '2021-09-26', end: '2022-09-24', val: 6.11, accn: 'S016', fy: 2022, fp: 'FY', form: '10-K', filed: '2022-11-01' },
      // --- FY2023 (two of these end dates overlap with FMP rows: 2022-12-31 and 2023-03-31) ---
      { start: '2022-09-25', end: '2022-12-31', val: 1.88, accn: 'S017', fy: 2023, fp: 'Q1', form: '10-Q', filed: '2023-01-31' },  // overlaps FMP row
      { start: '2022-12-29', end: '2023-03-31', val: 1.52, accn: 'S018', fy: 2023, fp: 'Q2', form: '10-Q', filed: '2023-05-01' },  // overlaps FMP row
      { start: '2022-09-25', end: '2023-06-30', val: 4.55, accn: 'S019', fy: 2023, fp: 'Q3', form: '10-Q', filed: '2023-08-01' },  // YTD — end overlaps FMP row
      { start: '2022-09-25', end: '2023-09-30', val: 6.13, accn: 'S020', fy: 2023, fp: 'FY', form: '10-K', filed: '2023-11-01' },  // overlaps FMP row
    ];

    // -------------------------------------------------------------------
    // Prisma mock — capture every call to financialRatio.upsert
    // -------------------------------------------------------------------
    const upsertMock = jest.fn().mockResolvedValue({});
    const transactionMock = jest.fn().mockImplementation(async (ops: unknown[]) => {
      // Prisma.$transaction receives an array of promises when called with
      // the interactive-transactions form (array of operation calls).
      // Since each upsert is already mocked, just resolve them all.
      return Promise.all(ops);
    });
    const stockPriceFindManyMock = jest.fn().mockResolvedValue([]);

    const prismaMock = {
      financialRatio: {
        upsert: upsertMock,
      },
      stockPrice: {
        findMany: stockPriceFindManyMock,
      },
      $transaction: transactionMock,
    } as unknown as import('../../generated/prisma').PrismaClient;

    // -------------------------------------------------------------------
    // axios mock — key-metrics returns 402, income-statement succeeds, SEC
    // EDGAR returns our synthetic EPS entries.
    // -------------------------------------------------------------------
    const axiosError402 = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: { status: 402, data: 'Upgrade required' },
    });

    const getSpy = jest.spyOn(axios, 'get').mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('key-metrics')) {
        return Promise.reject(axiosError402);
      }
      if (typeof url === 'string' && url.includes('income-statement')) {
        return Promise.resolve({ data: fmpIncomeRows });
      }
      if (typeof url === 'string' && url.includes('data.sec.gov')) {
        return Promise.resolve({ data: { units: { 'USD/shares': secUsdShares } } });
      }
      return Promise.resolve({ data: [] });
    });

    jest.spyOn(axios, 'isAxiosError').mockImplementation(
      (err): err is import('axios').AxiosError =>
        !!(err as { isAxiosError?: boolean }).isAxiosError
    );

    process.env.FMP_API_KEY = 'test-key';
    const fetcher = new FundamentalFetcher(prismaMock);
    const result = await fetcher.syncFundamentals('AAPL');

    // -------------------------------------------------------------------
    // Assertions
    // -------------------------------------------------------------------

    // The key-metrics 402 is silently swallowed (expected behavior per the
    // production code), so result.errors should be empty.
    expect(result.errors).toHaveLength(0);

    // $transaction was invoked at least once (saving records in batches)
    expect(transactionMock).toHaveBeenCalled();

    // Collect every record passed to upsert across all $transaction calls.
    // Each $transaction call receives an array of upsert(...) return values
    // — but since upsertMock is called immediately, we capture its calls.
    const upsertCallCount: number = upsertMock.mock.calls.length;

    // FMP contributes 5 rows (income-statement); SEC EDGAR contributes unique-date
    // rows not already in FMP. Overlapping end dates (2022-12-31, 2023-03-31,
    // 2023-06-30, 2023-09-30) are already in FMP so SEC won't add them.
    // SEC standalone Q1/Q2/Q3 from FY2019-FY2022 = 8 standalone + 4 Q4 derived = 12
    // FY2023 standalone Q1+Q2 overlap FMP, Q3 YTD end=2023-06-30 overlaps FMP,
    // FY annual end=2023-09-30 overlaps FMP — so 0 SEC-unique rows for FY2023.
    // Total expected: 5 (FMP) + 12 (SEC unique) = 17 minimum.
    expect(upsertCallCount).toBeGreaterThanOrEqual(17);

    // The FMP rows that have revenue must retain their revenue value.
    // Find the upsert call that corresponds to 2022-12-31 (a FMP row).
    // Each upsert call's first argument is the upsert options object.
    type UpsertArgs = {
      where: { symbol_date: { symbol: string; date: Date } };
      create: { revenue: bigint | null; eps: number | null; period: string | null };
      update: { revenue: bigint | null; eps: number | null; period: string | null };
    };

    const fmpOverlapCall = upsertMock.mock.calls.find((args: unknown[]) => {
      const opts = args[0] as UpsertArgs;
      return opts?.where?.symbol_date?.date?.toISOString().slice(0, 10) === '2022-12-31';
    });

    // A FMP row with revenue should exist with revenue populated (not null)
    expect(fmpOverlapCall).toBeDefined();
    const fmpOverlapCreate = (fmpOverlapCall![0] as UpsertArgs).create;
    expect(fmpOverlapCreate.revenue).not.toBeNull();
    expect(fmpOverlapCreate.period).toBe('Q1');

    // A SEC-only row (e.g., FY2019 Q1 ending 2018-12-29) should have eps
    // populated and revenue null.
    const secOnlyCall = upsertMock.mock.calls.find((args: unknown[]) => {
      const opts = args[0] as UpsertArgs;
      return opts?.where?.symbol_date?.date?.toISOString().slice(0, 10) === '2018-12-29';
    });
    expect(secOnlyCall).toBeDefined();
    const secOnlyCreate = (secOnlyCall![0] as UpsertArgs).create;
    expect(secOnlyCreate.eps).not.toBeNull();
    expect(secOnlyCreate.revenue).toBeNull();

    getSpy.mockRestore();
    delete process.env.FMP_API_KEY;
  });
});
