import { PrismaClient, Prisma } from '../generated/prisma';
import { startOfYear, subDays, subMonths, subYears } from 'date-fns';
import { CacheService } from './cache';
import { FundamentalFetcher } from './fundamentalFetcher';

// ============================================================================
// Types
// ============================================================================

// Mirrors the Prisma-generated FinancialRatio payload type. The generated
// client now includes all columns (including totalEquity added by the
// add_ratio_ttm_components migration), so this interface is kept as a
// local alias for clarity rather than a workaround.
interface FinancialRatioRow {
  id: number;
  symbol: string;
  date: Date;
  peRatio: Prisma.Decimal | null;
  priceToFcf: Prisma.Decimal | null;
  priceToOcf: Prisma.Decimal | null;
  marketCap: bigint | null;
  fcf: bigint | null;
  eps: Prisma.Decimal | null;
  revenue: bigint | null;
  revenueGrowthYoy: Prisma.Decimal | null;
  roe: Prisma.Decimal | null;
  debtToEquity: Prisma.Decimal | null;
  ebitdaTtm: bigint | null;
  dilutedShares: bigint | null;
  totalDebt: bigint | null;
  cashAndEquivalents: bigint | null;
  totalEquity: bigint | null;
  epsGrowthYoy: Prisma.Decimal | null;
  roic: Prisma.Decimal | null;
  period: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FundamentalDataPoint {
  date: string; // ISO date string "YYYY-MM-DD"
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: number | null;       // TTM free cash flow in dollars (BigInt serialized to number)
  eps: number | null;
  ttmEps: number | null;    // trailing-twelve-month EPS; used by frontend to compute live P/E
  revenueGrowthYoy: number | null; // percentage
  roe: number | null;       // decimal e.g. 0.28 → returned as-is, frontend multiplies if needed
  debtToEquity: number | null;
  ebitdaTtm: number | null;        // TTM EBITDA in dollars
  dilutedShares: number | null;    // current quarter diluted share count
  totalDebt: number | null;        // current quarter total debt in dollars
  cashAndEquivalents: number | null; // current quarter cash and equivalents in dollars
  // current-quarter total stockholders' equity / book value, in dollars
  totalEquity: number | null;
  epsGrowthYoy: number | null;     // decimal fraction e.g. 0.15 = 15%
  roic: number | null;             // decimal fraction e.g. 0.18 = 18%
}

type Timeframe = '5Y' | '1Y' | 'YTD' | '1M' | '1W';

const FUNDAMENTAL_CACHE_TTL = 24 * 60 * 60; // 24 hours

// ============================================================================
// FundamentalService
// ============================================================================

export class FundamentalService {
  constructor(
    private fetcher: FundamentalFetcher,
    private cacheService: CacheService,
    private prisma: PrismaClient
  ) {}

  async getFundamentals(symbol: string, timeframe: string): Promise<FundamentalDataPoint[]> {
    const normalizedSymbol = symbol.toUpperCase().trim();
    // v4: payload now includes totalEquity (book value); bumping retires v3 entries
    // that lack this field.
    const cacheKey = `fundamental:history:v4:${normalizedSymbol}:${timeframe}`;

    // Layer 1: Cache (skip if all peRatios are null — prices may not have been ready yet)
    try {
      const cached = await this.cacheService.get<FundamentalDataPoint[]>(cacheKey);
      if (cached && cached.length > 0 && cached.some((r) => r.peRatio !== null)) {
        console.log(`[FundamentalService] Cache hit for ${normalizedSymbol}:${timeframe}`);
        return cached;
      }
    } catch (error) {
      console.warn('[FundamentalService] Cache read failed:', this.getErrorMessage(error));
    }

    // Layer 2: Database — fetch all rows for the symbol so TTM EPS can be
    // computed using the full history even when the display window is short.
    const { from, to } = this.calculateDateRange(timeframe);
    let dbRecords = await this.queryDatabase(normalizedSymbol);

    // Layer 3: Fetch from API if empty or if all existing records have null peRatio
    // (handles stale DB rows written before the v3 endpoint fix)
    const needsSync = dbRecords.length === 0 || dbRecords.every((r) => r.peRatio === null);
    if (needsSync) {
      console.log(`[FundamentalService] Fetching from API for ${normalizedSymbol} (no data or peRatio missing)`);
      try {
        const syncResult = await this.fetcher.syncFundamentals(normalizedSymbol);
        if (syncResult.errors.length > 0) {
          console.warn(
            `[FundamentalService] Sync errors for ${normalizedSymbol}:`,
            syncResult.errors
          );
        }
        // Re-query (may still be empty if API returned nothing due to plan tier)
        dbRecords = await this.queryDatabase(normalizedSymbol);
      } catch (error) {
        console.error(
          `[FundamentalService] Sync failed for ${normalizedSymbol}:`,
          this.getErrorMessage(error)
        );
      }
    }

    const result = this.convertToDataPoints(dbRecords, from, to);

    // Cache result; use short TTL if P/E is still missing so we retry once prices are loaded
    if (result.length > 0) {
      try {
        const hasPeRatio = result.some((r) => r.peRatio !== null);
        const ttl = hasPeRatio ? FUNDAMENTAL_CACHE_TTL : 60;
        await this.cacheService.set(cacheKey, result, ttl);
      } catch (error) {
        console.warn('[FundamentalService] Failed to cache data:', this.getErrorMessage(error));
      }
    }

    return result;
  }

