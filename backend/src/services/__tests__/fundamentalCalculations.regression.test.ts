/**
 * Regression tests for the financial-ratio calculations introduced in the
 * fundamentalFetcher overhaul.
 *
 * ALL calculation methods are private on FundamentalFetcher. We reach them
 * through the public syncFundamentals() path, fully mocking axios and Prisma
 * so no network or database is touched.
 *
 * Test coverage targets (in priority order):
 *  1. TTM FCF: sum of 4 quarters' FMP freeCashFlow (capex already negative in FMP)
 *  2. TTM EBITDA: ebitda field first; falls back to operatingIncome + D&A per quarter
 *  3. ROIC: NOPAT / InvestedCapital; tax-rate clamp [0, 0.5]; default 0.21 fallback
 *  4. debtToEquity: null when equity ≤ 0
 *  5. revenueGrowthYoy: TTM vs prior TTM expressed as PERCENT
 *  6. epsGrowthYoy: TTM vs prior TTM expressed as decimal FRACTION; null when prior ≤ 0
 *  7. Insufficient quarters → null for TTM-derived metrics (index < 3 rule)
 *  8. ROIC null when investedCapital ≤ 0
 */

import axios from 'axios';
import { FundamentalFetcher } from '../fundamentalFetcher';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/** Minimal Prisma mock that provides stockPrice.findMany and financialRatio. */
function makePrisma() {
  return {
    stockPrice: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    financialRatio: {
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockImplementation(async (ops: unknown[]) => Promise.all(ops)),
  } as unknown as import('../../generated/prisma').PrismaClient;
}

/**
 * Build one quarter's worth of data for the three FMP statement types.
 * All monetary values are in raw dollars (FMP's scale).
 *
 * capitalExpenditure: FMP provides this as a negative number.
 * freeCashFlow in FMP: operatingCashFlow + capitalExpenditure (capex is already negative).
 */
function makeQuarter(
  date: string,
  opts: {
    revenue?: number;
    eps?: number;
    epsdiluted?: number;
    operatingIncome?: number;
    da?: number;       // depreciationAndAmortization
    ebitda?: number | null;
    incomeTaxExpense?: number;
    incomeBeforeTax?: number;
    netIncome?: number;
    weightedAverageShsOutDil?: number;
    operatingCashFlow?: number;
    capitalExpenditure?: number; // must be negative as FMP sends it
    freeCashFlow?: number;       // if omitted, computed as operatingCashFlow + capitalExpenditure
    totalDebt?: number;
    totalStockholdersEquity?: number;
    cashAndCashEquivalents?: number;
  }
) {
  const ocf = opts.operatingCashFlow ?? 0;
  const capex = opts.capitalExpenditure ?? 0;   // expected to be <= 0
  const fcf = opts.freeCashFlow ?? ocf + capex;

  const income = {
    date,
    symbol: 'TEST',
    revenue: opts.revenue ?? 1_000_000,
    eps: opts.eps ?? 1.0,
    epsdiluted: opts.epsdiluted ?? opts.eps ?? 1.0,
    operatingIncome: opts.operatingIncome ?? 100_000,
    depreciationAndAmortization: opts.da ?? 10_000,
    ebitda: opts.ebitda !== undefined ? opts.ebitda : (opts.operatingIncome ?? 100_000) + (opts.da ?? 10_000),
    incomeTaxExpense: opts.incomeTaxExpense ?? 21_000,
    incomeBeforeTax: opts.incomeBeforeTax ?? 100_000,
    netIncome: opts.netIncome ?? 79_000,
    weightedAverageShsOutDil: opts.weightedAverageShsOutDil ?? 1_000_000,
    period: 'Q1',
    cik: undefined,
  };

  const cashFlow = {
    date,
    symbol: 'TEST',
    operatingCashFlow: ocf,
    capitalExpenditure: capex,
    freeCashFlow: fcf,
  };

  const balance = {
    date,
    symbol: 'TEST',
    totalDebt: opts.totalDebt ?? 500_000,
    totalStockholdersEquity: opts.totalStockholdersEquity ?? 1_000_000,
    cashAndCashEquivalents: opts.cashAndCashEquivalents ?? 200_000,
  };

  return { income, cashFlow, balance };
}

/**
 * Build a multi-quarter FMP payload: 4 consecutive quarters (or more).
 * Returns arrays ready to be served from the mocked axios.get calls.
 */
function buildFmpPayload(quarters: ReturnType<typeof makeQuarter>[]) {
  // FMP returns most-recent first
  const reversed = [...quarters].reverse();
  return {
    income: reversed.map((q) => q.income),
    cashFlow: reversed.map((q) => q.cashFlow),
    balance: reversed.map((q) => q.balance),
  };
}

/**
 * Configure axios.get to return the given FMP payloads for each endpoint.
 * key-metrics returns [] (paid-tier not available in tests).
 */
function mockAxios(payload: ReturnType<typeof buildFmpPayload>) {
  jest.spyOn(axios, 'get').mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('key-metrics')) {
      return Promise.resolve({ data: [] });
    }
    if (typeof url === 'string' && url.includes('income-statement')) {
      return Promise.resolve({ data: payload.income });
    }
    if (typeof url === 'string' && url.includes('cash-flow-statement')) {
      return Promise.resolve({ data: payload.cashFlow });
    }
    if (typeof url === 'string' && url.includes('balance-sheet-statement')) {
      return Promise.resolve({ data: payload.balance });
    }
    return Promise.resolve({ data: [] });
  });
}

