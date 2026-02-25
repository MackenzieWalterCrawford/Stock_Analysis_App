import { PrismaClient } from '../generated/prisma';
import { startOfYear, subDays, subYears } from 'date-fns';
import { CacheService } from './cache';
import { FundamentalFetcher } from './fundamentalFetcher';

// ============================================================================
// Types
// ============================================================================

export interface FundamentalDataPoint {
  date: string; // ISO date string "YYYY-MM-DD"
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: number | null;       // raw value in dollars (BigInt serialized to number)
  eps: number | null;
  revenueGrowthYoy: number | null; // percentage
  roe: number | null;       // decimal e.g. 0.28 → returned as-is, frontend multiplies if needed
  debtToEquity: number | null;
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
    const cacheKey = `fundamental:history:${normalizedSymbol}:${timeframe}`;

    // Layer 1: Cache
    try {
      const cached = await this.cacheService.get<FundamentalDataPoint[]>(cacheKey);
      if (cached && cached.length > 0) {
        console.log(`[FundamentalService] Cache hit for ${normalizedSymbol}:${timeframe}`);
        return cached;
      }
    } catch (error) {
      console.warn('[FundamentalService] Cache read failed:', this.getErrorMessage(error));
    }

    // Layer 2: Database
    const { from, to } = this.calculateDateRange(timeframe);
    let dbRecords = await this.queryDatabase(normalizedSymbol, from, to);

    // Layer 3: Fetch from API if empty
    if (dbRecords.length === 0) {
      console.log(`[FundamentalService] No DB data for ${normalizedSymbol}, fetching from API`);
      try {
        const syncResult = await this.fetcher.syncFundamentals(normalizedSymbol);
        if (syncResult.errors.length > 0) {
          console.warn(
            `[FundamentalService] Sync errors for ${normalizedSymbol}:`,
            syncResult.errors
          );
        }
        // Re-query (may still be empty if API returned nothing due to plan tier)
        dbRecords = await this.queryDatabase(normalizedSymbol, from, to);
      } catch (error) {
        console.error(
          `[FundamentalService] Sync failed for ${normalizedSymbol}:`,
          this.getErrorMessage(error)
        );
      }
    }

    const result = this.convertToDataPoints(dbRecords);

    // Cache result (even empty, to avoid hammering API)
    if (result.length > 0) {
      try {
        await this.cacheService.set(cacheKey, result, FUNDAMENTAL_CACHE_TTL);
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
      const pattern = `fundamental:history:${normalizedSymbol}:*`;
      // Use generic keys scan — CacheService exposes the client via the invalidateStock pattern
      // We'll just delete the known timeframes
      const timeframes: Timeframe[] = ['5Y', '1Y', 'YTD', '1M', '1W'];
      await Promise.all(
        timeframes.map((tf) =>
          this.cacheService.delete(`fundamental:history:${normalizedSymbol}:${tf}`)
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

  private async queryDatabase(
    symbol: string,
    from: Date,
    to: Date
  ) {
    return this.prisma.financialRatio.findMany({
      where: {
        symbol,
        date: { gte: from, lte: to },
      },
      orderBy: { date: 'asc' },
    });
  }

  private convertToDataPoints(
    records: Awaited<ReturnType<typeof this.queryDatabase>>
  ): FundamentalDataPoint[] {
    return records.map((r) => ({
      date: r.date.toISOString().split('T')[0],
      peRatio: r.peRatio != null ? Number(r.peRatio) : null,
      priceToFcf: r.priceToFcf != null ? Number(r.priceToFcf) : null,
      fcf: r.fcf != null ? Number(r.fcf) : null,
      eps: r.eps != null ? Number(r.eps) : null,
      revenueGrowthYoy: r.revenueGrowthYoy != null ? Number(r.revenueGrowthYoy) : null,
      roe: r.roe != null ? Number(r.roe) : null,
      debtToEquity: r.debtToEquity != null ? Number(r.debtToEquity) : null,
    }));
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
