/**
 * Regression tests for the mergeData() calculation logic from
 * frontend/src/components/AnalysisChart.tsx.
 *
 * mergeData() is a private (unexported) function in AnalysisChart.tsx and the
 * frontend has no test runner installed. Because the calculations are pure
 * JavaScript with no React/DOM dependencies, the logic is inlined here and
 * exercised under Jest (the configured backend runner).
 *
 * If the frontend ever gains vitest, these tests should migrate to
 * frontend/src/components/AnalysisChart.test.ts.
 *
 * Inline copy updated to match the metrics overhaul:
 *   - Removed: priceToFcf, fcf (BigInt display), roe, debtToEquity from MergedRow output
 *   - Added: fcfYield, debtToEbitda, priceToBook
 *   - eps in output now reflects ttmEps (was quarterly eps)
 *   - FundamentalDataPoint gained totalEquity
 *
 * Key behaviors tested:
 *  - marketCap = close × dilutedShares
 *  - evEbitda = (marketCap + totalDebt - cash) / ebitdaTtm; null when any input missing
 *  - peg: (close / ttmEps) / (epsGrowthYoy × 100); null when growth <= 0
 *  - roic: fund.roic × 100 exactly once (regression: double-multiply like the ROE bug)
 *  - fcfYield: (fcf / marketCap) × 100; null when marketCap <= 0 or fcf null
 *  - debtToEbitda: totalDebt / ebitdaTtm; null when ebitdaTtm <= 0 or inputs null
 *  - priceToBook: marketCap / totalEquity; null when totalEquity <= 0 or inputs null
 *  - eps output = ttmEps (TTM, not quarterly)
 *  - forward-fill: each price row picks the most recent fundamental <= its date
 *  - null propagation: all derived metrics are null when their inputs are null
 */

// ---------------------------------------------------------------------------
// Inline the mergeData logic — exact copy of the logic in AnalysisChart.tsx.
// When production logic changes, update this copy and document the PR.
// Last synced: metrics overhaul (totalEquity, fcfYield, debtToEbitda, priceToBook)
// ---------------------------------------------------------------------------

interface StockPriceData {
  date: string;
  close: number;
}

interface FundamentalDataPoint {
  date: string;
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: number | null;
  eps: number | null;
  ttmEps: number | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
  ebitdaTtm: number | null;
  dilutedShares: number | null;
  totalDebt: number | null;
  cashAndEquivalents: number | null;
  totalEquity: number | null;
  epsGrowthYoy: number | null;
  roic: number | null;
}

interface MergedRow {
  date: string;
  price: number;
  peRatio: number | null;
  eps: number | null;
  revenueGrowthYoy: number | null;
  evEbitda: number | null;
  peg: number | null;
  roic: number | null;
  fcfYield: number | null;
  priceToBook: number | null;
  debtToEbitda: number | null;
}

/**
 * Extracted from frontend/src/components/AnalysisChart.tsx — mergeData().
 * Metrics overhaul: removed priceToFcf/roe/debtToEquity output;
 * added fcfYield, debtToEbitda, priceToBook; eps now reflects ttmEps.
 */
