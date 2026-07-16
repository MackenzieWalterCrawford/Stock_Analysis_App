import axios, { AxiosError } from 'axios';
import { PrismaClient } from '../generated/prisma';
import { parseISO } from 'date-fns';
import SecEdgarFetcher, { QuarterlyEpsRecord, QuarterlyFinancialRecord } from './secEdgarFetcher';

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
  // FMP returns this field as all-lowercase; "epsDiluted" silently reads undefined
  epsdiluted: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization: number | null;
  ebitda: number | null;
  incomeTaxExpense: number | null;
  incomeBeforeTax: number | null;
  netIncome: number | null;
  weightedAverageShsOutDil: number | null;
  period: string | null;
  cik?: string;
}

interface FMPCashFlowStatement {
  date: string;
  symbol: string;
  operatingCashFlow: number | null;
  // FMP returns capitalExpenditure as a negative number
  capitalExpenditure: number | null;
  freeCashFlow: number | null;
}

interface FMPBalanceSheet {
  date: string;
  symbol: string;
  totalDebt: number | null;
  totalStockholdersEquity: number | null;
  cashAndCashEquivalents: number | null;
}

// Per-quarter raw values assembled from all three statement types; used
// as a parallel array to FundamentalRecord[] for the TTM rolling windows.
interface QuarterlyRaw {
  revenue: number | null;
  eps: number | null;
  epsdiluted: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization: number | null;
  ebitda: number | null;
  incomeTaxExpense: number | null;
  incomeBeforeTax: number | null;
  freeCashFlow: number | null;
  totalDebt: number | null;
  totalStockholdersEquity: number | null;
  cashAndCashEquivalents: number | null;
  weightedAverageShsOutDil: number | null;
}

export interface FundamentalRecord {
  symbol: string;
  date: Date;
  peRatio: number | null;
  priceToFcf: number | null;
  fcf: bigint | null;           // TTM free cash flow
  eps: number | null;
  revenue: bigint | null;
  revenueGrowthYoy: number | null;
  roe: number | null;
  debtToEquity: number | null;
  ebitdaTtm: bigint | null;
  dilutedShares: bigint | null;
  totalDebt: bigint | null;
  cashAndEquivalents: bigint | null;
  totalEquity: bigint | null;
  epsGrowthYoy: number | null;  // decimal fraction e.g. 0.15 = 15%
  roic: number | null;          // decimal fraction e.g. 0.18 = 18%
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
  private secEdgar: SecEdgarFetcher;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
    this.apiKey = process.env.FMP_API_KEY || '';
    this.baseUrl = 'https://financialmodelingprep.com/stable';
    this.batchSize = 40;
    this.secEdgar = new SecEdgarFetcher();

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
      const [keyMetrics, incomeData, cashFlowData, balanceSheetData] = await Promise.all([
        this.fetchKeyMetrics(normalizedSymbol),
        this.fetchIncomeStatement(normalizedSymbol),
        this.fetchCashFlowStatement(normalizedSymbol),
        this.fetchBalanceSheet(normalizedSymbol),
      ]);

      const { records: merged, rawQuarters } = this.mergeFundamentals(
        normalizedSymbol,
        keyMetrics,
        incomeData,
        cashFlowData,
        balanceSheetData
      );

      // Resolve CIK (FMP income statements carry it; on the free tier those are
      // empty/402, so fall back to SEC's ticker→CIK map).
      let cik = incomeData.find((d) => d.cik)?.cik ?? null;
      if (cik === null) {
        cik = await this.secEdgar.resolveCik(normalizedSymbol);
      }

      // Free-tier fallback: when FMP returns no statement data (all 402), source
      // the full quarterly financial series from SEC EDGAR company-facts so the
      // TTM ratios (EV/EBITDA, ROIC, Debt-to-EBITDA, FCF Yield, P/B, revenue
      // growth) can still be computed. Populates the same merged/rawQuarters
      // arrays the FMP path builds, so the downstream pipeline is unchanged.
      if (merged.length === 0 && cik !== null) {
        try {
          const finRecords = await this.secEdgar.fetchQuarterlyFinancials(cik);
          const built = this.buildFromSecFinancials(normalizedSymbol, finRecords);
          merged.push(...built.records);
          rawQuarters.push(...built.rawQuarters);
        } catch (secError) {
          console.error(
            `[FundamentalFetcher] SEC financials fetch failed for ${normalizedSymbol}:`,
            secError instanceof Error ? secError.message : String(secError)
          );
        }
      }

