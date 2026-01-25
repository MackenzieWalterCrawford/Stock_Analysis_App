import axios, { AxiosError } from 'axios';
import { PrismaClient } from '../generated/prisma';
import { format, parseISO } from 'date-fns';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** Raw historical price data from FMP API */
interface FMPHistoricalPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  vwap: number;
}

/** FMP API response structure */
interface FMPHistoricalResponse {
  symbol: string;
  historical: FMPHistoricalPrice[];
}

/** Validated and normalized price data for database storage */
interface NormalizedPriceData {
  symbol: string;
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

/** Result of a sync operation */
interface SyncResult {
  symbol: string;
  recordsFetched: number;
  recordsSaved: number;
  dateRange: {
    from: Date | null;
    to: Date | null;
  };
  errors: string[];
}

/** Custom error for API-related issues */
class DataFetcherError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'DataFetcherError';
  }
}

// ============================================================================
// DataFetcher Service
// ============================================================================

export class DataFetcher {
  private prisma: PrismaClient;
  private apiKey: string;
  private baseUrl: string;
  private batchSize: number;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
    this.apiKey = process.env.FMP_API_KEY || '';
    this.baseUrl = 'https://financialmodelingprep.com/stable';
    this.batchSize = 100; // Number of records to upsert in a single transaction

    if (!this.apiKey) {
      console.warn('[DataFetcher] Warning: FMP_API_KEY not set in environment variables');
    }
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * Fetch historical stock price data from FMP API
   * @param symbol - Stock ticker symbol (e.g., "AAPL")
   * @param from - Optional start date for filtering
   * @param to - Optional end date for filtering
   * @returns Array of historical price data
   */
  async fetchHistoricalData(
    symbol: string,
    from?: Date,
    to?: Date
  ): Promise<FMPHistoricalPrice[]> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    if (!normalizedSymbol) {
      throw new DataFetcherError('Symbol is required', 'INVALID_SYMBOL');
    }

    if (!this.apiKey) {
      throw new DataFetcherError('FMP API key not configured', 'NO_API_KEY');
    }

    // Build URL with optional date parameters (using stable API endpoint)
    let url = `${this.baseUrl}/historical-price-eod/full?symbol=${normalizedSymbol}&apikey=${this.apiKey}`;

    if (from) {
      url += `&from=${format(from, 'yyyy-MM-dd')}`;
    }
    if (to) {
      url += `&to=${format(to, 'yyyy-MM-dd')}`;
    }

    console.log(`[DataFetcher] Fetching historical data for ${normalizedSymbol}`);

    try {
      const response = await axios.get<FMPHistoricalPrice[] | FMPHistoricalResponse>(url, {
        timeout: 30000, // 30 second timeout
        headers: {
          'Accept': 'application/json',
        },
      });

      // Handle empty or invalid responses
      if (!response.data) {
        throw new DataFetcherError(
          `No data returned for symbol: ${normalizedSymbol}`,
          'EMPTY_RESPONSE'
        );
      }

      // Handle both API formats:
      // - Stable API returns: FMPHistoricalPrice[] (flat array)
      // - V3 API returns: { symbol, historical: FMPHistoricalPrice[] }
      let historicalData: FMPHistoricalPrice[];

      if (Array.isArray(response.data)) {
        // Stable API format - flat array
        historicalData = response.data;
      } else if (response.data.historical) {
        // V3 API format - object with historical property
        historicalData = response.data.historical;
      } else if ('Error Message' in response.data) {
        throw new DataFetcherError(
          `Invalid symbol or no historical data: ${normalizedSymbol}`,
          'INVALID_SYMBOL'
        );
      } else {
        throw new DataFetcherError(
          `Unexpected API response format for: ${normalizedSymbol}`,
          'INVALID_RESPONSE'
        );
      }

      if (historicalData.length === 0) {
        console.log(`[DataFetcher] No historical data available for ${normalizedSymbol}`);
        return [];
      }

      console.log(`[DataFetcher] Retrieved ${historicalData.length} records for ${normalizedSymbol}`);

      return historicalData;
    } catch (error) {
      if (error instanceof DataFetcherError) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        // Handle rate limiting
        if (axiosError.response?.status === 429) {
          throw new DataFetcherError(
            'API rate limit exceeded. FMP free tier allows 250 calls/day.',
            'RATE_LIMIT',
            429
          );
        }

        // Handle authentication errors
        if (axiosError.response?.status === 401 || axiosError.response?.status === 403) {
          throw new DataFetcherError(
            'Invalid API key or unauthorized access',
            'AUTH_ERROR',
            axiosError.response.status
          );
        }

        // Handle network errors
        if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND') {
          throw new DataFetcherError(
            'Unable to connect to FMP API. Check your network connection.',
            'NETWORK_ERROR'
          );
        }