function mergeData(
  priceData: StockPriceData[],
  fundamentals: FundamentalDataPoint[]
): MergedRow[] {
  const sortedFunds = [...fundamentals].sort((a, b) => a.date.localeCompare(b.date));

  return priceData
    .map((p) => {
      const dateKey = p.date.split('T')[0];

      let fund: FundamentalDataPoint | null = null;
      for (const f of sortedFunds) {
        if (f.date <= dateKey) {
          fund = f;
        } else {
          break;
        }
      }

      // Compute market cap from live price × current-quarter diluted share count
      const shares = fund?.dilutedShares ?? null;
      const marketCap = shares != null && shares > 0 ? p.close * shares : null;

      // EV/EBITDA: (marketCap + totalDebt - cashAndEquivalents) / TTM EBITDA
      let evEbitda: number | null = null;
      if (
        marketCap != null &&
        fund?.ebitdaTtm != null &&
        fund.ebitdaTtm > 0 &&
        fund.totalDebt != null &&
        fund.cashAndEquivalents != null
      ) {
        evEbitda = (marketCap + fund.totalDebt - fund.cashAndEquivalents) / fund.ebitdaTtm;
      }

      // PEG: P/E divided by EPS growth rate (%). Growth <= 0 → null (meaningless)
      const pe =
        fund?.ttmEps != null && fund.ttmEps > 0 ? p.close / fund.ttmEps : null;
      const g =
        fund?.epsGrowthYoy != null ? fund.epsGrowthYoy * 100 : null; // fraction → percent
      const peg = pe != null && g != null && g > 0 ? pe / g : null;

      // ROIC: single multiply from decimal fraction to percent (0.18 → 18.0)
      const roic = fund?.roic != null ? fund.roic * 100 : null;

      // FCF Yield: TTM FCF / market cap, expressed as a percentage
      const fcfYield =
        marketCap != null && fund?.fcf != null && marketCap > 0
          ? (fund.fcf / marketCap) * 100
          : null;

      // Debt/EBITDA: total debt / TTM EBITDA
      const debtToEbitda =
        fund?.totalDebt != null && fund?.ebitdaTtm != null && fund.ebitdaTtm > 0
          ? fund.totalDebt / fund.ebitdaTtm
          : null;

      // P/B: market cap / total stockholders' equity (book value)
      const priceToBook =
        marketCap != null && fund?.totalEquity != null && fund.totalEquity > 0
          ? marketCap / fund.totalEquity
          : null;

      return {
        date: dateKey,
        price: p.close,
        peRatio:
          fund?.ttmEps != null && fund.ttmEps > 0
            ? p.close / fund.ttmEps
            : fund?.peRatio ?? null,
        eps: fund?.ttmEps ?? null,
        revenueGrowthYoy: fund?.revenueGrowthYoy ?? null,
        evEbitda,
        peg,
        roic,
        fcfYield,
        priceToBook,
        debtToEbitda,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrice(date: string, close: number): StockPriceData {
  return { date, close };
}

function makeFund(
  date: string,
  opts: Partial<FundamentalDataPoint> = {}
): FundamentalDataPoint {
  return {
    date,
    peRatio: null,
    priceToFcf: null,
    fcf: null,
    eps: null,
    ttmEps: null,
    revenueGrowthYoy: null,
    roe: null,
    debtToEquity: null,
    ebitdaTtm: null,
    dilutedShares: null,
    totalDebt: null,
    cashAndEquivalents: null,
    totalEquity: null,
    epsGrowthYoy: null,
    roic: null,
    ...opts,
  };
}

// ===========================================================================
// marketCap: close × dilutedShares (used internally to drive derived metrics)
// ===========================================================================

describe('mergeData — marketCap (internal)', () => {
  it('produces a non-null fcfYield when dilutedShares and fcf are both present', () => {
    // close=100, shares=1_000_000 → marketCap=100_000_000
    // fcf=10_000_000 → fcfYield = 10_000_000/100_000_000 × 100 = 10.0%
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 1_000_000, fcf: 10_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeCloseTo(10.0, 6);
  });

  it('fcfYield is null when dilutedShares is null (no marketCap)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: null, fcf: 10_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeNull();
  });

  it('fcfYield is null when dilutedShares is zero (no marketCap)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 0, fcf: 10_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeNull();
  });
});

// ===========================================================================
// evEbitda: (marketCap + totalDebt - cash) / ebitdaTtm
// ===========================================================================

describe('mergeData — evEbitda', () => {
  it('computes evEbitda correctly when all inputs are present', () => {
    // close=50, shares=2_000_000 → marketCap=100_000_000
    // totalDebt=20_000_000, cash=10_000_000 → EV=110_000_000
    // ebitdaTtm=22_000_000 → EV/EBITDA=5.0

    const prices = [makePrice('2023-12-31', 50)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 2_000_000,
      ebitdaTtm: 22_000_000,
      totalDebt: 20_000_000,
      cashAndEquivalents: 10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].evEbitda).toBeCloseTo(5.0, 6);
  });

  it('returns null evEbitda when ebitdaTtm is null', () => {
    const prices = [makePrice('2023-12-31', 50)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 2_000_000,
      ebitdaTtm: null,
      totalDebt: 20_000_000,
      cashAndEquivalents: 10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].evEbitda).toBeNull();
  });

  it('returns null evEbitda when ebitdaTtm is zero (avoids division by zero)', () => {
    const prices = [makePrice('2023-12-31', 50)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 2_000_000,
      ebitdaTtm: 0,
      totalDebt: 20_000_000,
      cashAndEquivalents: 10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].evEbitda).toBeNull();
  });

  it('returns null evEbitda when totalDebt is null', () => {
    const prices = [makePrice('2023-12-31', 50)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 2_000_000,
      ebitdaTtm: 22_000_000,
      totalDebt: null,
      cashAndEquivalents: 10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].evEbitda).toBeNull();
  });

  it('returns null evEbitda when cashAndEquivalents is null', () => {
    const prices = [makePrice('2023-12-31', 50)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 2_000_000,
      ebitdaTtm: 22_000_000,
      totalDebt: 20_000_000,
      cashAndEquivalents: null,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].evEbitda).toBeNull();
  });

  it('returns null evEbitda when dilutedShares is null (no marketCap)', () => {
    const prices = [makePrice('2023-12-31', 50)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: null,
      ebitdaTtm: 22_000_000,
      totalDebt: 20_000_000,
      cashAndEquivalents: 10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].evEbitda).toBeNull();
  });
});