      // Run index-based TTM math on the pure quarterly series BEFORE merging
      // SEC-EDGAR EPS-only rows. Interleaved EPS rows (null revenue/ebitda) would
      // corrupt the 4-/8-quarter rolling windows used by these two functions.
      const withGrowth = this.calculateRevenueGrowthYoy(merged, rawQuarters);
      const withTtm = this.computeTtmAndRatios(withGrowth, rawQuarters);

      // Merge deep-history SEC EPS (dates not already covered) into the records
      // array only, then re-sort by date ascending.
      if (cik !== null) {
        try {
          const secRecords: QuarterlyEpsRecord[] = await this.secEdgar.fetchQuarterlyEps(cik);
          const existingDates = new Set(
            withTtm.map((r) => r.date.toISOString().slice(0, 10))
          );
          for (const sec of secRecords) {
            const dateKey = sec.end.toISOString().slice(0, 10);
            if (!existingDates.has(dateKey)) {
              withTtm.push({
                symbol: normalizedSymbol,
                date: sec.end,
                peRatio: null,
                priceToFcf: null,
                fcf: null,
                eps: sec.eps,
                revenue: null,
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
                period: sec.period,
              });
              existingDates.add(dateKey);
            }
          }
          withTtm.sort((a, b) => a.date.getTime() - b.date.getTime());
        } catch (secError) {
          console.error(
            `[FundamentalFetcher] SEC EDGAR fetch failed for ${normalizedSymbol}:`,
            secError instanceof Error ? secError.message : String(secError)
          );
        }
      }

      const withPe = await this.calculatePeFromPrices(normalizedSymbol, withTtm);

      result.recordsFetched = withPe.length;

      if (withPe.length > 0) {
        result.recordsSaved = await this.saveToDatabase(normalizedSymbol, withPe);
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
      `${this.baseUrl}/key-metrics?symbol=${symbol}&period=quarter&limit=5&apikey=${this.apiKey}`;

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
            `[FundamentalFetcher] Key metrics endpoint requires a paid FMP plan (HTTP ${axiosError.response.status}). ` +
            `Will calculate P/E from price history and EPS instead.`
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
      `${this.baseUrl}/income-statement?symbol=${symbol}&period=quarter&limit=24&apikey=${this.apiKey}`;

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

  private async fetchCashFlowStatement(symbol: string): Promise<FMPCashFlowStatement[]> {
    if (!this.apiKey) {
      throw new FundamentalFetcherError('FMP API key not configured', 'NO_API_KEY');
    }

    const url =
      `${this.baseUrl}/cash-flow-statement?symbol=${symbol}&period=quarter&limit=24&apikey=${this.apiKey}`;

    console.log(`[FundamentalFetcher] Fetching cash flow statement for ${symbol}`);

    try {
      const response = await axios.get<FMPCashFlowStatement[]>(url, {
        timeout: 30000,
        headers: { Accept: 'application/json' },
      });

      if (!response.data || !Array.isArray(response.data)) {
        console.warn(`[FundamentalFetcher] No cash flow data for ${symbol}`);
        return [];
      }

      console.log(
        `[FundamentalFetcher] Got ${response.data.length} cash flow records for ${symbol}`
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 402 || axiosError.response?.status === 403) {
          console.warn(
            `[FundamentalFetcher] Cash flow endpoint requires paid FMP plan (HTTP ${axiosError.response.status})`
          );
          return [];
        }
        if (axiosError.response?.status === 429) {
          throw new FundamentalFetcherError('API rate limit exceeded', 'RATE_LIMIT', 429);
        }
      }
      throw new FundamentalFetcherError(
        `Failed to fetch cash flow statement: ${error instanceof Error ? error.message : String(error)}`,
        'API_ERROR'
      );
    }
  }

