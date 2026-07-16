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
import SecEdgarFetcher from '../secEdgarFetcher';
import { subDays } from 'date-fns';

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
//
// NOTE: date filtering was deliberately moved OUT of the Prisma `where` clause
// (queryDatabase now fetches the symbol's full history so TTM EPS can see prior
// quarters) and INTO convertToDataPoints, which clamps the output window to a
// 6-month floor on short timeframes. So this regression is now asserted on the
// OUTPUT of getFundamentals, not on the Prisma query.
// ---------------------------------------------------------------------------

describe('FundamentalService.getFundamentals — 1M timeframe date range (Bug #1)', () => {
  /** Build a minimal financial_ratios row with a non-null peRatio (so the
   *  service does not treat the data as stale and trigger a re-sync). */
  function makeRow(date: Date, peRatio: number) {
    return {
      symbol: 'AAPL',
      date,
      peRatio,
      priceToFcf: null,
      fcf: null,
      eps: 1.5,
      revenue: null,
      revenueGrowthYoy: null,
      roe: null,
      debtToEquity: null,
      period: 'Q1',
    };
  }

  it('returns fundamentals reaching back ~6 months (not just 30 days) for "1M"', async () => {
    // Three quarterly rows: 20 days ago (inside a naive 30-day window),
    // ~5 months ago (inside the 6-month floor but OUTSIDE a 30-day window —
    // the row the original bug dropped), and ~7 months ago (outside the floor).
    const recent = subDays(new Date(), 20);
    const withinFloor = subDays(new Date(), 150);
    const beyondFloor = subDays(new Date(), 210);

    const findMany = jest.fn().mockResolvedValue([
      makeRow(beyondFloor, 25),
      makeRow(withinFloor, 28),
      makeRow(recent, 30),
    ]);
    const prisma = makePrismaMock(findMany);
    const cache = makeCacheMock();

    const fetcher = {
      syncFundamentals: jest.fn().mockResolvedValue({ errors: [], recordsFetched: 0, recordsSaved: 0 }),
    } as unknown as FundamentalFetcher;

    const service = new FundamentalService(fetcher, cache, prisma);
    const result = await service.getFundamentals('AAPL', '1M');

    const returnedDates = result.map((dp) => dp.date);
    const toKey = (d: Date) => d.toISOString().slice(0, 10);

    // The bug: a 30-day window would have dropped the ~5-month-old quarter.
    // After the fix the 6-month floor keeps it.
    expect(returnedDates).toContain(toKey(withinFloor));
    // The recent quarter is naturally inside the window.
    expect(returnedDates).toContain(toKey(recent));
    // The ~7-month-old quarter is beyond the 6-month floor and excluded.
    expect(returnedDates).not.toContain(toKey(beyondFloor));
  });
});

// ---------------------------------------------------------------------------
// Bug #2 — HTTP 402 from the paid key-metrics endpoint must be swallowed
//
// This is a documented architectural invariant (AGENTS.md / CLAUDE.md gotcha
// #2): "On HTTP 402/403 the fetcher silently returns []." The free-tier income,
// cash-flow and balance-sheet statements are sufficient to compute every ratio,
// so a 402 on the paid key-metrics endpoint must NOT fail the whole sync — it is
// logged as a warning and the sync continues. This test guards that the 402 is
// not surfaced as a hard error.
// ---------------------------------------------------------------------------

