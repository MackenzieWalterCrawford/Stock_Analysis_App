import { PrismaClient, StockPrice as PrismaStockPrice } from '../generated/prisma';
import { Decimal } from '../generated/prisma/runtime/library';
import { startOfYear, subDays, subYears } from 'date-fns';
import { DataFetcher, SyncResult } from './dataFetcher';
import { CacheService } from './cache';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** Normalized stock price data for application use */
export interface StockPriceData {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  change: number;
  changePercent: number;
  vwap: number;
}

/** Price ratio data between two stocks */
export interface RatioData {
  date: Date;
  ratio: number;
  symbol1Price: number;
  symbol2Price: number;
}

/** Available date range for a stock */
export interface DateRange {
  earliest: Date;
  latest: Date;
}

/** Supported timeframe values */
export type Timeframe = '5Y' | '1Y' | 'YTD' | '1M' | '1W';

/** Valid timeframe values for validation */
const VALID_TIMEFRAMES: Timeframe[] = ['5Y', '1Y', 'YTD', '1M', '1W'];

/** Minimum expected trading days per timeframe (roughly) */
const MIN_TRADING_DAYS: Record<Timeframe, number> = {
  '5Y': 1000,  // ~5 years * 252 trading days, allow some gaps
  '1Y': 200,   // ~252 trading days minus holidays
  'YTD': 1,    // Variable based on time of year
  '1M': 15,    // ~22 trading days minus weekends
  '1W': 3,     // ~5 trading days minus weekends
};

/** Custom error for stock service operations */
export class StockServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly symbol?: string
  ) {
    super(message);
    this.name = 'StockServiceError';
  }
}

// ============================================================================
// StockService
// ============================================================================

export class StockService {
  /**
   * Create a new StockService instance
   * @param dataFetcher - DataFetcher instance for API calls
   * @param cacheService - CacheService instance for Redis caching
   * @param prisma - PrismaClient instance for database operations
   */
  constructor(
    private dataFetcher: DataFetcher,
    private cacheService: CacheService,
    private prisma: PrismaClient
  ) {}

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * Get historical stock price data for a symbol and timeframe
   * Uses three-layer architecture: Cache → Database → API
   * @param symbol - Stock ticker symbol (e.g., "AAPL")
   * @param timeframe - Data timeframe (5Y, 1Y, YTD, 1M, 1W)
   * @returns Array of stock price data sorted by date ascending
   */
  async getHistoricalData(symbol: string, timeframe: string): Promise<StockPriceData[]> {
    const normalizedSymbol = symbol.toUpperCase().trim();
    const normalizedTimeframe = timeframe.toUpperCase() as Timeframe;

    if (!this.isValidTimeframe(normalizedTimeframe)) {
      throw new StockServiceError(
        `Invalid timeframe: ${timeframe}. Valid values: ${VALID_TIMEFRAMES.join(', ')}`,
        'INVALID_TIMEFRAME',
        normalizedSymbol
      );
    }

    // Layer 1: Check cache first
    try {
      const cached = await this.cacheService.getStockHistory<StockPriceData[]>(
        normalizedSymbol,
        normalizedTimeframe
      );

      if (cached && cached.length > 0) {
        console.log(`[StockService] Cache hit for ${normalizedSymbol}:${normalizedTimeframe}`);
        // Convert date strings back to Date objects (JSON serialization issue)
        return this.rehydrateDates(cached);
      }
    } catch (error) {
      console.warn('[StockService] Cache read failed, continuing to database:', this.getErrorMessage(error));
    }

    console.log(`[StockService] Cache miss for ${normalizedSymbol}:${normalizedTimeframe}`);

    // Layer 2: Query database
    const { from, to } = this.calculateDateRange(normalizedTimeframe);
    let dbData = await this.queryDatabase(normalizedSymbol, from, to);

    // Layer 3: Check if we need to fetch from API
    if (await this.needsDataRefresh(normalizedSymbol, normalizedTimeframe, dbData)) {
      console.log(`[StockService] Fetching fresh data for ${normalizedSymbol} from API`);

      try {
        const syncResult = await this.dataFetcher.syncStock(normalizedSymbol, from, to);

        if (syncResult.errors.length === 0 && syncResult.recordsSaved > 0) {
          // Re-query database after sync
          dbData = await this.queryDatabase(normalizedSymbol, from, to);
        } else if (syncResult.errors.length > 0) {
          console.warn(`[StockService] API sync had errors for ${normalizedSymbol}:`, syncResult.errors);
        }
      } catch (error) {
        console.error(`[StockService] API fetch failed for ${normalizedSymbol}:`, this.getErrorMessage(error));
        // Continue with whatever data we have from DB
      }
    }

    // Convert Prisma data to application format
    const result = this.convertPrismaToStockPriceData(dbData);

    // Cache the result if we have data
    if (result.length > 0) {
      try {
        await this.cacheService.setStockHistory(
          normalizedSymbol,
          normalizedTimeframe,
          this.prepareForCache(result)
        );
      } catch (error) {
        console.warn('[StockService] Failed to cache data:', this.getErrorMessage(error));
      }
    }

    return result;
  }