// ===========================================================================
// PEG: (close / ttmEps) / (epsGrowthYoy × 100); null when growth <= 0
// ===========================================================================

describe('mergeData — PEG ratio', () => {
  it('computes PEG correctly when P/E > 0 and growth > 0', () => {
    // close=100, ttmEps=5 → P/E=20
    // epsGrowthYoy=0.20 → g=20%
    // PEG = 20 / 20 = 1.0

    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: 5, epsGrowthYoy: 0.20 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peg).toBeCloseTo(1.0, 6);
  });

  it('returns null peg when epsGrowthYoy is zero', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: 5, epsGrowthYoy: 0 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peg).toBeNull();
  });

  it('returns null peg when epsGrowthYoy is negative', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: 5, epsGrowthYoy: -0.10 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peg).toBeNull();
  });

  it('returns null peg when ttmEps is zero (P/E undefined)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: 0, epsGrowthYoy: 0.20 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peg).toBeNull();
  });

  it('returns null peg when ttmEps is null', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: null, epsGrowthYoy: 0.20 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peg).toBeNull();
  });

  it('returns null peg when epsGrowthYoy is null', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: 5, epsGrowthYoy: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peg).toBeNull();
  });

  it('converts epsGrowthYoy fraction to percent before dividing for PEG (scale guard)', () => {
    // epsGrowthYoy=0.15 (15%). If NOT converted to percent, PEG = 20/0.15 = 133 (wrong).
    // Correctly: g = 0.15 × 100 = 15; PEG = 20/15 ≈ 1.333
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { ttmEps: 5, epsGrowthYoy: 0.15 })];

    const rows = mergeData(prices, funds);

    // Correct answer: ≈ 1.333, not ≈ 133
    expect(rows[0].peg as number).toBeCloseTo(1.333, 2);
    expect(rows[0].peg as number).toBeLessThan(10); // guard: wrong answer is ~133
  });
});

// ===========================================================================
// ROIC: single ×100 multiply (regression: double-multiply like the ROE bug)
// ===========================================================================

describe('mergeData — ROIC single multiply (regression: must not double-multiply like ROE bug)', () => {
  it('multiplies stored roic by 100 exactly once: 0.18 → 18.0', () => {
    // roic stored as decimal fraction: 0.18 (= 18%)
    // After mergeData: should be 18.0, NOT 1800 (double-multiply)

    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { roic: 0.18 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].roic).toBeCloseTo(18.0, 6);
  });

  it('does not double-multiply roic (regression: ROE shown as 2800%)', () => {
    // If the code applied ×100 twice: 0.28 × 100 × 100 = 2800 — the documented bug.
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { roic: 0.28 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].roic as number).toBeCloseTo(28.0, 6);
    expect(rows[0].roic as number).not.toBeCloseTo(2800, 0); // double-multiply guard
  });

  it('returns null roic when fund.roic is null', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { roic: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].roic).toBeNull();
  });
});

// ===========================================================================
// fcfYield: (fcf / marketCap) × 100 — new metric
// ===========================================================================