describe('FundamentalFetcher.syncFundamentals — HTTP 402 on key-metrics is swallowed (Bug #2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does NOT surface a key-metrics 402 in result.errors (sync continues on free-tier data)', async () => {
    // Build a 402 AxiosError the same way axios would produce it.
    const axiosError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: { status: 402, data: 'Upgrade required' },
    });

    // Spy on axios.get: only key-metrics throws 402; every other statement
    // endpoint returns an empty array so the merge produces no rows.
    const getSpy = jest.spyOn(axios, 'get').mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('key-metrics')) {
        return Promise.reject(axiosError);
      }
      return Promise.resolve({ data: [] });
    });
    // Make axios.isAxiosError recognise our hand-crafted error.
    jest.spyOn(axios, 'isAxiosError').mockImplementation(
      (err): err is import('axios').AxiosError => !!(err as { isAxiosError?: boolean }).isAxiosError
    );

    process.env.FMP_API_KEY = 'test-key';
    const fetcher = new FundamentalFetcher(makePrismaMock());
    const result = await fetcher.syncFundamentals('AAPL');

    // The 402 on the paid endpoint is swallowed: no hard error, sync completes.
    expect(result.errors).toHaveLength(0);

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
      create: { revenue: bigint | null; eps: number | null; period: string | null; totalEquity: bigint | null };
      update: { revenue: bigint | null; eps: number | null; period: string | null; totalEquity: bigint | null };
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

// ---------------------------------------------------------------------------
// Regression: SEC-row interleave must NOT corrupt TTM revenue-growth windows
//
// Bug: Before the reordering fix, syncFundamentals merged SEC-EDGAR EPS rows
// into the records array BEFORE calling calculateRevenueGrowthYoy and
// computeTtmAndRatios. SEC rows have null revenue/ebitda. When their dates
// fell between FMP quarterly dates they shifted the 4-/8-quarter rolling
// windows, causing revenue growth to be null (or wrong) for adjacent FMP quarters.
//
// Fix: calculateRevenueGrowthYoy and computeTtmAndRatios now run on the pure
// FMP quarterly series BEFORE SEC rows are merged in.
//
// This test must FAIL on the buggy ordering and PASS on the fixed ordering.
// ---------------------------------------------------------------------------