  /**
   * Calculate price ratio between two stocks over a timeframe
   * @param symbol1 - First stock ticker symbol
   * @param symbol2 - Second stock ticker symbol
   * @param timeframe - Data timeframe
   * @returns Array of ratio data for matching dates
   */
  async getPriceRatio(symbol1: string, symbol2: string, timeframe: string): Promise<RatioData[]> {
    const sym1 = symbol1.toUpperCase().trim();
    const sym2 = symbol2.toUpperCase().trim();
    const normalizedTimeframe = timeframe.toUpperCase();

    // Check cache first
    try {
      const cached = await this.cacheService.getPriceRatio<RatioData[]>(sym1, sym2, normalizedTimeframe);

      if (cached && cached.length > 0) {
        console.log(`[StockService] Cache hit for ratio ${sym1}/${sym2}:${normalizedTimeframe}`);
        return this.rehydrateDates(cached);
      }
    } catch (error) {
      console.warn('[StockService] Cache read failed for ratio:', this.getErrorMessage(error));
    }

    console.log(`[StockService] Calculating ratio for ${sym1}/${sym2}:${normalizedTimeframe}`);

    // Fetch historical data for both symbols
    const [data1, data2] = await Promise.all([
      this.getHistoricalData(sym1, normalizedTimeframe),
      this.getHistoricalData(sym2, normalizedTimeframe),
    ]);

    if (data1.length === 0) {
      throw new StockServiceError(
        `No data available for symbol: ${sym1}`,
        'NO_DATA',
        sym1
      );
    }

    if (data2.length === 0) {
      throw new StockServiceError(
        `No data available for symbol: ${sym2}`,
        'NO_DATA',
        sym2
      );
    }

    // Create a map for faster date matching
    const data2Map = new Map<string, StockPriceData>();
    for (const item of data2) {
      const dateKey = this.getDateKey(item.date);
      data2Map.set(dateKey, item);
    }

    // Calculate ratios for matching dates
    const ratios: RatioData[] = [];

    for (const item1 of data1) {
      const dateKey = this.getDateKey(item1.date);
      const item2 = data2Map.get(dateKey);

      if (item2 && item2.close !== 0) {
        ratios.push({
          date: item1.date,
          ratio: item1.close / item2.close,
          symbol1Price: item1.close,
          symbol2Price: item2.close,
        });
      }
    }

    // Sort by date ascending
    ratios.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Cache the result
    if (ratios.length > 0) {
      try {
        await this.cacheService.setPriceRatio(sym1, sym2, normalizedTimeframe, ratios);
      } catch (error) {
        console.warn('[StockService] Failed to cache ratio data:', this.getErrorMessage(error));
      }
    }

    return ratios;
  }

  /**
   * Force refresh data from API for a symbol
   * Invalidates cache and updates database
   * @param symbol - Stock ticker symbol
   * @returns Sync result with statistics
   */
  async refreshData(symbol: string): Promise<SyncResult> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    console.log(`[StockService] Force refreshing data for ${normalizedSymbol}`);

    // Invalidate cache first
    try {
      await this.cacheService.invalidateStock(normalizedSymbol);
    } catch (error) {
      console.warn('[StockService] Failed to invalidate cache:', this.getErrorMessage(error));
    }

    // Fetch and save fresh data from API
    const result = await this.dataFetcher.syncStock(normalizedSymbol);

    if (result.errors.length > 0) {
      console.error(`[StockService] Refresh errors for ${normalizedSymbol}:`, result.errors);
    } else {
      console.log(
        `[StockService] Refreshed ${normalizedSymbol}: ` +
        `${result.recordsFetched} fetched, ${result.recordsSaved} saved`
      );
    }