  async refreshFundamentals(symbol: string): Promise<void> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    // Invalidate all cached timeframes
    try {
      const pattern = `fundamental:history:v4:${normalizedSymbol}:*`;
      // Use generic keys scan — CacheService exposes the client via the invalidateStock pattern
      // We'll just delete the known timeframes
      const timeframes: Timeframe[] = ['5Y', '1Y', 'YTD', '1M', '1W'];
      await Promise.all(
        timeframes.map((tf) =>
          this.cacheService.delete(`fundamental:history:v4:${normalizedSymbol}:${tf}`)
        )
      );
      void pattern; // suppress lint warning
    } catch (error) {
      console.warn('[FundamentalService] Cache invalidation failed:', this.getErrorMessage(error));
    }

    await this.fetcher.syncFundamentals(normalizedSymbol);
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async queryDatabase(symbol: string): Promise<FinancialRatioRow[]> {
    const rows = await this.prisma.financialRatio.findMany({
      where: { symbol },
      orderBy: { date: 'asc' },
    });
    return rows;
  }

  private convertToDataPoints(
    records: FinancialRatioRow[],
    from: Date,
    to: Date
  ): FundamentalDataPoint[] {
    // Compute TTM EPS over the full history (records are sorted asc), then
    // filter output to [from, to]. Using the full history ensures that points
    // at the recent edge of a short timeframe still have 4 prior quarters.
    return records
      .map((r, index) => {
        let ttmEps: number | null = null;
        const eps = r.eps != null ? Number(r.eps) : null;

        if (eps !== null) {
          let sum = eps;
          let quartersFound = 1;
          for (let i = 1; i <= 3 && index - i >= 0; i++) {
            const prior = records[index - i];
            if (prior.eps !== null) {
              sum += Number(prior.eps);
              quartersFound++;
            }
          }
          if (quartersFound === 4 && sum > 0) {
            ttmEps = sum;
          }
        }

        return {
          date: r.date.toISOString().split('T')[0],
          peRatio: r.peRatio != null ? Number(r.peRatio) : null,
          priceToFcf: r.priceToFcf != null ? Number(r.priceToFcf) : null,
          fcf: r.fcf != null ? Number(r.fcf) : null,
          eps,
          ttmEps,
          revenueGrowthYoy: r.revenueGrowthYoy != null ? Number(r.revenueGrowthYoy) : null,
          roe: r.roe != null ? Number(r.roe) : null,
          debtToEquity: r.debtToEquity != null ? Number(r.debtToEquity) : null,
          // BigInt→Number is safe for these fields: max value ~3.5e12 (share count × price) < 2^53
          ebitdaTtm: r.ebitdaTtm != null ? Number(r.ebitdaTtm) : null,
          dilutedShares: r.dilutedShares != null ? Number(r.dilutedShares) : null,
          totalDebt: r.totalDebt != null ? Number(r.totalDebt) : null,
          cashAndEquivalents: r.cashAndEquivalents != null ? Number(r.cashAndEquivalents) : null,
          totalEquity: r.totalEquity != null ? Number(r.totalEquity) : null,
          epsGrowthYoy: r.epsGrowthYoy != null ? Number(r.epsGrowthYoy) : null,
          roic: r.roic != null ? Number(r.roic) : null,
        };
      })
      .filter((dp) => {
        const d = new Date(dp.date);
        return d >= from && d <= to;
      });
  }

  private calculateDateRange(timeframe: string): { from: Date; to: Date } {
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    let from: Date;

    switch (timeframe.toUpperCase()) {
      case '5Y':
        from = subYears(today, 5);
        break;
      case '1Y':
        from = subDays(today, 365);
        break;
      case 'YTD':
        from = startOfYear(today);
        break;
      case '1M':
        from = subDays(today, 30);
        break;
      case '1W':
        from = subDays(today, 7);
        break;
      default:
        from = subYears(today, 5); // fundamentals default to 5Y (quarterly data)
    }

    const minFrom = subMonths(today, 6);
    if (from > minFrom) {
      from = minFrom;
    }

    return { from, to: today };
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createFundamentalService(
  prisma?: PrismaClient,
  cacheService?: CacheService,
  fetcher?: FundamentalFetcher
): FundamentalService {
  const prismaClient = prisma || new PrismaClient();
  const cache = cacheService || new CacheService();
  const fundamentalFetcher = fetcher || new FundamentalFetcher(prismaClient);

  return new FundamentalService(fundamentalFetcher, cache, prismaClient);
}

export default FundamentalService;