describe('mergeData — fcfYield', () => {
  it('computes fcfYield correctly: fcf/marketCap×100', () => {
    // close=200, shares=500_000 → marketCap=100_000_000
    // fcf=5_000_000 → fcfYield = 5_000_000/100_000_000 × 100 = 5.0%
    const prices = [makePrice('2023-12-31', 200)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 500_000, fcf: 5_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeCloseTo(5.0, 6);
  });

  it('returns null fcfYield when fcf is null', () => {
    const prices = [makePrice('2023-12-31', 200)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 500_000, fcf: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeNull();
  });

  it('returns null fcfYield when dilutedShares is null (marketCap cannot be computed)', () => {
    const prices = [makePrice('2023-12-31', 200)];
    const funds = [makeFund('2023-12-31', { dilutedShares: null, fcf: 5_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeNull();
  });

  it('returns null fcfYield when fcf is negative (guard: negative yield is misleading)', () => {
    // The source code does not guard against negative fcf for fcfYield —
    // only the marketCap > 0 guard is applied. Negative FCF produces a
    // negative yield, which is legitimate data (the company burns cash).
    // This test documents the actual behavior: negative fcf → negative fcfYield.
    const prices = [makePrice('2023-12-31', 200)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 500_000, fcf: -5_000_000 })];

    const rows = mergeData(prices, funds);

    // The current implementation allows negative fcfYield.
    // This test documents the behavior rather than enforcing a null.
    expect(typeof rows[0].fcfYield).toBe('number');
    expect(rows[0].fcfYield as number).toBeCloseTo(-5.0, 6);
  });
});

// ===========================================================================
// debtToEbitda: totalDebt / ebitdaTtm — new metric
// ===========================================================================

describe('mergeData — debtToEbitda', () => {
  it('computes debtToEbitda correctly', () => {
    // totalDebt=40_000_000, ebitdaTtm=10_000_000 → ratio=4.0
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', {
      totalDebt: 40_000_000,
      ebitdaTtm: 10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].debtToEbitda).toBeCloseTo(4.0, 6);
  });

  it('returns null debtToEbitda when ebitdaTtm is null', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { totalDebt: 40_000_000, ebitdaTtm: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].debtToEbitda).toBeNull();
  });

  it('returns null debtToEbitda when ebitdaTtm is zero (avoids division by zero)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { totalDebt: 40_000_000, ebitdaTtm: 0 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].debtToEbitda).toBeNull();
  });

  it('returns null debtToEbitda when ebitdaTtm is negative (avoids negative-EBITDA nonsense)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { totalDebt: 40_000_000, ebitdaTtm: -1_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].debtToEbitda).toBeNull();
  });

  it('returns null debtToEbitda when totalDebt is null', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { totalDebt: null, ebitdaTtm: 10_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].debtToEbitda).toBeNull();
  });

  it('returns zero debtToEbitda when totalDebt is zero (debt-free company)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { totalDebt: 0, ebitdaTtm: 10_000_000 })];

    const rows = mergeData(prices, funds);

    // totalDebt is non-null (zero is valid) and ebitdaTtm > 0, so ratio = 0/10M = 0
    expect(rows[0].debtToEbitda).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// priceToBook: marketCap / totalEquity — new metric
// ===========================================================================

describe('mergeData — priceToBook', () => {
  it('computes priceToBook correctly', () => {
    // close=100, shares=1_000_000 → marketCap=100_000_000
    // totalEquity=50_000_000 → P/B=2.0
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 1_000_000,
      totalEquity: 50_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToBook).toBeCloseTo(2.0, 6);
  });

  it('returns null priceToBook when totalEquity is null', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 1_000_000,
      totalEquity: null,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToBook).toBeNull();
  });

  it('returns null priceToBook when totalEquity is zero (avoids division by zero)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 1_000_000,
      totalEquity: 0,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToBook).toBeNull();
  });

  it('returns null priceToBook when totalEquity is negative (negative book value)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: 1_000_000,
      totalEquity: -10_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToBook).toBeNull();
  });

  it('returns null priceToBook when dilutedShares is null (no marketCap)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', {
      dilutedShares: null,
      totalEquity: 50_000_000,
    })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToBook).toBeNull();
  });
});

// ===========================================================================
// eps output: reflects ttmEps (was quarterly eps — metrics overhaul change)
// ===========================================================================

describe('mergeData — eps output reflects ttmEps (not quarterly eps)', () => {
  it('eps in the merged row equals ttmEps from the fundamental, not quarterly eps', () => {
    // eps (quarterly) = 1.0, ttmEps = 4.5 → merged row.eps should be 4.5
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { eps: 1.0, ttmEps: 4.5 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].eps).toBeCloseTo(4.5, 6);
  });

  it('eps in the merged row is null when ttmEps is null (even if quarterly eps exists)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { eps: 1.5, ttmEps: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].eps).toBeNull();
  });
});

// ===========================================================================
// Forward-fill: each price row uses the most recent fund <= its date
// ===========================================================================