    return result;
  }

  /**
   * Get the available date range for a symbol in the database
   * @param symbol - Stock ticker symbol
   * @returns Date range object or null if no data exists
   */
  async getAvailableDateRange(symbol: string): Promise<DateRange | null> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    try {
      const [earliest, latest] = await Promise.all([
        this.prisma.stockPrice.findFirst({
          where: { symbol: normalizedSymbol },
          orderBy: { date: 'asc' },
          select: { date: true },
        }),
        this.prisma.stockPrice.findFirst({
          where: { symbol: normalizedSymbol },
          orderBy: { date: 'desc' },
          select: { date: true },
        }),
      ]);

      if (!earliest || !latest) {
        return null;
      }

      return {
        earliest: earliest.date,
        latest: latest.date,
      };
    } catch (error) {
      console.error(`[StockService] Error getting date range for ${normalizedSymbol}:`, this.getErrorMessage(error));
      throw new StockServiceError(
        `Failed to get date range: ${this.getErrorMessage(error)}`,
        'DATABASE_ERROR',
        normalizedSymbol
      );
    }
  }

  /**
   * Get multiple symbols' historical data in parallel
   * @param symbols - Array of stock ticker symbols
   * @param timeframe - Data timeframe
   * @returns Map of symbol to price data
   */
  async getMultipleHistoricalData(
    symbols: string[],
    timeframe: string
  ): Promise<Map<string, StockPriceData[]>> {
    const results = new Map<string, StockPriceData[]>();

    const promises = symbols.map(async (symbol) => {
      try {
        const data = await this.getHistoricalData(symbol, timeframe);
        return { symbol: symbol.toUpperCase(), data };
      } catch (error) {
        console.error(`[StockService] Error fetching ${symbol}:`, this.getErrorMessage(error));
        return { symbol: symbol.toUpperCase(), data: [] };
      }
    });

    const resolved = await Promise.all(promises);

    for (const { symbol, data } of resolved) {
      results.set(symbol, data);
    }

    return results;
  }

  /**
   * Warm up cache for popular symbols
   * @param symbols - Array of stock ticker symbols to cache
   * @param timeframes - Array of timeframes to cache (default: ['1Y', '1M', '1W'])
   */
  async warmupCache(
    symbols: string[],
    timeframes: Timeframe[] = ['1Y', '1M', '1W']
  ): Promise<void> {
    console.log(`[StockService] Warming up cache for ${symbols.length} symbols`);

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        try {
          await this.getHistoricalData(symbol, timeframe);
          console.log(`[StockService] Cached ${symbol}:${timeframe}`);
        } catch (error) {
          console.warn(`[StockService] Failed to warm up ${symbol}:${timeframe}:`, this.getErrorMessage(error));
        }
      }
    }

    console.log('[StockService] Cache warmup complete');
  }

  /**
   * Get the count of stored records for a symbol
   * @param symbol - Stock ticker symbol
   * @returns Number of records in database
   */
  async getRecordCount(symbol: string): Promise<number> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    return this.prisma.stockPrice.count({
      where: { symbol: normalizedSymbol },
    });
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Calculate date range for a timeframe
   * @param timeframe - Timeframe string
   * @returns Object with from and to dates
   */
  calculateDateRange(timeframe: string): { from: Date; to: Date } {
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
        from = subDays(today, 365); // Default to 1Y
    }

    return { from, to: today };
  }

  /**
   * Check if a timeframe value is valid
   * @param timeframe - Timeframe string to validate
   * @returns true if valid, false otherwise
   */
  isValidTimeframe(timeframe: string): timeframe is Timeframe {
    return VALID_TIMEFRAMES.includes(timeframe.toUpperCase() as Timeframe);
  }

  /**
   * Check if data needs to be refreshed from API
   * @param symbol - Stock ticker symbol
   * @param timeframe - Requested timeframe
   * @param existingData - Data already retrieved from database
   * @returns true if refresh is needed
   */
  async needsDataRefresh(
    symbol: string,
    timeframe: string,
    existingData: PrismaStockPrice[]
  ): Promise<boolean> {
    const tf = timeframe.toUpperCase() as Timeframe;

    // If we have no data at all, we need to refresh
    if (existingData.length === 0) {
      return true;
    }

    // Check if we have minimum expected data points
    const minDays = MIN_TRADING_DAYS[tf] || 1;

    // For YTD, calculate expected days based on current date
    if (tf === 'YTD') {
      const now = new Date();
      const startOfYr = startOfYear(now);
      const daysSinceYearStart = Math.floor(
        (now.getTime() - startOfYr.getTime()) / (1000 * 60 * 60 * 24)
      );
      // Rough estimate: ~70% of days are trading days
      const expectedTradingDays = Math.floor(daysSinceYearStart * 0.7);

      if (existingData.length < Math.max(1, expectedTradingDays * 0.8)) {
        return true;
      }
    } else if (existingData.length < minDays * 0.8) {
      // Allow 20% gap tolerance
      return true;
    }

    // Check if the latest data is recent enough
    const latestDate = existingData.reduce(
      (max, item) => (item.date > max ? item.date : max),
      existingData[0].date
    );

    const now = new Date();
    const daysSinceLatest = Math.floor(
      (now.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    // If data is more than 3 days old (accounting for weekends), refresh
    // For weekdays, we'd want fresher data
    if (daysSinceLatest > 3) {
      return true;
    }

    return false;
  }

  /**
   * Convert Prisma StockPrice records to application StockPriceData format
   * @param prismaData - Array of Prisma StockPrice records
   * @returns Array of StockPriceData objects
   */
  convertPrismaToStockPriceData(prismaData: PrismaStockPrice[]): StockPriceData[] {
    return prismaData.map((item) => ({
      date: item.date,
      open: this.decimalToNumber(item.open),
      high: this.decimalToNumber(item.high),
      low: this.decimalToNumber(item.low),
      close: this.decimalToNumber(item.close),
      volume: item.volume,
      change: this.decimalToNumber(item.change),
      changePercent: this.decimalToNumber(item.changePercent),
      vwap: this.decimalToNumber(item.vwap),
    }));
  }

  /**
   * Merge and deduplicate stock price data arrays
   * @param oldData - Existing data
   * @param newData - New data to merge
   * @returns Merged and deduplicated array sorted by date
   */
  mergeAndDeduplicate(oldData: StockPriceData[], newData: StockPriceData[]): StockPriceData[] {
    const dateMap = new Map<string, StockPriceData>();

    // Add old data first
    for (const item of oldData) {
      const key = this.getDateKey(item.date);
      dateMap.set(key, item);
    }

    // New data overwrites old data for same dates
    for (const item of newData) {
      const key = this.getDateKey(item.date);
      dateMap.set(key, item);
    }

    // Convert back to array and sort
    const merged = Array.from(dateMap.values());
    merged.sort((a, b) => a.date.getTime() - b.date.getTime());

    return merged;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Query database for stock prices in a date range
   */
  private async queryDatabase(
    symbol: string,
    from: Date,
    to: Date
  ): Promise<PrismaStockPrice[]> {
    try {
      return await this.prisma.stockPrice.findMany({
        where: {
          symbol: symbol,
          date: {
            gte: from,
            lte: to,
          },
        },
        orderBy: { date: 'asc' },
      });
    } catch (error) {
      console.error(`[StockService] Database query failed for ${symbol}:`, this.getErrorMessage(error));
      throw new StockServiceError(
        `Database query failed: ${this.getErrorMessage(error)}`,
        'DATABASE_ERROR',
        symbol
      );
    }
  }

  /**
   * Convert Prisma Decimal to JavaScript number
   */
  private decimalToNumber(decimal: Decimal): number {
    return decimal.toNumber();
  }

  /**
   * Get a consistent date key for map lookups (YYYY-MM-DD format)
   */
  private getDateKey(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  /**
   * Rehydrate dates and BigInts from cached JSON data
   * JSON.parse converts dates to strings and BigInts need special handling
   */
  private rehydrateDates<T extends { date: Date | string; volume?: bigint | string }>(data: T[]): T[] {
    return data.map((item) => ({
      ...item,
      date: typeof item.date === 'string' ? new Date(item.date) : item.date,
      volume: typeof item.volume === 'string' ? BigInt(item.volume) : item.volume,
    }));
  }

  /**
   * Prepare data for JSON serialization (convert BigInt to string)
   */
  private prepareForCache(data: StockPriceData[]): Array<Omit<StockPriceData, 'volume'> & { volume: string }> {
    return data.map((item) => ({
      ...item,
      volume: item.volume.toString(),
    }));
  }

  /**
   * Extract error message from unknown error type
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a StockService instance with default dependencies
 * @param prisma - Optional PrismaClient (creates new one if not provided)
 * @param cacheService - Optional CacheService (creates new one if not provided)
 * @param dataFetcher - Optional DataFetcher (creates new one if not provided)
 * @returns Configured StockService instance
 */
export function createStockService(
  prisma?: PrismaClient,
  cacheService?: CacheService,
  dataFetcher?: DataFetcher
): StockService {
  const prismaClient = prisma || new PrismaClient();
  const cache = cacheService || new CacheService();
  const fetcher = dataFetcher || new DataFetcher(prismaClient);

  return new StockService(fetcher, cache, prismaClient);
}

// Export types and class
export default StockService;