        // Handle timeout
        if (axiosError.code === 'ECONNABORTED') {
          throw new DataFetcherError(
            'Request timed out while fetching data from FMP API',
            'TIMEOUT'
          );
        }

        throw new DataFetcherError(
          `API request failed: ${axiosError.message}`,
          'API_ERROR',
          axiosError.response?.status
        );
      }

      throw new DataFetcherError(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        'UNKNOWN_ERROR'
      );
    }
  }

  /**
   * Save historical price data to PostgreSQL using Prisma
   * Uses upsert to handle duplicates gracefully
   * @param symbol - Stock ticker symbol
   * @param data - Array of price data to save
   * @returns Number of records saved
   */
  async saveToDatabase(symbol: string, data: FMPHistoricalPrice[]): Promise<number> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    if (!data || data.length === 0) {
      console.log(`[DataFetcher] No data to save for ${normalizedSymbol}`);
      return 0;
    }

    // Validate and normalize data
    const validatedData = this.validateAndNormalize(normalizedSymbol, data);

    if (validatedData.length === 0) {
      console.log(`[DataFetcher] No valid records after validation for ${normalizedSymbol}`);
      return 0;
    }

    console.log(`[DataFetcher] Saving ${validatedData.length} records for ${normalizedSymbol}`);

    let savedCount = 0;

    // Process in batches for better performance
    for (let i = 0; i < validatedData.length; i += this.batchSize) {
      const batch = validatedData.slice(i, i + this.batchSize);

      try {
        // Use a transaction for each batch
        await this.prisma.$transaction(
          batch.map((record) =>
            this.prisma.stockPrice.upsert({
              where: {
                symbol_date: {
                  symbol: record.symbol,
                  date: record.date,
                },
              },
              update: {
                open: record.open,
                high: record.high,
                low: record.low,
                close: record.close,
                volume: record.volume,
                change: record.change,
                changePercent: record.changePercent,
                vwap: record.vwap,
              },
              create: {
                symbol: record.symbol,
                date: record.date,
                open: record.open,
                high: record.high,
                low: record.low,
                close: record.close,
                volume: record.volume,
                change: record.change,
                changePercent: record.changePercent,
                vwap: record.vwap,
              },
            })
          )
        );

        savedCount += batch.length;
        console.log(`[DataFetcher] Saved batch ${Math.floor(i / this.batchSize) + 1}: ${batch.length} records`);
      } catch (error) {
        console.error(`[DataFetcher] Error saving batch for ${normalizedSymbol}:`, error);
        throw new DataFetcherError(
          `Database error while saving data: ${error instanceof Error ? error.message : String(error)}`,
          'DATABASE_ERROR'
        );
      }
    }

    console.log(`[DataFetcher] Successfully saved ${savedCount} records for ${normalizedSymbol}`);
    return savedCount;
  }

  /**
   * Fetch and save historical data in one operation
   * @param symbol - Stock ticker symbol
   * @param from - Optional start date
   * @param to - Optional end date
   * @returns Sync result with statistics
   */
  async syncStock(symbol: string, from?: Date, to?: Date): Promise<SyncResult> {
    const normalizedSymbol = symbol.toUpperCase().trim();
    const errors: string[] = [];

    console.log(`[DataFetcher] Starting sync for ${normalizedSymbol}`);

    const result: SyncResult = {
      symbol: normalizedSymbol,
      recordsFetched: 0,
      recordsSaved: 0,
      dateRange: { from: null, to: null },
      errors: [],
    };

    try {
      // Fetch data from API
      const historicalData = await this.fetchHistoricalData(normalizedSymbol, from, to);
      result.recordsFetched = historicalData.length;

      if (historicalData.length > 0) {
        // Determine actual date range from fetched data
        const dates = historicalData.map((d) => parseISO(d.date));
        result.dateRange.from = new Date(Math.min(...dates.map((d) => d.getTime())));
        result.dateRange.to = new Date(Math.max(...dates.map((d) => d.getTime())));

        // Save to database
        result.recordsSaved = await this.saveToDatabase(normalizedSymbol, historicalData);
      }

      console.log(
        `[DataFetcher] Sync complete for ${normalizedSymbol}: ` +
        `${result.recordsFetched} fetched, ${result.recordsSaved} saved`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      console.error(`[DataFetcher] Sync failed for ${normalizedSymbol}:`, errorMessage);
    }

    result.errors = errors;
    return result;
  }

  /**
   * Get the most recent date for which we have stored data for a symbol
   * @param symbol - Stock ticker symbol
   * @returns The last stored date, or null if no data exists
   */
  async getLastStoredDate(symbol: string): Promise<Date | null> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    try {
      const lastRecord = await this.prisma.stockPrice.findFirst({
        where: { symbol: normalizedSymbol },
        orderBy: { date: 'desc' },
        select: { date: true },
      });

      if (lastRecord) {
        console.log(
          `[DataFetcher] Last stored date for ${normalizedSymbol}: ${format(lastRecord.date, 'yyyy-MM-dd')}`
        );
        return lastRecord.date;
      }

      console.log(`[DataFetcher] No stored data found for ${normalizedSymbol}`);
      return null;
    } catch (error) {
      console.error(`[DataFetcher] Error getting last stored date for ${normalizedSymbol}:`, error);
      throw new DataFetcherError(
        `Database error: ${error instanceof Error ? error.message : String(error)}`,
        'DATABASE_ERROR'
      );
    }
  }

  /**
   * Sync only new data (from last stored date to today)
   * @param symbol - Stock ticker symbol
   * @returns Sync result
   */
  async syncLatest(symbol: string): Promise<SyncResult> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    const lastDate = await this.getLastStoredDate(normalizedSymbol);

    // If we have data, fetch from the day after the last date
    // Otherwise, fetch all available data
    const fromDate = lastDate
      ? new Date(lastDate.getTime() + 24 * 60 * 60 * 1000) // Add one day
      : undefined;

    console.log(
      `[DataFetcher] Syncing latest data for ${normalizedSymbol}` +
      (fromDate ? ` from ${format(fromDate, 'yyyy-MM-dd')}` : ' (full sync)')
    );

    return this.syncStock(normalizedSymbol, fromDate);
  }

  /**
   * Sync multiple stocks
   * @param symbols - Array of stock ticker symbols
   * @param from - Optional start date
   * @param to - Optional end date
   * @returns Array of sync results
   */
  async syncMultiple(symbols: string[], from?: Date, to?: Date): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    for (const symbol of symbols) {
      try {
        const result = await this.syncStock(symbol, from, to);
        results.push(result);

        // Add a small delay between requests to avoid rate limiting
        await this.delay(200);
      } catch (error) {
        results.push({
          symbol: symbol.toUpperCase().trim(),
          recordsFetched: 0,
          recordsSaved: 0,
          dateRange: { from: null, to: null },
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }

    return results;
  }

  /**
   * Get the count of stored records for a symbol
   * @param symbol - Stock ticker symbol
   * @returns Number of records stored
   */
  async getStoredCount(symbol: string): Promise<number> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    return this.prisma.stockPrice.count({
      where: { symbol: normalizedSymbol },
    });
  }

  /**
   * Disconnect from the database
   * Call this when done using the DataFetcher
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
    console.log('[DataFetcher] Disconnected from database');
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Validate and normalize raw API data for database storage
   */
  private validateAndNormalize(
    symbol: string,
    data: FMPHistoricalPrice[]
  ): NormalizedPriceData[] {
    const normalized: NormalizedPriceData[] = [];

    for (const record of data) {
      try {
        // Validate required fields
        if (!record.date) {
          console.warn(`[DataFetcher] Skipping record with missing date for ${symbol}`);
          continue;
        }

        // Parse and validate date
        const date = parseISO(record.date);
        if (isNaN(date.getTime())) {
          console.warn(`[DataFetcher] Skipping record with invalid date: ${record.date}`);
          continue;
        }

        // Handle missing or null numeric fields with defaults
        const normalizedRecord: NormalizedPriceData = {
          symbol,
          date,
          open: this.validateNumber(record.open, 0),
          high: this.validateNumber(record.high, 0),
          low: this.validateNumber(record.low, 0),
          close: this.validateNumber(record.close, 0),
          volume: BigInt(Math.floor(this.validateNumber(record.volume, 0))),
          change: this.validateNumber(record.change, 0),
          changePercent: this.validateNumber(record.changePercent, 0),
          vwap: this.validateNumber(record.vwap, 0),
        };

        // Skip records where all price fields are zero (likely invalid data)
        if (
          normalizedRecord.open === 0 &&
          normalizedRecord.high === 0 &&
          normalizedRecord.low === 0 &&
          normalizedRecord.close === 0
        ) {
          console.warn(`[DataFetcher] Skipping record with all zero prices for ${symbol} on ${record.date}`);
          continue;
        }

        normalized.push(normalizedRecord);
      } catch (error) {
        console.warn(
          `[DataFetcher] Error normalizing record for ${symbol}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return normalized;
  }

  /**
   * Validate a number value, returning a default if invalid
   */
  private validateNumber(value: unknown, defaultValue: number): number {
    if (value === null || value === undefined) {
      return defaultValue;
    }
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
  }

  /**
   * Utility method for adding delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export types for external use
export { FMPHistoricalPrice, FMPHistoricalResponse, SyncResult, DataFetcherError };

// Export a default instance for convenience
export default DataFetcher;