describe('FundamentalFetcher.syncFundamentals — SEC-interleave reordering regression', () => {
  afterEach(() => jest.restoreAllMocks());

  it('revenueGrowthYoy is non-null for recent FMP quarters even when SEC rows interleave (regression: SEC merge corrupted rolling windows)', async () => {
    // Arrange: 10 FMP quarters of income data, giving two full TTM windows
    // for revenue-growth computation (indices 8 and 9 should have non-null growth).
    // Revenue grows from 1_000_000 per quarter to 1_200_000 per quarter.
    const fmpIncomeRows = [
      // Older 4 quarters (prior TTM): revenue=1_000_000 each
      { date: '2021-03-31', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q1', cik: '0000012345' },
      { date: '2021-06-30', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q2', cik: '0000012345' },
      { date: '2021-09-30', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q3', cik: '0000012345' },
      { date: '2021-12-31', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q4', cik: '0000012345' },
      // Middle 4 quarters (prior TTM for index-8 calc): revenue=1_050_000
      { date: '2022-03-31', symbol: 'TEST', revenue: 1_050_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q1', cik: '0000012345' },
      { date: '2022-06-30', symbol: 'TEST', revenue: 1_050_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q2', cik: '0000012345' },
      { date: '2022-09-30', symbol: 'TEST', revenue: 1_050_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q3', cik: '0000012345' },
      { date: '2022-12-31', symbol: 'TEST', revenue: 1_050_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q4', cik: '0000012345' },
      // Recent 2 quarters (current TTM window): revenue=1_200_000
      { date: '2023-03-31', symbol: 'TEST', revenue: 1_200_000, eps: 1.2, epsdiluted: 1.2, operatingIncome: 120_000, depreciationAndAmortization: 12_000, ebitda: 132_000, incomeTaxExpense: 25_000, incomeBeforeTax: 120_000, netIncome: 95_000, weightedAverageShsOutDil: 1_000_000, period: 'Q1', cik: '0000012345' },
      { date: '2023-06-30', symbol: 'TEST', revenue: 1_200_000, eps: 1.2, epsdiluted: 1.2, operatingIncome: 120_000, depreciationAndAmortization: 12_000, ebitda: 132_000, incomeTaxExpense: 25_000, incomeBeforeTax: 120_000, netIncome: 95_000, weightedAverageShsOutDil: 1_000_000, period: 'Q2', cik: '0000012345' },
    ];

    // SEC EDGAR rows with dates that fall BETWEEN the FMP quarterly dates.
    // In the old (buggy) ordering these would be interleaved and shift the
    // rolling-window indices, making revenue growth null for 2022-12-31 and 2023-03-31.
    const secUsdShares = [
      // Dates that fall between FMP quarters — these are the disruptors
      { start: '2020-10-01', end: '2021-01-15', val: 0.95, accn: 'X001', fy: 2021, fp: 'Q1', form: '10-Q', filed: '2021-02-15' },
      { start: '2021-04-01', end: '2021-05-15', val: 0.98, accn: 'X002', fy: 2021, fp: 'Q2', form: '10-Q', filed: '2021-06-15' },
      { start: '2021-07-01', end: '2021-08-15', val: 1.01, accn: 'X003', fy: 2021, fp: 'Q3', form: '10-Q', filed: '2021-09-15' },
      { start: '2020-10-01', end: '2021-11-15', val: 3.94, accn: 'X004', fy: 2021, fp: 'FY', form: '10-K', filed: '2021-12-15' },
      { start: '2022-01-01', end: '2022-02-10', val: 0.99, accn: 'X005', fy: 2022, fp: 'Q1', form: '10-Q', filed: '2022-03-10' },
      { start: '2022-04-01', end: '2022-05-10', val: 1.02, accn: 'X006', fy: 2022, fp: 'Q2', form: '10-Q', filed: '2022-06-10' },
    ];

    // Prisma mock
    const upsertMock = jest.fn().mockResolvedValue({});
    const transactionMock = jest.fn().mockImplementation(async (ops: unknown[]) => Promise.all(ops));

    const prismaMock = {
      financialRatio: { upsert: upsertMock },
      stockPrice: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: transactionMock,
    } as unknown as import('../../generated/prisma').PrismaClient;

    // axios mock
    const getSpy = jest.spyOn(axios, 'get').mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('key-metrics')) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === 'string' && url.includes('income-statement')) {
        return Promise.resolve({ data: [...fmpIncomeRows].reverse() });
      }
      if (typeof url === 'string' && url.includes('cash-flow-statement')) {
        return Promise.resolve({
          data: fmpIncomeRows.map((r) => ({
            date: r.date, symbol: r.symbol,
            operatingCashFlow: 90_000, capitalExpenditure: -10_000, freeCashFlow: 80_000,
          })).reverse(),
        });
      }
      if (typeof url === 'string' && url.includes('balance-sheet-statement')) {
        return Promise.resolve({
          data: fmpIncomeRows.map((r) => ({
            date: r.date, symbol: r.symbol,
            totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
          })).reverse(),
        });
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
    await fetcher.syncFundamentals('TEST');

    type UpsertArgs = {
      where: { symbol_date: { symbol: string; date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };

    const upsertsByDate = new Map<string, Record<string, unknown>>();
    for (const call of upsertMock.mock.calls) {
      const opts = call[0] as UpsertArgs;
      const dateKey = opts.where.symbol_date.date.toISOString().slice(0, 10);
      upsertsByDate.set(dateKey, opts.create as Record<string, unknown>);
    }

    // The critical assertion: 2022-12-31 is at FMP index 7 (0-based), which is
    // the first index that satisfies index >= 7 for revenueGrowthYoy. Before the
    // fix, SEC rows interleaved between quarters would shift this to a higher
    // effective index, making revenueGrowthYoy null (null = window corrupted).
    const q4_2022 = upsertsByDate.get('2022-12-31');
    expect(q4_2022).toBeDefined();
    expect(q4_2022!.revenueGrowthYoy).not.toBeNull();

    // 2023-03-31 (FMP index 8) should also have non-null growth
    const q1_2023 = upsertsByDate.get('2023-03-31');
    expect(q1_2023).toBeDefined();
    expect(q1_2023!.revenueGrowthYoy).not.toBeNull();

    // Verify the growth value: 2022-12-31 TTM = 4×1_050_000 vs prior TTM = 4×1_000_000
    // = (4_200_000 - 4_000_000) / 4_000_000 × 100 = 5.0%
    expect(q4_2022!.revenueGrowthYoy as number).toBeCloseTo(5.0, 2);

    getSpy.mockRestore();
    delete process.env.FMP_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// totalEquity persisted into the upsert create payload (metrics overhaul)
// ---------------------------------------------------------------------------

describe('FundamentalFetcher.syncFundamentals — totalEquity in upsert payload', () => {
  afterEach(() => jest.restoreAllMocks());

  it('upsert create payload includes totalEquity derived from totalStockholdersEquity', async () => {
    // Arrange: 4 FMP quarters with known totalStockholdersEquity; no SEC rows (no CIK).
    const fmpIncomeRows = [
      { date: '2023-03-31', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q1' },
      { date: '2023-06-30', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q2' },
      { date: '2023-09-30', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q3' },
      { date: '2023-12-31', symbol: 'TEST', revenue: 1_000_000, eps: 1.0, epsdiluted: 1.0, operatingIncome: 100_000, depreciationAndAmortization: 10_000, ebitda: 110_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000, netIncome: 79_000, weightedAverageShsOutDil: 1_000_000, period: 'Q4' },
    ];

    const upsertMock = jest.fn().mockResolvedValue({});
    const prismaMock = {
      financialRatio: { upsert: upsertMock },
      stockPrice: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockImplementation(async (ops: unknown[]) => Promise.all(ops)),
    } as unknown as import('../../generated/prisma').PrismaClient;

    const getSpy = jest.spyOn(axios, 'get').mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('key-metrics')) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === 'string' && url.includes('income-statement')) {
        return Promise.resolve({ data: [...fmpIncomeRows].reverse() });
      }
      if (typeof url === 'string' && url.includes('cash-flow-statement')) {
        return Promise.resolve({
          data: fmpIncomeRows.map((r) => ({
            date: r.date, symbol: r.symbol,
            operatingCashFlow: 80_000, capitalExpenditure: -10_000, freeCashFlow: 70_000,
          })).reverse(),
        });
      }
      if (typeof url === 'string' && url.includes('balance-sheet-statement')) {
        return Promise.resolve({
          data: fmpIncomeRows.map((r) => ({
            date: r.date, symbol: r.symbol,
            totalDebt: 300_000,
            // Q4 has a distinct equity value to make the assertion unambiguous
            totalStockholdersEquity: r.date === '2023-12-31' ? 2_500_000 : 1_200_000,
            cashAndCashEquivalents: 150_000,
          })).reverse(),
        });
      }
      return Promise.resolve({ data: [] });
    });

    jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);

    process.env.FMP_API_KEY = 'test-key';
    const fetcher = new FundamentalFetcher(prismaMock);
    await fetcher.syncFundamentals('TEST');

    type UpsertArgs = {
      where: { symbol_date: { symbol: string; date: Date } };
      create: Record<string, unknown>;
    };

    // Find the Q4 upsert (date = 2023-12-31)
    const q4Call = upsertMock.mock.calls.find((args: unknown[]) => {
      const opts = args[0] as UpsertArgs;
      return opts?.where?.symbol_date?.date?.toISOString().slice(0, 10) === '2023-12-31';
    });
    expect(q4Call).toBeDefined();
    const create = (q4Call![0] as UpsertArgs).create;

    // totalEquity must be a BigInt with value 2_500_000 (from Q4's totalStockholdersEquity)
    expect(create.totalEquity).toBe(BigInt(2_500_000));

    getSpy.mockRestore();
    delete process.env.FMP_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// SEC EDGAR free-tier fallback: syncFundamentals fully populates TTM ratios
// from company-facts when ALL FMP statement endpoints return 402.
//
// Headline regression: this test MUST fail if the SEC fallback path
// (buildFromSecFinancials + fetchQuarterlyFinancials) is removed.
// ---------------------------------------------------------------------------

describe('FundamentalFetcher.syncFundamentals — SEC EDGAR free-tier fallback populates TTM ratios (regression)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('persists non-null ebitdaTtm, totalDebt, totalEquity, roic, and revenueGrowthYoy when all FMP statement endpoints return 402', async () => {
    // -----------------------------------------------------------------------
    // Arrange: synthetic SEC companyfacts for 8 consecutive calendar quarters
    // (CY2022 Q1-Q4 + CY2023 Q1-Q4). Each quarter has standalone data so
    // all 8 flow values derive directly. Revenue grows 10% YoY between the
    // two four-quarter groups. Capex is positive (SEC convention).
    // -----------------------------------------------------------------------

    // Helper to create a standalone 3-month flow entry
    function se(start: string, end: string, val: number, fy: number, fp: string, frame?: string) {
      return {
        start, end, val,
        accn: `A-${fp}-${fy}`,
        fy, fp,
        form: fp === 'FY' ? '10-K' : '10-Q',
        filed: `${end.slice(0, 7)}-28`,
        ...(frame ? { frame } : {}),
      };
    }

    // Helper to create an instant (balance-sheet) entry
    function inst(end: string, val: number, fy: number, fp: string) {
      return {
        end, val,
        accn: `I-${fp}-${fy}`,
        fy, fp,
        form: fp === 'FY' ? '10-K' : '10-Q',
        filed: `${end.slice(0, 7)}-28`,
      };
    }

    // 8 quarters of standalone revenue entries (CY2022: 4 × 1_000_000; CY2023: 4 × 1_100_000)
    const revenueEntries = [
      se('2022-01-01', '2022-03-31', 1_000_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 1_000_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 1_000_000, 2022, 'Q3', 'CY2022Q3'),
      // Q4 2022 via FY 10-K minus 9mo YTD
      se('2022-01-01', '2022-09-30', 3_000_000, 2022, 'Q3'),  // 9mo YTD
      se('2022-01-01', '2022-12-31', 4_000_000, 2022, 'FY'),  // FY → Q4 = 1_000_000
      se('2023-01-01', '2023-03-31', 1_100_000, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 1_100_000, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 1_100_000, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 3_300_000, 2023, 'Q3'),  // 9mo YTD
      se('2023-01-01', '2023-12-31', 4_400_000, 2023, 'FY'),  // FY → Q4 = 1_100_000
    ];

    // operatingIncome: 200_000 per quarter 2022, 220_000 per quarter 2023
    const opIncomeEntries = [
      se('2022-01-01', '2022-03-31', 200_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 200_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 200_000, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 600_000, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 800_000, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 220_000, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 220_000, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 220_000, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 660_000, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 880_000, 2023, 'FY'),
    ];

    // D&A: 50_000 per quarter 2022, 55_000 per quarter 2023
    const daEntries = [
      se('2022-01-01', '2022-03-31', 50_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 50_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 50_000, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 150_000, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 200_000, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 55_000, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 55_000, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 55_000, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 165_000, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 220_000, 2023, 'FY'),
    ];

    // Tax expense: 42_000 per quarter 2022, 46_200 per quarter 2023
    const taxEntries = [
      se('2022-01-01', '2022-03-31', 42_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 42_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 42_000, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 126_000, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 168_000, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 46_200, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 46_200, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 46_200, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 138_600, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 184_800, 2023, 'FY'),
    ];

    // Pre-tax income (same as operating income for simplicity)
    const preTaxEntries = opIncomeEntries.map((e) => ({ ...e }));

    // OCF: 300_000 per quarter 2022, 330_000 per quarter 2023
    const ocfEntries = [
      se('2022-01-01', '2022-03-31', 300_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 300_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 300_000, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 900_000, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 1_200_000, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 330_000, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 330_000, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 330_000, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 990_000, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 1_320_000, 2023, 'FY'),
    ];

    // Capex (positive outflow as filed by SEC): 30_000/quarter 2022, 33_000/quarter 2023
    const capexEntries = [
      se('2022-01-01', '2022-03-31', 30_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 30_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 30_000, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 90_000, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 120_000, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 33_000, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 33_000, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 33_000, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 99_000, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 132_000, 2023, 'FY'),
    ];

    // EPS diluted: standalone values per quarter
    const epsEntries = [
      se('2022-01-01', '2022-03-31', 0.50, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 0.50, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 0.50, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 1.50, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 2.00, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 0.55, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 0.55, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 0.55, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 1.65, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 2.20, 2023, 'FY'),
    ];

    // Diluted shares
    const sharesEntries = [
      se('2022-01-01', '2022-03-31', 10_000_000, 2022, 'Q1', 'CY2022Q1'),
      se('2022-04-01', '2022-06-30', 10_000_000, 2022, 'Q2', 'CY2022Q2'),
      se('2022-07-01', '2022-09-30', 10_000_000, 2022, 'Q3', 'CY2022Q3'),
      se('2022-01-01', '2022-09-30', 30_000_000, 2022, 'Q3'),
      se('2022-01-01', '2022-12-31', 40_000_000, 2022, 'FY'),
      se('2023-01-01', '2023-03-31', 10_000_000, 2023, 'Q1', 'CY2023Q1'),
      se('2023-04-01', '2023-06-30', 10_000_000, 2023, 'Q2', 'CY2023Q2'),
      se('2023-07-01', '2023-09-30', 10_000_000, 2023, 'Q3', 'CY2023Q3'),
      se('2023-01-01', '2023-09-30', 30_000_000, 2023, 'Q3'),
      se('2023-01-01', '2023-12-31', 40_000_000, 2023, 'FY'),
    ];

    // Balance-sheet instant values
    const equityEntries = [
      inst('2022-03-31', 5_000_000, 2022, 'Q1'),
      inst('2022-06-30', 5_100_000, 2022, 'Q2'),
      inst('2022-09-30', 5_200_000, 2022, 'Q3'),
      inst('2022-12-31', 5_300_000, 2022, 'FY'),
      inst('2023-03-31', 5_400_000, 2023, 'Q1'),
      inst('2023-06-30', 5_500_000, 2023, 'Q2'),
      inst('2023-09-30', 5_600_000, 2023, 'Q3'),
      inst('2023-12-31', 5_700_000, 2023, 'FY'),
    ];
    const cashEntries = equityEntries.map((e) => ({ ...e, val: 800_000 }));
    const debtCurrentEntries = equityEntries.map((e) => ({ ...e, val: 200_000 }));
    const longTermDebtEntries = equityEntries.map((e) => ({ ...e, val: 800_000 }));

    const secCompanyFacts = {
      facts: {
        'us-gaap': {
          RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: revenueEntries } },
          OperatingIncomeLoss: { units: { USD: opIncomeEntries } },
          DepreciationDepletionAndAmortization: { units: { USD: daEntries } },
          IncomeTaxExpenseBenefit: { units: { USD: taxEntries } },
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest': { units: { USD: preTaxEntries } },
          NetCashProvidedByUsedInOperatingActivities: { units: { USD: ocfEntries } },
          PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: capexEntries } },
          EarningsPerShareDiluted: { units: { 'USD/shares': epsEntries } },
          WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: sharesEntries } },
          StockholdersEquity: { units: { USD: equityEntries } },
          CashAndCashEquivalentsAtCarryingValue: { units: { USD: cashEntries } },
          DebtCurrent: { units: { USD: debtCurrentEntries } },
          LongTermDebt: { units: { USD: longTermDebtEntries } },
        },
      },
    };

    // -----------------------------------------------------------------------
    // Prisma mock — capture upsert calls
    // -----------------------------------------------------------------------
    const upsertMock = jest.fn().mockResolvedValue({});
    const transactionMock = jest.fn().mockImplementation(async (ops: unknown[]) => Promise.all(ops));

    const prismaMock = {
      financialRatio: { upsert: upsertMock },
      stockPrice: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: transactionMock,
    } as unknown as import('../../generated/prisma').PrismaClient;

    // -----------------------------------------------------------------------
    // axios mock:
    //   - FMP key-metrics / income / cashflow / balance: all 402
    //   - SEC company_tickers: AAPL → 320193
    //   - SEC companyfacts: our synthetic fixture
    //   - SEC EarningsPerShareDiluted: empty (keep test focused)
    // -----------------------------------------------------------------------
    const axiosError402 = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: { status: 402, data: 'Upgrade required' },
    });

    // Spy on resolveCik directly so the module-level cikMapCache (which may
    // have been poisoned by earlier tests in this file that returned an empty
    // array for the company_tickers URL) doesn't cause cik to be null.
    jest.spyOn(SecEdgarFetcher.prototype, 'resolveCik').mockResolvedValue('0000320193');

    const getSpy = jest.spyOn(axios, 'get').mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('key-metrics') || u.includes('income-statement') ||
          u.includes('cash-flow-statement') || u.includes('balance-sheet-statement')) {
        return Promise.reject(axiosError402);
      }
      if (u.includes('companyfacts')) {
        return Promise.resolve({ data: secCompanyFacts });
      }
      if (u.includes('EarningsPerShareDiluted')) {
        return Promise.resolve({ data: { units: {} } });
      }
      return Promise.resolve({ data: [] });
    });

    jest.spyOn(axios, 'isAxiosError').mockImplementation(
      (err): err is import('axios').AxiosError =>
        !!(err as { isAxiosError?: boolean }).isAxiosError
    );

    // -----------------------------------------------------------------------
    // Act
    // -----------------------------------------------------------------------
    process.env.FMP_API_KEY = 'test-key';
    const fetcher = new FundamentalFetcher(prismaMock);
    const result = await fetcher.syncFundamentals('AAPL');

    // -----------------------------------------------------------------------
    // Assert: sync completed without errors
    // -----------------------------------------------------------------------
    expect(result.errors).toHaveLength(0);
    expect(upsertMock).toHaveBeenCalled();

    // Collect upsert create payloads keyed by date
    type UpsertArgs = {
      where: { symbol_date: { symbol: string; date: Date } };
      create: Record<string, unknown>;
    };

    const upsertsByDate = new Map<string, Record<string, unknown>>();
    for (const call of upsertMock.mock.calls) {
      const opts = call[0] as UpsertArgs;
      const dateKey = opts.where.symbol_date.date.toISOString().slice(0, 10);
      upsertsByDate.set(dateKey, opts.create as Record<string, unknown>);
    }

    // The 8th quarter (2023-12-31, array index 7) should have all TTM ratio
    // fields populated. This is the headline regression assertion: if the
    // SEC fallback (buildFromSecFinancials) is removed, these will all be null.
    const q4_2023 = upsertsByDate.get('2023-12-31');
    expect(q4_2023).toBeDefined();

    // ebitdaTtm: TTM 2023 = (operatingIncome + D&A) × 4 = (220k + 55k) × 4 = 1_100_000
    expect(q4_2023!.ebitdaTtm).not.toBeNull();
    expect(q4_2023!.ebitdaTtm).toBe(BigInt(1_100_000));

    // totalDebt: tier1 = DebtCurrent(200k) + LongTermDebt(800k) = 1_000_000
    expect(q4_2023!.totalDebt).not.toBeNull();
    expect(q4_2023!.totalDebt).toBe(BigInt(1_000_000));

    // totalEquity: stockholdersEquity at 2023-12-31 = 5_700_000
    expect(q4_2023!.totalEquity).not.toBeNull();
    expect(q4_2023!.totalEquity).toBe(BigInt(5_700_000));

    // roic: non-null because investedCapital = 1_000_000 + 5_700_000 - 800_000 = 5_900_000 > 0
    expect(q4_2023!.roic).not.toBeNull();
    expect(typeof q4_2023!.roic).toBe('number');

    // revenueGrowthYoy: TTM 2023 (4_400_000) vs TTM 2022 (4_000_000) = +10%
    expect(q4_2023!.revenueGrowthYoy).not.toBeNull();
    expect(q4_2023!.revenueGrowthYoy as number).toBeCloseTo(10.0, 1);

    getSpy.mockRestore();
    delete process.env.FMP_API_KEY;
  });
});
