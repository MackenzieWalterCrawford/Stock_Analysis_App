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
 * Key behaviors tested:
 *  - marketCap = close × dilutedShares
 *  - priceToFcf = marketCap / TTM FCF (falls back to stored ratio when unavailable)
 *  - evEbitda = (marketCap + totalDebt - cash) / ebitdaTtm; null when any input missing
 *  - peg: (close / ttmEps) / (epsGrowthYoy × 100); null when growth ≤ 0
 *  - roic: fund.roic × 100 exactly once (regression: double-multiply like the ROE bug)
 *  - forward-fill: each price row picks the most recent fundamental ≤ its date
 *  - null propagation: all derived metrics are null when their inputs are null
 */

// ---------------------------------------------------------------------------
// Inline the mergeData logic — exact copy of the logic in AnalysisChart.tsx.
// When production logic changes, update this copy and document the PR.
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
  epsGrowthYoy: number | null;
  roic: number | null;
}

interface MergedRow {
  date: string;
  price: number;
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: number | null;
  eps: number | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
  evEbitda: number | null;
  peg: number | null;
  roic: number | null;
}

/** Extracted from frontend/src/components/AnalysisChart.tsx — mergeData(). */
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

      const shares = fund?.dilutedShares ?? null;
      const marketCap = shares != null && shares > 0 ? p.close * shares : null;

      const priceToFcf =
        marketCap != null && fund?.fcf != null && fund.fcf > 0
          ? marketCap / fund.fcf
          : fund?.priceToFcf ?? null;

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

      const pe =
        fund?.ttmEps != null && fund.ttmEps > 0 ? p.close / fund.ttmEps : null;
      const g =
        fund?.epsGrowthYoy != null ? fund.epsGrowthYoy * 100 : null;
      const peg = pe != null && g != null && g > 0 ? pe / g : null;

      // ROIC: single multiply from decimal fraction → percent
      const roic = fund?.roic != null ? fund.roic * 100 : null;

      return {
        date: dateKey,
        price: p.close,
        peRatio:
          fund?.ttmEps != null && fund.ttmEps > 0
            ? p.close / fund.ttmEps
            : fund?.peRatio ?? null,
        priceToFcf,
        fcf: fund?.fcf != null ? fund.fcf / 1e9 : null,
        eps: fund?.eps ?? null,
        revenueGrowthYoy: fund?.revenueGrowthYoy ?? null,
        roe: fund?.roe != null ? fund.roe * 100 : null,
        debtToEquity: fund?.debtToEquity ?? null,
        evEbitda,
        peg,
        roic,
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
    epsGrowthYoy: null,
    roic: null,
    ...opts,
  };
}

// ===========================================================================
// marketCap: close × dilutedShares
// ===========================================================================

describe('mergeData — marketCap', () => {
  it('computes marketCap as close × dilutedShares', () => {
    // close=100, shares=1_000_000 → marketCap=100_000_000
    // priceToFcf = marketCap / fcf = 100_000_000 / 50_000_000 = 2.0
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 1_000_000, fcf: 50_000_000 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToFcf).toBeCloseTo(2.0, 6);
  });

  it('priceToFcf is null when dilutedShares is null (no marketCap)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: null, fcf: 50_000_000, priceToFcf: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToFcf).toBeNull();
  });

  it('priceToFcf falls back to stored priceToFcf ratio when marketCap is unavailable', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: null, fcf: 50_000_000, priceToFcf: 15.5 })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToFcf).toBeCloseTo(15.5, 6);
  });

  it('priceToFcf is null when fcf is zero (avoids division by zero)', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 1_000_000, fcf: 0, priceToFcf: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToFcf).toBeNull();
  });

  it('priceToFcf is null when fcf is negative', () => {
    const prices = [makePrice('2023-12-31', 100)];
    const funds = [makeFund('2023-12-31', { dilutedShares: 1_000_000, fcf: -10_000_000, priceToFcf: null })];

    const rows = mergeData(prices, funds);

    expect(rows[0].priceToFcf).toBeNull();
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
// PEG: (close / ttmEps) / (epsGrowthYoy × 100); null when growth ≤ 0
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
// Forward-fill: each price row uses the most recent fund ≤ its date
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
    expect(rows[0].priceToFcf).toBeNull();
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