/**
 * Run syncFundamentals and collect all records passed to financialRatio.upsert.
 * Returns them sorted ascending by date.
 */
async function syncAndCollect(
  prisma: ReturnType<typeof makePrisma>,
  symbol = 'TEST'
) {
  process.env.FMP_API_KEY = 'test-key';
  const fetcher = new FundamentalFetcher(prisma);
  await fetcher.syncFundamentals(symbol);
  delete process.env.FMP_API_KEY;

  type UpsertArgs = {
    where: { symbol_date: { symbol: string; date: Date } };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  };

  const records = (prisma.financialRatio.upsert as jest.Mock).mock.calls.map(
    (args: unknown[]) => (args[0] as UpsertArgs).create
  );

  // Sort by date ascending so index-based assertions are deterministic
  records.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
    const da = (a.date as Date).getTime();
    const db = (b.date as Date).getTime();
    return da - db;
  });

  return records as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FMP_API_KEY;
});

// ===========================================================================
// 1. TTM FCF: sum of 4 quarters' freeCashFlow (capex already negative in FMP)
// ===========================================================================

describe('TTM FCF calculation', () => {
  it('sums 4 quarters freeCashFlow where capex is negative (FMP convention)', async () => {
    // Arrange: 4 quarters, each with OCF=100k and capex=-20k → FCF=80k per quarter
    // TTM FCF should be 4 × 80,000 = 320,000
    const quarters = [
      makeQuarter('2023-03-31', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-06-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-09-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-12-31', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
    ];

    // Act
    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    // Assert: index 3 (4th quarter, 0-based) should have TTM FCF
    const lastRecord = records[3];
    expect(lastRecord).toBeDefined();
    expect(lastRecord.fcf).toBe(BigInt(320_000));
  });

  it('does not double-negate capex: subtracts once via FMP freeCashFlow field', async () => {
    // Arrange: OCF=200k, capex=-50k → FMP freeCashFlow=150k per quarter
    // If capex were double-negated the result would be 200k+50k=250k per quarter instead.
    const quarters = [
      makeQuarter('2023-03-31', { operatingCashFlow: 200_000, capitalExpenditure: -50_000 }),
      makeQuarter('2023-06-30', { operatingCashFlow: 200_000, capitalExpenditure: -50_000 }),
      makeQuarter('2023-09-30', { operatingCashFlow: 200_000, capitalExpenditure: -50_000 }),
      makeQuarter('2023-12-31', { operatingCashFlow: 200_000, capitalExpenditure: -50_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.fcf).toBe(BigInt(600_000)); // 150k × 4
    expect(lastRecord.fcf).not.toBe(BigInt(1_000_000)); // double-negated wrong answer: 250k × 4
  });

  it('returns no TTM-derived ebitdaTtm when fewer than 4 quarters are present', async () => {
    // Arrange: only 3 quarters — computeTtmAndRatios skips records at index < 3 entirely,
    // so ebitdaTtm (which is null in mergeFundamentals and only filled by computeTtmAndRatios)
    // remains null for all 3 records.
    // NOTE: fcf at early indices carries the per-quarter value from mergeFundamentals, NOT null.
    const quarters = [
      makeQuarter('2023-06-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-09-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-12-31', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    // With only 3 quarters, index never reaches 3, so no TTM window is ever computed.
    for (const r of records) {
      expect(r.ebitdaTtm).toBeNull(); // strictly TTM-derived; stays null
      expect(r.roic).toBeNull();       // strictly TTM-derived; stays null
      expect(r.debtToEquity).toBeNull(); // overridden only at index >= 3
    }
  });

  it('returns null fcf when any quarter in the window has null freeCashFlow', async () => {
    // Arrange: 4 quarters but Q1 has no cash flow data (null operatingCashFlow)
    const q1 = makeQuarter('2023-03-31', {});
    q1.cashFlow.operatingCashFlow = 0;
    q1.cashFlow.capitalExpenditure = 0;
    q1.cashFlow.freeCashFlow = 0; // this is non-null so TTM CAN compute

    const quarters = [
      q1,
      makeQuarter('2023-06-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-09-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-12-31', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
    ];

    // Now make Q1's cash flow entirely missing (null fields)
    quarters[0].cashFlow.freeCashFlow = null as unknown as number;

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.fcf).toBeNull();
  });
});

// ===========================================================================
// 2. TTM EBITDA: ebitda field first; D&A fallback when ebitda is null
// ===========================================================================

describe('TTM EBITDA calculation', () => {
  it('uses the ebitda field directly when all 4 quarters have it', async () => {
    // Arrange: each quarter has ebitda=300k (operatingIncome+DA would be 110k, different)
    const quarters = [
      makeQuarter('2023-03-31', { ebitda: 300_000, operatingIncome: 80_000, da: 30_000 }),
      makeQuarter('2023-06-30', { ebitda: 300_000, operatingIncome: 80_000, da: 30_000 }),
      makeQuarter('2023-09-30', { ebitda: 300_000, operatingIncome: 80_000, da: 30_000 }),
      makeQuarter('2023-12-31', { ebitda: 300_000, operatingIncome: 80_000, da: 30_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.ebitdaTtm).toBe(BigInt(1_200_000)); // 300k × 4
  });

  it('falls back to operatingIncome + D&A when a quarter ebitda is null', async () => {
    // Arrange: Q1 ebitda is null; others have ebitda.
    // Q1 fallback: operatingIncome=100k + da=20k = 120k
    // Q2-Q4: ebitda=200k each
    // TTM = 120k + 200k + 200k + 200k = 720k
    const quarters = [
      makeQuarter('2023-03-31', { ebitda: null, operatingIncome: 100_000, da: 20_000 }),
      makeQuarter('2023-06-30', { ebitda: 200_000, operatingIncome: 150_000, da: 50_000 }),
      makeQuarter('2023-09-30', { ebitda: 200_000, operatingIncome: 150_000, da: 50_000 }),
      makeQuarter('2023-12-31', { ebitda: 200_000, operatingIncome: 150_000, da: 50_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.ebitdaTtm).toBe(BigInt(720_000));
  });

  it('returns null ebitdaTtm when a quarter has null ebitda AND null operatingIncome', async () => {
    // Arrange: Q1 has null ebitda and null operatingIncome → no fallback available
    const q1 = makeQuarter('2023-03-31', { ebitda: null, operatingIncome: 100_000, da: 20_000 });
    q1.income.operatingIncome = null as unknown as number;
    q1.income.ebitda = null as unknown as number;

    const quarters = [
      q1,
      makeQuarter('2023-06-30', { ebitda: 200_000 }),
      makeQuarter('2023-09-30', { ebitda: 200_000 }),
      makeQuarter('2023-12-31', { ebitda: 200_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.ebitdaTtm).toBeNull();
  });
});

// ===========================================================================
// 3. ROIC: NOPAT / InvestedCapital with tax-rate clamp
// ===========================================================================

describe('ROIC calculation', () => {
  it('computes ROIC correctly with a normal effective tax rate', async () => {
    // Arrange:
    //   TTM operatingIncome = 4 × 100k = 400k
    //   TTM incomeTaxExpense = 4 × 21k = 84k
    //   TTM incomeBeforeTax = 4 × 100k = 400k
    //   effectiveTaxRate = 84k / 400k = 0.21
    //   NOPAT = 400k × (1 - 0.21) = 316k
    //   totalDebt = 500k, equity = 1_000k, cash = 200k
    //   investedCapital = 500k + 1_000k - 200k = 1_300k
    //   ROIC = 316k / 1_300k ≈ 0.24308

    const quarters = [
      makeQuarter('2023-03-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-06-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-09-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-12-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    const expectedRoic = (400_000 * 0.79) / 1_300_000;
    expect(lastRecord.roic).not.toBeNull();
    expect(lastRecord.roic as number).toBeCloseTo(expectedRoic, 6);
  });

  it('clamps the effective tax rate to 0.5 when raw rate exceeds 50%', async () => {
    // Arrange: taxExpense = 80k on preTax = 100k → raw rate = 0.80; clamped to 0.50
    //   NOPAT = TTM_opIncome × (1 - 0.50) = 400k × 0.50 = 200k
    //   investedCapital = 500k + 1_000k - 200k = 1_300k
    //   ROIC = 200k / 1_300k

    const quarters = [
      makeQuarter('2023-03-31', {
        operatingIncome: 100_000, incomeTaxExpense: 80_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-06-30', {
        operatingIncome: 100_000, incomeTaxExpense: 80_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-09-30', {
        operatingIncome: 100_000, incomeTaxExpense: 80_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-12-31', {
        operatingIncome: 100_000, incomeTaxExpense: 80_000, incomeBeforeTax: 100_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    const expectedRoic = (400_000 * 0.50) / 1_300_000;
    expect(lastRecord.roic as number).toBeCloseTo(expectedRoic, 6);
  });

  it('uses 0.21 statutory tax rate when TTM incomeBeforeTax is zero (avoids div/0)', async () => {
    // Arrange: incomeBeforeTax = 0 → cannot compute rate; fallback 0.21
    //   NOPAT = 400k × (1 - 0.21) = 316k
    //   ROIC = 316k / 1_300k

    const quarters = [
      makeQuarter('2023-03-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 0,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-06-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 0,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-09-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 0,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-12-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 0,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    const expectedRoic = (400_000 * 0.79) / 1_300_000;
    expect(lastRecord.roic as number).toBeCloseTo(expectedRoic, 6);
  });

  it('uses 0.21 statutory tax rate when TTM incomeBeforeTax is negative', async () => {
    // Arrange: negative preTax → cannot derive meaningful rate; fallback 0.21
    const quarters = [
      makeQuarter('2023-03-31', {
        operatingIncome: 100_000, incomeTaxExpense: 5_000, incomeBeforeTax: -50_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-06-30', {
        operatingIncome: 100_000, incomeTaxExpense: 5_000, incomeBeforeTax: -50_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-09-30', {
        operatingIncome: 100_000, incomeTaxExpense: 5_000, incomeBeforeTax: -50_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-12-31', {
        operatingIncome: 100_000, incomeTaxExpense: 5_000, incomeBeforeTax: -50_000,
        totalDebt: 500_000, totalStockholdersEquity: 1_000_000, cashAndCashEquivalents: 200_000,
      }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    const expectedRoic = (400_000 * 0.79) / 1_300_000;
    expect(lastRecord.roic as number).toBeCloseTo(expectedRoic, 6);
  });

  it('returns null roic when investedCapital is zero', async () => {
    // Arrange: totalDebt=0, equity=200k, cash=200k → investedCapital = 0 + 200k - 200k = 0
    const quarters = [
      makeQuarter('2023-03-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 0, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-06-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 0, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-09-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 0, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 200_000,
      }),
      makeQuarter('2023-12-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 0, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 200_000,
      }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.roic).toBeNull();
  });

  it('returns null roic when investedCapital is negative', async () => {
    // Arrange: totalDebt=100k, equity=200k, cash=500k → investedCapital = -200k < 0
    const quarters = [
      makeQuarter('2023-03-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 100_000, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 500_000,
      }),
      makeQuarter('2023-06-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 100_000, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 500_000,
      }),
      makeQuarter('2023-09-30', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 100_000, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 500_000,
      }),
      makeQuarter('2023-12-31', {
        operatingIncome: 100_000, incomeTaxExpense: 21_000, incomeBeforeTax: 100_000,
        totalDebt: 100_000, totalStockholdersEquity: 200_000, cashAndCashEquivalents: 500_000,
      }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.roic).toBeNull();
  });
});

// ===========================================================================
// 4. debtToEquity: null when equity ≤ 0
// ===========================================================================

describe('debtToEquity calculation', () => {
  it('computes debtToEquity correctly when equity is positive', async () => {
    // Arrange: totalDebt=600k, equity=300k → D/E = 2.0
    const quarters = [
      makeQuarter('2023-03-31', { totalDebt: 600_000, totalStockholdersEquity: 300_000 }),
      makeQuarter('2023-06-30', { totalDebt: 600_000, totalStockholdersEquity: 300_000 }),
      makeQuarter('2023-09-30', { totalDebt: 600_000, totalStockholdersEquity: 300_000 }),
      makeQuarter('2023-12-31', { totalDebt: 600_000, totalStockholdersEquity: 300_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.debtToEquity as number).toBeCloseTo(2.0, 6);
  });

  it('returns null debtToEquity when equity equals zero', async () => {
    const quarters = [
      makeQuarter('2023-03-31', { totalDebt: 600_000, totalStockholdersEquity: 0 }),
      makeQuarter('2023-06-30', { totalDebt: 600_000, totalStockholdersEquity: 0 }),
      makeQuarter('2023-09-30', { totalDebt: 600_000, totalStockholdersEquity: 0 }),
      makeQuarter('2023-12-31', { totalDebt: 600_000, totalStockholdersEquity: 0 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.debtToEquity).toBeNull();
  });

  it('returns null debtToEquity when equity is negative', async () => {
    const quarters = [
      makeQuarter('2023-03-31', { totalDebt: 600_000, totalStockholdersEquity: -50_000 }),
      makeQuarter('2023-06-30', { totalDebt: 600_000, totalStockholdersEquity: -50_000 }),
      makeQuarter('2023-09-30', { totalDebt: 600_000, totalStockholdersEquity: -50_000 }),
      makeQuarter('2023-12-31', { totalDebt: 600_000, totalStockholdersEquity: -50_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.debtToEquity).toBeNull();
  });
});

// ===========================================================================
// 5. revenueGrowthYoy: TTM vs prior TTM, expressed as PERCENT
// ===========================================================================

describe('revenueGrowthYoy calculation', () => {
  it('computes revenue growth as percent (not fraction) with 8 quarters of data', async () => {
    // Arrange: first 4 quarters each have revenue=1_000k (prior TTM = 4_000k)
    //          next 4 quarters each have revenue=1_100k (current TTM = 4_400k)
    //          growth = (4_400k - 4_000k) / 4_000k × 100 = 10.0 (percent)

    const quarters = [
      makeQuarter('2022-03-31', { revenue: 1_000_000 }),
      makeQuarter('2022-06-30', { revenue: 1_000_000 }),
      makeQuarter('2022-09-30', { revenue: 1_000_000 }),
      makeQuarter('2022-12-31', { revenue: 1_000_000 }),
      makeQuarter('2023-03-31', { revenue: 1_100_000 }),
      makeQuarter('2023-06-30', { revenue: 1_100_000 }),
      makeQuarter('2023-09-30', { revenue: 1_100_000 }),
      makeQuarter('2023-12-31', { revenue: 1_100_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    // The last record (index 7) should have growth computed
    const lastRecord = records[7];
    expect(lastRecord.revenueGrowthYoy).not.toBeNull();
    expect(lastRecord.revenueGrowthYoy as number).toBeCloseTo(10.0, 4);
  });

  it('returns null revenueGrowthYoy for the first 7 records (insufficient quarters)', async () => {
    // Only 8 quarters total; records[0..6] should have null growth
    const quarters = [
      makeQuarter('2022-03-31', { revenue: 1_000_000 }),
      makeQuarter('2022-06-30', { revenue: 1_000_000 }),
      makeQuarter('2022-09-30', { revenue: 1_000_000 }),
      makeQuarter('2022-12-31', { revenue: 1_000_000 }),
      makeQuarter('2023-03-31', { revenue: 1_100_000 }),
      makeQuarter('2023-06-30', { revenue: 1_100_000 }),
      makeQuarter('2023-09-30', { revenue: 1_100_000 }),
      makeQuarter('2023-12-31', { revenue: 1_100_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    // indices 0-6 should all be null
    for (let i = 0; i < 7; i++) {
      expect(records[i].revenueGrowthYoy).toBeNull();
    }
  });

  it('revenueGrowthYoy is a percent value, not a decimal fraction (regression: wrong scale)', async () => {
    // Arrange: 50% revenue growth
    // If the code returned a fraction (0.50), this assertion would catch it.
    const quarters = [
      makeQuarter('2022-03-31', { revenue: 1_000_000 }),
      makeQuarter('2022-06-30', { revenue: 1_000_000 }),
      makeQuarter('2022-09-30', { revenue: 1_000_000 }),
      makeQuarter('2022-12-31', { revenue: 1_000_000 }),
      makeQuarter('2023-03-31', { revenue: 1_500_000 }),
      makeQuarter('2023-06-30', { revenue: 1_500_000 }),
      makeQuarter('2023-09-30', { revenue: 1_500_000 }),
      makeQuarter('2023-12-31', { revenue: 1_500_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[7];
    expect(lastRecord.revenueGrowthYoy as number).toBeCloseTo(50.0, 4);
    // Confirm it is NOT the fractional form 0.5
    expect(Math.abs(lastRecord.revenueGrowthYoy as number - 0.5)).toBeGreaterThan(1);
  });
});

// ===========================================================================
// 6. epsGrowthYoy: decimal FRACTION; null when prior TTM EPS ≤ 0
// ===========================================================================

describe('epsGrowthYoy calculation', () => {
  it('computes epsGrowthYoy as a decimal fraction (not percent) with 8 quarters', async () => {
    // Arrange: prior TTM eps each quarter = 1.0 → prior TTM = 4.0
    //          current TTM eps each quarter = 1.2 → current TTM = 4.8
    //          growth = (4.8 - 4.0) / 4.0 = 0.20 (fraction)

    const quarters = [
      makeQuarter('2022-03-31', { epsdiluted: 1.0 }),
      makeQuarter('2022-06-30', { epsdiluted: 1.0 }),
      makeQuarter('2022-09-30', { epsdiluted: 1.0 }),
      makeQuarter('2022-12-31', { epsdiluted: 1.0 }),
      makeQuarter('2023-03-31', { epsdiluted: 1.2 }),
      makeQuarter('2023-06-30', { epsdiluted: 1.2 }),
      makeQuarter('2023-09-30', { epsdiluted: 1.2 }),
      makeQuarter('2023-12-31', { epsdiluted: 1.2 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[7];
    expect(lastRecord.epsGrowthYoy).not.toBeNull();
    expect(lastRecord.epsGrowthYoy as number).toBeCloseTo(0.20, 5);
  });

  it('epsGrowthYoy is a fraction not a percent (regression: wrong scale vs revenueGrowthYoy)', async () => {
    // 25% EPS growth should appear as 0.25, not 25.0
    const quarters = [
      makeQuarter('2022-03-31', { epsdiluted: 1.0 }),
      makeQuarter('2022-06-30', { epsdiluted: 1.0 }),
      makeQuarter('2022-09-30', { epsdiluted: 1.0 }),
      makeQuarter('2022-12-31', { epsdiluted: 1.0 }),
      makeQuarter('2023-03-31', { epsdiluted: 1.25 }),
      makeQuarter('2023-06-30', { epsdiluted: 1.25 }),
      makeQuarter('2023-09-30', { epsdiluted: 1.25 }),
      makeQuarter('2023-12-31', { epsdiluted: 1.25 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[7];
    expect(lastRecord.epsGrowthYoy as number).toBeCloseTo(0.25, 5);
    // Guard: if returned as 25.0 (percent), this would fail
    expect(Math.abs(lastRecord.epsGrowthYoy as number - 25.0)).toBeGreaterThan(1);
  });

  it('returns null epsGrowthYoy when prior TTM EPS is zero', async () => {
    // Prior TTM: 0 each → sum = 0; growth would divide by zero → null
    const quarters = [
      makeQuarter('2022-03-31', { epsdiluted: 0.0 }),
      makeQuarter('2022-06-30', { epsdiluted: 0.0 }),
      makeQuarter('2022-09-30', { epsdiluted: 0.0 }),
      makeQuarter('2022-12-31', { epsdiluted: 0.0 }),
      makeQuarter('2023-03-31', { epsdiluted: 1.0 }),
      makeQuarter('2023-06-30', { epsdiluted: 1.0 }),
      makeQuarter('2023-09-30', { epsdiluted: 1.0 }),
      makeQuarter('2023-12-31', { epsdiluted: 1.0 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[7];
    expect(lastRecord.epsGrowthYoy).toBeNull();
  });

  it('returns null epsGrowthYoy when prior TTM EPS is negative', async () => {
    // Prior TTM: each quarter -0.5 → prior sum = -2.0; not valid PEG base → null
    const quarters = [
      makeQuarter('2022-03-31', { epsdiluted: -0.5 }),
      makeQuarter('2022-06-30', { epsdiluted: -0.5 }),
      makeQuarter('2022-09-30', { epsdiluted: -0.5 }),
      makeQuarter('2022-12-31', { epsdiluted: -0.5 }),
      makeQuarter('2023-03-31', { epsdiluted: 1.0 }),
      makeQuarter('2023-06-30', { epsdiluted: 1.0 }),
      makeQuarter('2023-09-30', { epsdiluted: 1.0 }),
      makeQuarter('2023-12-31', { epsdiluted: 1.0 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[7];
    expect(lastRecord.epsGrowthYoy).toBeNull();
  });

  it('returns null epsGrowthYoy for records with fewer than 8 quarters of data', async () => {
    // 8 quarters total; only index 7 should have a non-null value
    const quarters = [
      makeQuarter('2022-03-31', { epsdiluted: 1.0 }),
      makeQuarter('2022-06-30', { epsdiluted: 1.0 }),
      makeQuarter('2022-09-30', { epsdiluted: 1.0 }),
      makeQuarter('2022-12-31', { epsdiluted: 1.0 }),
      makeQuarter('2023-03-31', { epsdiluted: 1.2 }),
      makeQuarter('2023-06-30', { epsdiluted: 1.2 }),
      makeQuarter('2023-09-30', { epsdiluted: 1.2 }),
      makeQuarter('2023-12-31', { epsdiluted: 1.2 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    for (let i = 0; i < 7; i++) {
      expect(records[i].epsGrowthYoy).toBeNull();
    }
  });

  it('uses epsdiluted preferentially over eps for epsGrowthYoy', async () => {
    // Arrange: eps=1.0 (basic) but epsdiluted=0.9 in prior periods
    //          eps=1.2 (basic) but epsdiluted=1.08 in current periods
    //          growth based on diluted: (4 × 1.08 - 4 × 0.9) / (4 × 0.9) = 0.20

    const quarters = [
      makeQuarter('2022-03-31', { eps: 1.0, epsdiluted: 0.9 }),
      makeQuarter('2022-06-30', { eps: 1.0, epsdiluted: 0.9 }),
      makeQuarter('2022-09-30', { eps: 1.0, epsdiluted: 0.9 }),
      makeQuarter('2022-12-31', { eps: 1.0, epsdiluted: 0.9 }),
      makeQuarter('2023-03-31', { eps: 1.2, epsdiluted: 1.08 }),
      makeQuarter('2023-06-30', { eps: 1.2, epsdiluted: 1.08 }),
      makeQuarter('2023-09-30', { eps: 1.2, epsdiluted: 1.08 }),
      makeQuarter('2023-12-31', { eps: 1.2, epsdiluted: 1.08 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[7];
    expect(lastRecord.epsGrowthYoy as number).toBeCloseTo(0.20, 5);
  });
});

// ===========================================================================
// New field: totalEquity persistence (metrics overhaul)
// ===========================================================================

describe('totalEquity field', () => {
  it('populates totalEquity as a BigInt from totalStockholdersEquity for full-window quarters', async () => {
    // Arrange: 4 quarters each with totalStockholdersEquity=1_500_000
    // For the quarter at index 3 (the first full-window record), computeTtmAndRatios
    // should set totalEquity = BigInt(1_500_000) (current-quarter point-in-time value).
    const quarters = [
      makeQuarter('2023-03-31', { totalStockholdersEquity: 1_500_000 }),
      makeQuarter('2023-06-30', { totalStockholdersEquity: 1_500_000 }),
      makeQuarter('2023-09-30', { totalStockholdersEquity: 1_500_000 }),
      makeQuarter('2023-12-31', { totalStockholdersEquity: 1_500_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    // The 4th record (index 3) is the first with a full 4-quarter window
    const lastRecord = records[3];
    expect(lastRecord.totalEquity).toBe(BigInt(1_500_000));
  });

  it('sets totalEquity to null when totalStockholdersEquity is missing in current quarter', async () => {
    // Arrange: only Q4 has null equity (missing balance sheet row)
    const q4 = makeQuarter('2023-12-31', {});
    q4.balance.totalStockholdersEquity = null as unknown as number;

    const quarters = [
      makeQuarter('2023-03-31', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-06-30', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-09-30', { totalStockholdersEquity: 1_000_000 }),
      q4,
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.totalEquity).toBeNull();
  });

  it('totalEquity is null for records before the 4-quarter window (index < 3)', async () => {
    // computeTtmAndRatios returns the record unchanged for index < 3,
    // so totalEquity (set only inside the TTM block) must remain null.
    const quarters = [
      makeQuarter('2023-03-31', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-06-30', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-09-30', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-12-31', { totalStockholdersEquity: 1_000_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    for (let i = 0; i < 3; i++) {
      expect(records[i].totalEquity).toBeNull();
    }
  });

  it('totalEquity in the upsert payload matches the current-quarter totalStockholdersEquity', async () => {
    // Arrange: Q4 has a distinct equity value (2_000_000) vs earlier quarters (1_000_000)
    // The upsert for Q4 should include totalEquity = BigInt(2_000_000)
    const quarters = [
      makeQuarter('2023-03-31', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-06-30', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-09-30', { totalStockholdersEquity: 1_000_000 }),
      makeQuarter('2023-12-31', { totalStockholdersEquity: 2_000_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    await syncAndCollect(prisma);

    // Find the upsert call for the Q4 date
    type UpsertArgs = {
      where: { symbol_date: { symbol: string; date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };

    const q4Call = (prisma.financialRatio.upsert as jest.Mock).mock.calls.find(
      (args: unknown[]) => {
        const opts = args[0] as UpsertArgs;
        return opts?.where?.symbol_date?.date?.toISOString().slice(0, 10) === '2023-12-31';
      }
    );
    expect(q4Call).toBeDefined();
    const createPayload = (q4Call![0] as UpsertArgs).create;
    expect(createPayload.totalEquity).toBe(BigInt(2_000_000));
  });

  it('totalEquity rounds fractional totalStockholdersEquity values (BigInt conversion)', async () => {
    // FMP sometimes returns fractional values; BigInt(Math.round()) should handle it
    const quarters = [
      makeQuarter('2023-03-31', { totalStockholdersEquity: 1_000_000.7 }),
      makeQuarter('2023-06-30', { totalStockholdersEquity: 1_000_000.7 }),
      makeQuarter('2023-09-30', { totalStockholdersEquity: 1_000_000.7 }),
      makeQuarter('2023-12-31', { totalStockholdersEquity: 1_000_000.7 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    const lastRecord = records[3];
    expect(lastRecord.totalEquity).toBe(BigInt(1_000_001)); // Math.round(1_000_000.7)
  });
});

// ===========================================================================
// 7. Insufficient quarters: TTM-derived fields stay null before index 3
// ===========================================================================

describe('insufficient quarters boundary', () => {
  it('first 3 records have null ebitdaTtm, debtToEquity, roic, and epsGrowthYoy (TTM-only fields)', async () => {
    // Arrange: 4 quarters so exactly record at index 3 gets TTM computed.
    // computeTtmAndRatios returns the record unchanged for index < 3.
    //
    // What stays null at index 0-2:
    //   - ebitdaTtm: initialised null in mergeFundamentals; only set at index >= 3
    //   - debtToEquity: initialised null in mergeFundamentals; only set at index >= 3
    //   - roic: initialised null in mergeFundamentals; only set at index >= 3
    //   - epsGrowthYoy: initialised null in mergeFundamentals; only set at index >= 7
    //
    // What is NOT null at index 0-2:
    //   - fcf: mergeFundamentals sets it to the per-quarter freeCashFlow value immediately;
    //          computeTtmAndRatios overwrites it with the TTM sum only at index >= 3.

    const quarters = [
      makeQuarter('2023-03-31', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-06-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-09-30', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
      makeQuarter('2023-12-31', { operatingCashFlow: 100_000, capitalExpenditure: -20_000 }),
    ];

    const prisma = makePrisma();
    mockAxios(buildFmpPayload(quarters));
    const records = await syncAndCollect(prisma);

    // Indices 0, 1, 2 → TTM not computable
    for (let i = 0; i < 3; i++) {
      expect(records[i].ebitdaTtm).toBeNull();
      expect(records[i].debtToEquity).toBeNull();
      expect(records[i].roic).toBeNull();
      expect(records[i].epsGrowthYoy).toBeNull();
    }

    // Index 3 → TTM window complete (ebitdaTtm, fcf, debtToEquity, roic now non-null)
    expect(records[3].ebitdaTtm).not.toBeNull();
    expect(records[3].fcf).not.toBeNull();
    expect(records[3].debtToEquity).not.toBeNull();
    expect(records[3].roic).not.toBeNull();
  });
});
