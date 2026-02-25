import axios, { AxiosError } from 'axios';
import { PrismaClient } from '../generated/prisma';
import { parseISO } from 'date-fns';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface FMPKeyMetric {
  date: string;
  symbol: string;
  peRatio: number | null;
  priceToFreeCashFlowRatio: number | null;
  freeCashFlow: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
}

interface FMPIncomeStatement {
  date: string;
  symbol: string;
  revenue: number | null;
  eps: number | null;
  epsDiluted: number | null;
  period: string | null;
}

export interface FundamentalRecord {
  symbol: string;
  date: Date;
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: bigint | null;
  eps: number | null;
  revenue: bigint | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
  period: string | null;
}

export interface FundamentalSyncResult {
  symbol: string;
  recordsFetched: number;
  recordsSaved: number;
  errors: string[];
}

class FundamentalFetcherError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'FundamentalFetcherError';
  }
}

// ============================================================================
// FundamentalFetcher Service
// ============================================================================

export class FundamentalFetcher {
  private prisma: PrismaClient;
  private apiKey: string;
  private baseUrl: string;
  private batchSize: number;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
    this.apiKey = process.env.FMP_API_KEY || '';
    this.baseUrl = 'https://financialmodelingprep.com/stable';
    this.batchSize = 40;

    if (!this.apiKey) {
      console.warn('[FundamentalFetcher] Warning: FMP_API_KEY not set');
    }
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async syncFundamentals(symbol: string): Promise<FundamentalSyncResult> {
    const normalizedSymbol = symbol.toUpperCase().trim();
    const errors: string[] = [];

    console.log(`[FundamentalFetcher] Starting sync for ${normalizedSymbol}`);

    const result: FundamentalSyncResult = {
      symbol: normalizedSymbol,
      recordsFetched: 0,
      recordsSaved: 0,
      errors: [],
    };

    try {
      const [keyMetrics, incomeData] = await Promise.all([
        this.fetchKeyMetrics(normalizedSymbol),
        this.fetchIncomeStatement(normalizedSymbol),
      ]);

      const merged = this.mergeFundamentals(normalizedSymbol, keyMetrics, incomeData);
      const withGrowth = this.calculateRevenueGrowthYoy(merged);

      result.recordsFetched = withGrowth.length;

      if (withGrowth.length > 0) {
        result.recordsSaved = await this.saveToDatabase(normalizedSymbol, withGrowth);
      }

      console.log(
        `[FundamentalFetcher] Sync complete for ${normalizedSymbol}: ` +
        `${result.recordsFetched} fetched, ${result.recordsSaved} saved`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(msg);
      console.error(`[FundamentalFetcher] Sync failed for ${normalizedSymbol}:`, msg);
    }

    result.errors = errors;
    return result;
  }

  // --------------------------------------------------------------------------
  // Private: API Fetchers
  // --------------------------------------------------------------------------

  private async fetchKeyMetrics(symbol: string): Promise<FMPKeyMetric[]> {
    if (!this.apiKey) {
      throw new FundamentalFetcherError('FMP API key not configured', 'NO_API_KEY');
    }

    const url =
      `${this.baseUrl}/key-metrics?symbol=${symbol}&period=quarter&limit=40&apikey=${this.apiKey}`;

    console.log(`[FundamentalFetcher] Fetching key metrics for ${symbol}`);

    try {
      const response = await axios.get<FMPKeyMetric[]>(url, {
        timeout: 30000,
        headers: { Accept: 'application/json' },
      });

      if (!response.data || !Array.isArray(response.data)) {
        console.warn(`[FundamentalFetcher] No key metrics data for ${symbol}`);
        return [];
      }

      console.log(`[FundamentalFetcher] Got ${response.data.length} key metric records for ${symbol}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 402 || axiosError.response?.status === 403) {
          console.warn(
            `[FundamentalFetcher] Key metrics endpoint requires paid FMP plan (HTTP ${axiosError.response.status})`
          );
          return [];
        }
        if (axiosError.response?.status === 429) {
          throw new FundamentalFetcherError('API rate limit exceeded', 'RATE_LIMIT', 429);
        }
      }
      throw new FundamentalFetcherError(
        `Failed to fetch key metrics: ${error instanceof Error ? error.message : String(error)}`,
        'API_ERROR'
      );
    }
  }

  private async fetchIncomeStatement(symbol: string): Promise<FMPIncomeStatement[]> {
    if (!this.apiKey) {
      throw new FundamentalFetcherError('FMP API key not configured', 'NO_API_KEY');
    }

    const url =
      `${this.baseUrl}/income-statement?symbol=${symbol}&period=quarter&limit=40&apikey=${this.apiKey}`;

    console.log(`[FundamentalFetcher] Fetching income statement for ${symbol}`);

    try {
      const response = await axios.get<FMPIncomeStatement[]>(url, {
        timeout: 30000,
        headers: { Accept: 'application/json' },
      });

      if (!response.data || !Array.isArray(response.data)) {
        console.warn(`[FundamentalFetcher] No income statement data for ${symbol}`);
        return [];
      }

      console.log(
        `[FundamentalFetcher] Got ${response.data.length} income statement records for ${symbol}`
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 402 || axiosError.response?.status === 403) {
          console.warn(
            `[FundamentalFetcher] Income statement endpoint requires paid FMP plan (HTTP ${axiosError.response.status})`
          );
          return [];
        }
        if (axiosError.response?.status === 429) {
          throw new FundamentalFetcherError('API rate limit exceeded', 'RATE_LIMIT', 429);
        }
      }
      throw new FundamentalFetcherError(
        `Failed to fetch income statement: ${error instanceof Error ? error.message : String(error)}`,
        'API_ERROR'
      );
    }
  }

  // --------------------------------------------------------------------------
  // Private: Data Processing
  // --------------------------------------------------------------------------

  private mergeFundamentals(
    symbol: string,
    keyMetrics: FMPKeyMetric[],
    incomeData: FMPIncomeStatement[]
  ): FundamentalRecord[] {
    // Build income map keyed by date string
    const incomeMap = new Map<string, FMPIncomeStatement>();
    for (const item of incomeData) {
      if (item.date) {
        incomeMap.set(item.date, item);
      }
    }

    const records: FundamentalRecord[] = [];

    // Use key metrics as the primary source; join income data by date
    for (const km of keyMetrics) {
      if (!km.date) continue;

      let parsedDate: Date;
      try {
        parsedDate = parseISO(km.date);
        if (isNaN(parsedDate.getTime())) continue;
      } catch {
        continue;
      }

      const income = incomeMap.get(km.date);

      const revenue =
        income?.revenue != null
          ? BigInt(Math.round(income.revenue))
          : null;

      const fcf =
        km.freeCashFlow != null
          ? BigInt(Math.round(km.freeCashFlow))
          : null;

      const eps = income?.epsDiluted ?? income?.eps ?? null;

      records.push({
        symbol,
        date: parsedDate,
        peRatio: km.peRatio ?? null,
        priceToFcf: km.priceToFreeCashFlowRatio ?? null,
        fcf,
        eps,
        revenue,
        revenueGrowthYoy: null, // filled in calculateRevenueGrowthYoy
        roe: km.returnOnEquity ?? null,
        debtToEquity: km.debtToEquity ?? null,
        period: income?.period ?? null,
      });
    }

    // If we only have income data (no key metrics), include those records too
    if (keyMetrics.length === 0 && incomeData.length > 0) {
      for (const inc of incomeData) {
        if (!inc.date) continue;
        let parsedDate: Date;
        try {
          parsedDate = parseISO(inc.date);
          if (isNaN(parsedDate.getTime())) continue;
        } catch {
          continue;
        }
        records.push({
          symbol,
          date: parsedDate,
          peRatio: null,
          priceToFcf: null,
          fcf: null,
          eps: inc.epsDiluted ?? inc.eps ?? null,
          revenue: inc.revenue != null ? BigInt(Math.round(inc.revenue)) : null,
          revenueGrowthYoy: null,
          roe: null,
          debtToEquity: null,
          period: inc.period ?? null,
        });
      }
    }

    // Sort ascending by date for growth calculation
    records.sort((a, b) => a.date.getTime() - b.date.getTime());

    return records;
  }

  private calculateRevenueGrowthYoy(records: FundamentalRecord[]): FundamentalRecord[] {
    return records.map((record, index) => {
      // Find the same quarter 4 entries ago (1 year back)
      const priorIndex = index - 4;
      if (priorIndex < 0) {
        return record;
      }

      const prior = records[priorIndex];
      if (
        prior.revenue == null ||
        record.revenue == null ||
        prior.revenue === 0n
      ) {
        return record;
      }

      const current = Number(record.revenue);
      const previous = Number(prior.revenue);
      const growth = ((current - previous) / Math.abs(previous)) * 100;

      return { ...record, revenueGrowthYoy: growth };
    });
  }

  private async saveToDatabase(
    symbol: string,
    records: FundamentalRecord[]
  ): Promise<number> {
    let savedCount = 0;

    for (let i = 0; i < records.length; i += this.batchSize) {
      const batch = records.slice(i, i + this.batchSize);

      try {
        await this.prisma.$transaction(
          batch.map((record) =>
            this.prisma.financialRatio.upsert({
              where: {
                symbol_date: {
                  symbol: record.symbol,
                  date: record.date,
                },
              },
              update: {
                peRatio: record.peRatio,
                priceToFcf: record.priceToFcf,
                fcf: record.fcf,
                eps: record.eps,
                revenue: record.revenue,
                revenueGrowthYoy: record.revenueGrowthYoy,
                roe: record.roe,
                debtToEquity: record.debtToEquity,
                period: record.period,
              },
              create: {
                symbol: record.symbol,
                date: record.date,
                peRatio: record.peRatio,
                priceToFcf: record.priceToFcf,
                fcf: record.fcf,
                eps: record.eps,
                revenue: record.revenue,
                revenueGrowthYoy: record.revenueGrowthYoy,
                roe: record.roe,
                debtToEquity: record.debtToEquity,
                period: record.period,
              },
            })
          )
        );

        savedCount += batch.length;
        console.log(
          `[FundamentalFetcher] Saved batch ${Math.floor(i / this.batchSize) + 1} for ${symbol}`
        );
      } catch (error) {
        console.error(
          `[FundamentalFetcher] Error saving batch for ${symbol}:`,
          error instanceof Error ? error.message : String(error)
        );
        throw new FundamentalFetcherError(
          `Database error: ${error instanceof Error ? error.message : String(error)}`,
          'DATABASE_ERROR'
        );
      }
    }

    return savedCount;
  }

  async getLastStoredDate(symbol: string): Promise<Date | null> {
    const normalizedSymbol = symbol.toUpperCase().trim();

    try {
      const last = await this.prisma.financialRatio.findFirst({
        where: { symbol: normalizedSymbol },
        orderBy: { date: 'desc' },
        select: { date: true },
      });

      return last?.date ?? null;
    } catch {
      return null;
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export { FundamentalFetcherError };
export default FundamentalFetcher;