  private async fetchBalanceSheet(symbol: string): Promise<FMPBalanceSheet[]> {
    if (!this.apiKey) {
      throw new FundamentalFetcherError('FMP API key not configured', 'NO_API_KEY');
    }

    const url =
      `${this.baseUrl}/balance-sheet-statement?symbol=${symbol}&period=quarter&limit=24&apikey=${this.apiKey}`;

    console.log(`[FundamentalFetcher] Fetching balance sheet for ${symbol}`);

    try {
      const response = await axios.get<FMPBalanceSheet[]>(url, {
        timeout: 30000,
        headers: { Accept: 'application/json' },
      });

      if (!response.data || !Array.isArray(response.data)) {
        console.warn(`[FundamentalFetcher] No balance sheet data for ${symbol}`);
        return [];
      }

      console.log(
        `[FundamentalFetcher] Got ${response.data.length} balance sheet records for ${symbol}`
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 402 || axiosError.response?.status === 403) {
          console.warn(
            `[FundamentalFetcher] Balance sheet endpoint requires paid FMP plan (HTTP ${axiosError.response.status})`
          );
          return [];
        }
        if (axiosError.response?.status === 429) {
          throw new FundamentalFetcherError('API rate limit exceeded', 'RATE_LIMIT', 429);
        }
      }
      throw new FundamentalFetcherError(
        `Failed to fetch balance sheet: ${error instanceof Error ? error.message : String(error)}`,
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
    incomeData: FMPIncomeStatement[],
    cashFlowData: FMPCashFlowStatement[],
    balanceSheetData: FMPBalanceSheet[]
  ): { records: FundamentalRecord[]; rawQuarters: QuarterlyRaw[] } {
    // Build lookup maps keyed by date string for cross-statement join
    const incomeMap = new Map<string, FMPIncomeStatement>();
    for (const item of incomeData) {
      if (item.date) incomeMap.set(item.date, item);
    }
    const cashFlowMap = new Map<string, FMPCashFlowStatement>();
    for (const item of cashFlowData) {
      if (item.date) cashFlowMap.set(item.date, item);
    }
    const balanceMap = new Map<string, FMPBalanceSheet>();
    for (const item of balanceSheetData) {
      if (item.date) balanceMap.set(item.date, item);
    }

    // Collect all distinct dates across income, cashflow, and balance sheets
    const allDates = new Set<string>([
      ...incomeMap.keys(),
      ...cashFlowMap.keys(),
      ...balanceMap.keys(),
    ]);

    // key-metrics is paid-tier only (used for ROE); may be empty
    const kmMap = new Map<string, FMPKeyMetric>();
    for (const km of keyMetrics) {
      if (km.date) kmMap.set(km.date, km);
    }

    const records: FundamentalRecord[] = [];
    const rawQuarters: QuarterlyRaw[] = [];

    for (const dateStr of allDates) {
      let parsedDate: Date;
      try {
        parsedDate = parseISO(dateStr);
        if (isNaN(parsedDate.getTime())) continue;
      } catch {
        continue;
      }

      const income = incomeMap.get(dateStr);
      const cashFlow = cashFlowMap.get(dateStr);
      const balance = balanceMap.get(dateStr);
      const km = kmMap.get(dateStr);

      const revenue =
        income?.revenue != null ? BigInt(Math.round(income.revenue)) : null;

      const eps = income?.epsdiluted ?? income?.eps ?? null;

      records.push({
        symbol,
        date: parsedDate,
        peRatio: km?.peRatio ?? null,
        // priceToFcf and marketCap not stored; computed live on the frontend
        priceToFcf: null,
        // fcf starts as per-quarter value; overwritten with TTM in computeTtmAndRatios
        fcf:
          cashFlow?.freeCashFlow != null
            ? BigInt(Math.round(cashFlow.freeCashFlow))
            : null,
        eps,
        revenue,
        revenueGrowthYoy: null, // filled in calculateRevenueGrowthYoy
        roe: km?.returnOnEquity ?? null,
        debtToEquity: null,     // overridden from balance sheet in computeTtmAndRatios
        ebitdaTtm: null,        // filled in computeTtmAndRatios
        dilutedShares: null,    // filled in computeTtmAndRatios
        totalDebt: null,        // filled in computeTtmAndRatios
        cashAndEquivalents: null, // filled in computeTtmAndRatios
        totalEquity: null,      // filled in computeTtmAndRatios
        epsGrowthYoy: null,     // filled in computeTtmAndRatios
        roic: null,             // filled in computeTtmAndRatios
        period: income?.period ?? null,
      });

      rawQuarters.push({
        revenue: income?.revenue ?? null,
        eps: income?.eps ?? null,
        epsdiluted: income?.epsdiluted ?? null,
        operatingIncome: income?.operatingIncome ?? null,
        depreciationAndAmortization: income?.depreciationAndAmortization ?? null,
        ebitda: income?.ebitda ?? null,
        incomeTaxExpense: income?.incomeTaxExpense ?? null,
        incomeBeforeTax: income?.incomeBeforeTax ?? null,
        // Use FMP's provided freeCashFlow (= OCF + capex, capex is already negative)
        freeCashFlow: cashFlow?.freeCashFlow ?? null,
        totalDebt: balance?.totalDebt ?? null,
        totalStockholdersEquity: balance?.totalStockholdersEquity ?? null,
        cashAndCashEquivalents: balance?.cashAndCashEquivalents ?? null,
        weightedAverageShsOutDil: income?.weightedAverageShsOutDil ?? null,
      });
    }

    // Sort ascending by date so rolling windows compute in order
    const combined = records.map((r, i) => ({ record: r, raw: rawQuarters[i] }));
    combined.sort((a, b) => a.record.date.getTime() - b.record.date.getTime());
    const sortedRecords = combined.map((c) => c.record);
    const sortedRaw = combined.map((c) => c.raw);

    return { records: sortedRecords, rawQuarters: sortedRaw };
  }

  /**
   * Map SEC-EDGAR quarterly financials into the same FundamentalRecord seeds +
   * QuarterlyRaw parallel array that mergeFundamentals produces from FMP data,
   * so the downstream growth/TTM/ratio pipeline runs unchanged. Records arrive
   * ascending by date; TTM-derived fields are left null and filled downstream.
   */
  private buildFromSecFinancials(
    symbol: string,
    finRecords: QuarterlyFinancialRecord[]
  ): { records: FundamentalRecord[]; rawQuarters: QuarterlyRaw[] } {
    const records: FundamentalRecord[] = [];
    const rawQuarters: QuarterlyRaw[] = [];

    for (const r of finRecords) {
      records.push({
        symbol,
        date: r.end,
        peRatio: null,
        priceToFcf: null,
        // per-quarter FCF; overwritten with TTM in computeTtmAndRatios
        fcf: r.freeCashFlow != null ? BigInt(Math.round(r.freeCashFlow)) : null,
        eps: r.epsDiluted,
        revenue: r.revenue != null ? BigInt(Math.round(r.revenue)) : null,
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
        period: r.period,
      });

      rawQuarters.push({
        revenue: r.revenue,
        eps: r.epsDiluted,
        epsdiluted: r.epsDiluted,
        operatingIncome: r.operatingIncome,
        depreciationAndAmortization: r.depreciationAndAmortization,
        ebitda: null, // derived from operatingIncome + D&A in computeTtmAndRatios
        incomeTaxExpense: r.incomeTaxExpense,
        incomeBeforeTax: r.incomeBeforeTax,
        freeCashFlow: r.freeCashFlow,
        totalDebt: r.totalDebt,
        totalStockholdersEquity: r.stockholdersEquity,
        cashAndCashEquivalents: r.cashAndEquivalents,
        weightedAverageShsOutDil: r.dilutedShares,
      });
    }

    return { records, rawQuarters };
  }

  private computeTtmAndRatios(
    records: FundamentalRecord[],
    rawQuarters: QuarterlyRaw[]
  ): FundamentalRecord[] {
    return records.map((record, index) => {
      // Require a full 4-quarter window
      if (index < 3) return record;

      const win = rawQuarters.slice(index - 3, index + 1);
      const curRaw = rawQuarters[index];

      const allPresent = (fn: (r: QuarterlyRaw) => number | null): boolean =>
        win.every((r) => fn(r) !== null);

      // TTM FCF: sum FMP's per-quarter freeCashFlow (= OCF + capex; capex is negative).
      // Quarterly freeCashFlow from FMP is the period value, so summing 4 quarters gives TTM.
      const allHaveFcf = allPresent((r) => r.freeCashFlow);
      const ttmFcf: bigint | null = allHaveFcf
        ? BigInt(Math.round(win.reduce((s, r) => s + r.freeCashFlow!, 0)))
        : null;

      // TTM EBITDA: prefer the ebitda field; fall back to operatingIncome + D&A per quarter
      const ebitdaPerQuarter = win.map((r) => {
        if (r.ebitda !== null) return r.ebitda;
        if (r.operatingIncome !== null && r.depreciationAndAmortization !== null) {
          return r.operatingIncome + r.depreciationAndAmortization;
        }
        return null;
      });
      const allHaveEbitda = ebitdaPerQuarter.every((v) => v !== null);
      const ebitdaTtm: bigint | null = allHaveEbitda
        ? BigInt(Math.round(ebitdaPerQuarter.reduce((s, v) => s + v!, 0)))
        : null;

      // dilutedShares: point-in-time from current quarter
      const dilutedShares: bigint | null =
        curRaw.weightedAverageShsOutDil != null
          ? BigInt(Math.round(curRaw.weightedAverageShsOutDil))
          : null;

      // Balance sheet point-in-time values
      const totalDebt: bigint | null =
        curRaw.totalDebt != null ? BigInt(Math.round(curRaw.totalDebt)) : null;
      const cashAndEquivalents: bigint | null =
        curRaw.cashAndCashEquivalents != null
          ? BigInt(Math.round(curRaw.cashAndCashEquivalents))
          : null;
      const totalEquity: bigint | null =
        curRaw.totalStockholdersEquity != null
          ? BigInt(Math.round(curRaw.totalStockholdersEquity))
          : null;

      // Debt-to-equity: balance sheet based override
      let debtToEquity: number | null = null;
      if (
        curRaw.totalDebt != null &&
        curRaw.totalStockholdersEquity != null &&
        curRaw.totalStockholdersEquity > 0
      ) {
        debtToEquity = curRaw.totalDebt / curRaw.totalStockholdersEquity;
      }

      // ROIC = NOPAT / InvestedCapital
      // InvestedCapital = totalDebt + totalStockholdersEquity - cashAndCashEquivalents
      // (deployed capital net of idle cash — a standard definition)
      let roic: number | null = null;
      const allHaveOpIncome = allPresent((r) => r.operatingIncome);
      if (
        allHaveOpIncome &&
        curRaw.totalStockholdersEquity != null &&
        totalDebt !== null &&
        cashAndEquivalents !== null
      ) {
        const ttmOperatingIncome = win.reduce((s, r) => s + r.operatingIncome!, 0);

        // Effective tax rate from TTM; clamp to [0, 0.5] to avoid distortions
        let effectiveTaxRate = 0.21; // statutory fallback
        const allHaveTax = allPresent((r) => r.incomeTaxExpense);
        const allHavePreTax = allPresent((r) => r.incomeBeforeTax);
        if (allHaveTax && allHavePreTax) {
          const ttmPreTax = win.reduce((s, r) => s + r.incomeBeforeTax!, 0);
          if (ttmPreTax > 0) {
            const rawRate = win.reduce((s, r) => s + r.incomeTaxExpense!, 0) / ttmPreTax;
            effectiveTaxRate = Math.max(0, Math.min(0.5, rawRate));
          }
        }

        const nopat = ttmOperatingIncome * (1 - effectiveTaxRate);
        const investedCapital =
          Number(totalDebt) +
          curRaw.totalStockholdersEquity -
          Number(cashAndEquivalents);

        if (investedCapital > 0) {
          roic = nopat / investedCapital;
        }
      }

      // EPS growth YoY (TTM vs prior TTM); requires 8 quarters
      let epsGrowthYoy: number | null = null;
      if (index >= 7) {
        const priorWin = rawQuarters.slice(index - 7, index - 3);
        const currentEpsWin = win.map((r) => r.epsdiluted ?? r.eps);
        const priorEpsWin = priorWin.map((r) => r.epsdiluted ?? r.eps);
        const allCurrentEps = currentEpsWin.every((v) => v !== null);
        const allPriorEps = priorEpsWin.every((v) => v !== null);
        if (allCurrentEps && allPriorEps) {
          const ttmEps = currentEpsWin.reduce((s, v) => s + v!, 0);
          const priorTtmEps = priorEpsWin.reduce((s, v) => s + v!, 0);
          // PEG is meaningless with a non-positive EPS base
          if (priorTtmEps > 0) {
            epsGrowthYoy = (ttmEps - priorTtmEps) / Math.abs(priorTtmEps);
          }
        }
      }

      return {
        ...record,
        fcf: ttmFcf,
        ebitdaTtm,
        dilutedShares,
        totalDebt,
        cashAndEquivalents,
        totalEquity,
        roic,
        debtToEquity,
        epsGrowthYoy,
      };
    });
  }

  private async calculatePeFromPrices(
    symbol: string,
    records: FundamentalRecord[]
  ): Promise<FundamentalRecord[]> {
    if (records.length === 0) return records;

    const dates = records.map((r) => r.date.getTime());
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));