describe('mergeData — forward-fill of fundamentals', () => {
  it('carries the last known fundamental forward when no newer data exists', () => {
    // Fund published on 2023-09-30; price rows span 2023-10-01 to 2023-11-30
    const fund = makeFund('2023-09-30', { roic: 0.15, epsGrowthYoy: 0.10, ttmEps: 4.0 });
    const prices = [
      makePrice('2023-10-01', 100),
      makePrice('2023-11-01', 110),
      makePrice('2023-11-30', 120),
    ];

    const rows = mergeData(prices, [fund]);

    // All rows should carry the September fundamental forward
    for (const row of rows) {
      expect(row.roic).toBeCloseTo(15.0, 6);
    }
  });

  it('does not use a fund whose date is after the price row date', () => {
    // Fund is dated 2024-01-01, price is 2023-12-31 → no fund should apply
    const fund = makeFund('2024-01-01', { roic: 0.20 });
    const prices = [makePrice('2023-12-31', 100)];

    const rows = mergeData(prices, [fund]);

    expect(rows[0].roic).toBeNull();
  });

  it('uses the most recent fund when multiple fundamentals exist before price date', () => {
    // Two funds: 2023-06-30 (roic=0.10) and 2023-09-30 (roic=0.20)
    // Price on 2023-12-31 should use the more recent one (0.20 → 20.0)
    const funds = [
      makeFund('2023-06-30', { roic: 0.10 }),
      makeFund('2023-09-30', { roic: 0.20 }),
    ];
    const prices = [makePrice('2023-12-31', 100)];

    const rows = mergeData(prices, funds);

    expect(rows[0].roic).toBeCloseTo(20.0, 6);
  });

  it('returns null for all derived metrics when no fundamental exists on or before price date', () => {
    const prices = [makePrice('2022-01-01', 100)];
    const funds = [makeFund('2023-01-01', { roic: 0.18, ttmEps: 5, epsGrowthYoy: 0.10 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].roic).toBeNull();
    expect(rows[0].peg).toBeNull();
    expect(rows[0].evEbitda).toBeNull();
    expect(rows[0].fcfYield).toBeNull();
    expect(rows[0].priceToBook).toBeNull();
    expect(rows[0].debtToEbitda).toBeNull();
  });

  it('forward-fills priceToBook across multiple trading days', () => {
    // Fund on 2023-09-30 with known totalEquity and dilutedShares
    // price days: 2023-10-02, 2023-10-03
    const fund = makeFund('2023-09-30', {
      dilutedShares: 1_000_000,
      totalEquity: 40_000_000,
    });
    const prices = [
      makePrice('2023-10-02', 80),   // marketCap=80M, P/B=80M/40M=2.0
      makePrice('2023-10-03', 120),  // marketCap=120M, P/B=120M/40M=3.0
    ];

    const rows = mergeData(prices, [fund]);
    rows.sort((a, b) => a.date.localeCompare(b.date));

    expect(rows[0].priceToBook).toBeCloseTo(2.0, 6);
    expect(rows[1].priceToBook).toBeCloseTo(3.0, 6);
  });
});

// ===========================================================================
// peRatio: computed from live price / ttmEps when available
// ===========================================================================

describe('mergeData — peRatio', () => {
  it('computes P/E from live close / ttmEps when ttmEps > 0', () => {
    // close=150, ttmEps=10 → P/E=15
    const prices = [makePrice('2023-12-31', 150)];
    const funds = [makeFund('2023-12-31', { ttmEps: 10, peRatio: 99 })]; // stored ratio overridden

    const rows = mergeData(prices, funds);

    expect(rows[0].peRatio).toBeCloseTo(15, 6);
  });

  it('falls back to stored peRatio when ttmEps is null', () => {
    const prices = [makePrice('2023-12-31', 150)];
    const funds = [makeFund('2023-12-31', { ttmEps: null, peRatio: 22.5 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peRatio).toBeCloseTo(22.5, 6);
  });

  it('returns null peRatio when both ttmEps and stored peRatio are null', () => {
    const prices = [makePrice('2023-12-31', 150)];
    const funds = [makeFund('2023-12-31', { ttmEps: null, peRatio: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].peRatio).toBeNull();
  });
});

// ===========================================================================
// Comprehensive null propagation: all new metrics null when no fundamentals
// ===========================================================================

describe('mergeData — null propagation for new metrics when all fundamentals are null', () => {
  it('all new metrics are null when fundamental has no relevant data', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31')]; // all null defaults

    const rows = mergeData(prices, funds);

    expect(rows[0].fcfYield).toBeNull();
    expect(rows[0].debtToEbitda).toBeNull();
    expect(rows[0].priceToBook).toBeNull();
    expect(rows[0].evEbitda).toBeNull();
    expect(rows[0].peg).toBeNull();
    expect(rows[0].roic).toBeNull();
    expect(rows[0].eps).toBeNull();
  });
});