    const prices = await this.prisma.stockPrice.findMany({
      where: { symbol, date: { gte: minDate, lte: maxDate } },
      select: { date: true, close: true },
      orderBy: { date: 'asc' },
    });

    if (prices.length === 0) return records;

    const priceList = prices.map((p) => ({
      time: p.date.getTime(),
      close: Number(p.close),
    }));

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const findNearestPrice = (target: Date): number | null => {
      const t = target.getTime();
      let best: number | null = null;
      let bestDiff = Infinity;
      for (const p of priceList) {
        const diff = Math.abs(p.time - t);
        if (diff <= sevenDays && diff < bestDiff) {
          bestDiff = diff;
          best = p.close;
        }
      }
      return best;
    };

    return records.map((record, index) => {
      if (record.peRatio !== null || record.eps === null) return record;

      // TTM EPS: sum current + up to 3 prior quarters
      let ttmEps = record.eps;
      let quartersFound = 1;
      for (let i = 1; i <= 3 && index - i >= 0; i++) {
        const prior = records[index - i];
        if (prior.eps !== null) {
          ttmEps += prior.eps;
          quartersFound++;
        }
      }

      if (quartersFound < 4 || ttmEps <= 0) return record;

      const price = findNearestPrice(record.date);
      if (price === null) return record;

      return { ...record, peRatio: price / ttmEps };
    });
  }

  private calculateRevenueGrowthYoy(
    records: FundamentalRecord[],
    rawQuarters: QuarterlyRaw[]
  ): FundamentalRecord[] {
    // TTM-based: compare TTM revenue[index-3..index] vs prior TTM[index-7..index-4].
    // Requires 8 quarters; growthYoy stored as percent.
    return records.map((record, index) => {
      if (index < 7) return record;

      const currentWin = rawQuarters.slice(index - 3, index + 1);
      const priorWin = rawQuarters.slice(index - 7, index - 3);

      const allCurrentRev = currentWin.every((r) => r.revenue !== null);
      const allPriorRev = priorWin.every((r) => r.revenue !== null);

      if (!allCurrentRev || !allPriorRev) return record;

      const ttmRev = currentWin.reduce((s, r) => s + r.revenue!, 0);
      const priorTtmRev = priorWin.reduce((s, r) => s + r.revenue!, 0);

      if (priorTtmRev === 0) return record;

      const growth = ((ttmRev - priorTtmRev) / Math.abs(priorTtmRev)) * 100;
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
          batch.map((record) => {
            // The stale Prisma generated client predates the add_ratio_ttm_components
            // migration. We cast the data payloads so TypeScript accepts the new columns;
            // the runtime upsert will succeed once the migration has been applied.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sharedData: any = {
              peRatio: record.peRatio,
              priceToFcf: null,
              fcf: record.fcf,
              eps: record.eps,
              revenue: record.revenue,
              revenueGrowthYoy: record.revenueGrowthYoy,
              roe: record.roe,
              debtToEquity: record.debtToEquity,
              ebitdaTtm: record.ebitdaTtm,
              dilutedShares: record.dilutedShares,
              totalDebt: record.totalDebt,
              cashAndEquivalents: record.cashAndEquivalents,
              totalEquity: record.totalEquity,
              epsGrowthYoy: record.epsGrowthYoy,
              roic: record.roic,
              period: record.period,
            };
            return this.prisma.financialRatio.upsert({
              where: {
                symbol_date: {
                  symbol: record.symbol,
                  date: record.date,
                },
              },
              update: sharedData,
              create: { symbol: record.symbol, date: record.date, ...sharedData },
            });
          })
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
