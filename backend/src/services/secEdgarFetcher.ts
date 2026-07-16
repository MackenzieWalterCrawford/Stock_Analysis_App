import axios, { AxiosError } from 'axios';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface QuarterlyEpsRecord {
  end: Date;
  eps: number;
  period: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  fiscalYear: number;
}

/**
 * Per-fiscal-quarter financials sourced from SEC EDGAR XBRL company-facts.
 * All money fields are in USD; nullable when the underlying concept was not
 * filed for that quarter. Flow fields (revenue, income, cash-flow) are
 * standalone-quarter values derived from YTD-cumulative XBRL facts; instant
 * fields (equity, cash, debt) are point-in-time balance-sheet snapshots.
 */
export interface QuarterlyFinancialRecord {
  end: Date;
  period: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  fiscalYear: number;
  revenue: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization: number | null;
  incomeTaxExpense: number | null;
  incomeBeforeTax: number | null;
  netIncome: number | null;
  operatingCashFlow: number | null;
  capex: number | null;         // POSITIVE outflow as filed by SEC
  freeCashFlow: number | null;  // operatingCashFlow - capex
  dilutedShares: number | null;
  epsDiluted: number | null;
  stockholdersEquity: number | null;
  cashAndEquivalents: number | null;
  totalDebt: number | null;
}

// us-gaap concept fallback chains (primary first). Companies switch tags over
// the years, so results are merged across the chain keyed by period-end date.
const CONCEPTS = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
  ],
  operatingIncome: ['OperatingIncomeLoss'],
  depreciationAndAmortization: [
    'DepreciationDepletionAndAmortization',
    'DepreciationAndAmortization',
  ],
  incomeTaxExpense: ['IncomeTaxExpenseBenefit'],
  incomeBeforeTax: [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
  ],
  netIncome: ['NetIncomeLoss'],
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsForCapitalImprovements',
  ],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  dilutedShares: [
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic',
  ],
  stockholdersEquity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  cashAndEquivalents: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    'Cash',
  ],
} as const;

interface SecEdgarEntry {
  start: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
}

interface SecEdgarConceptResponse {
  units?: {
    'USD/shares'?: SecEdgarEntry[];
    [key: string]: SecEdgarEntry[] | undefined;
  };
}

export class SecEdgarFetcherError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_DATA' | 'NETWORK_ERROR' | 'AUTH_ERROR' | 'PARSE_ERROR',
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'SecEdgarFetcherError';
  }
}

// ============================================================================
// Module-level state
// ============================================================================

let userAgentWarnEmitted = false;

// ticker (uppercase) -> zero-padded 10-digit CIK, loaded once from SEC.
let cikMapCache: Map<string, string> | null = null;

const STANDALONE_MAX_DAYS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NEAREST_INSTANT_DAYS = 7;

interface CompanyFacts {
  facts?: {
    'us-gaap'?: {
      [concept: string]: { units?: { [unit: string]: SecEdgarEntry[] } } | undefined;
    };
  };
}

interface StandaloneQuarter {
  val: number;
  fp: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  fy: number;
}

// ============================================================================
// SecEdgarFetcher Service
// ============================================================================

export class SecEdgarFetcher {
  private userAgent: string;
  private baseUrl: string;

  constructor() {
    const envUserAgent = process.env.SEC_EDGAR_USER_AGENT;
    if (!envUserAgent) {
      if (!userAgentWarnEmitted) {
        console.warn(
          '[SecEdgarFetcher] SEC_EDGAR_USER_AGENT not set; using default'
        );
        userAgentWarnEmitted = true;
      }
      this.userAgent = 'StockAnalysisApp +mackenzie.walter.crawford@gmail.com';
    } else {
      this.userAgent = envUserAgent;
    }
    this.baseUrl = 'https://data.sec.gov/api/xbrl/companyconcept';
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async fetchQuarterlyEps(cik: string): Promise<QuarterlyEpsRecord[]> {
    if (!cik) return [];

    const paddedCik = cik.replace(/^0+/, '').padStart(10, '0');
    const url = `${this.baseUrl}/CIK${paddedCik}/us-gaap/EarningsPerShareDiluted.json`;

    let rawEntries: SecEdgarEntry[];
    try {
      const response = await axios.get<SecEdgarConceptResponse>(url, {
        timeout: 30000,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
      });

      const usdShares = response.data?.units?.['USD/shares'];
      if (!usdShares || usdShares.length === 0) {
        return [];
      }
      rawEntries = usdShares;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        if (status === 404) return [];
        if (status === 403) {
          throw new SecEdgarFetcherError(
            'Missing or invalid User-Agent',
            'AUTH_ERROR',
            403
          );
        }
        if (status !== undefined) {
          throw new SecEdgarFetcherError(
            `SEC EDGAR request failed with HTTP ${status}`,
            'NETWORK_ERROR',
            status
          );
        }
        throw new SecEdgarFetcherError(
          `SEC EDGAR network error: ${axiosError.message}`,
          'NETWORK_ERROR'
        );
      }
      throw new SecEdgarFetcherError(
        `Unexpected error fetching SEC EDGAR data: ${error instanceof Error ? error.message : String(error)}`,
        'PARSE_ERROR'
      );
    }

    // Filter to 10-Q and 10-K only
    const filtered = rawEntries.filter(
      (e) => e.form === '10-Q' || e.form === '10-K'
    );

    // Dedupe: group by (end, form, fp, start), keep latest filed
    const dedupeMap = new Map<string, SecEdgarEntry>();
    for (const entry of filtered) {
      const key = `${entry.end}|${entry.form}|${entry.fp}|${entry.start}`;
      const existing = dedupeMap.get(key);
      if (!existing || entry.filed > existing.filed) {
        dedupeMap.set(key, entry);
      }
    }
    const deduped = Array.from(dedupeMap.values());

    // Partition entries
    const standaloneQ1Q2Q3: SecEdgarEntry[] = [];
    // keyed by fy
    const q3YtdByFy = new Map<number, SecEdgarEntry>();
    const fyByFy = new Map<number, SecEdgarEntry>();

    for (const entry of deduped) {
      const startMs = new Date(entry.start).getTime();
      const endMs = new Date(entry.end).getTime();
      const durationDays = (endMs - startMs) / MS_PER_DAY;

      if (entry.form === '10-K' && entry.fp === 'FY') {
        fyByFy.set(entry.fy, entry);
      } else if (entry.fp === 'Q3' && durationDays > STANDALONE_MAX_DAYS) {
        // YTD Q3 entry
        const existing = q3YtdByFy.get(entry.fy);
        if (!existing || entry.filed > existing.filed) {
          q3YtdByFy.set(entry.fy, entry);
        }
      } else if (
        (entry.fp === 'Q1' || entry.fp === 'Q2' || entry.fp === 'Q3') &&
        durationDays <= STANDALONE_MAX_DAYS
      ) {
        standaloneQ1Q2Q3.push(entry);
      }
    }

    const results: QuarterlyEpsRecord[] = [];

    // Emit standalone Q1/Q2/Q3
    for (const entry of standaloneQ1Q2Q3) {
      const period = entry.fp as 'Q1' | 'Q2' | 'Q3';
      results.push({
        end: new Date(entry.end),
        eps: entry.val,
        period,
        fiscalYear: entry.fy,
      });
    }

    // Derive Q4 = FY - Q3_YTD for each fiscal year that has both
    for (const [fy, fyEntry] of fyByFy) {
      const q3Ytd = q3YtdByFy.get(fy);
      if (!q3Ytd) continue;
      const q4Eps = fyEntry.val - q3Ytd.val;
      results.push({
        end: new Date(fyEntry.end),
        eps: q4Eps,
        period: 'Q4',
        fiscalYear: fy,
      });
    }

    // Sort ascending by end date
    results.sort((a, b) => a.end.getTime() - b.end.getTime());

    return results;
  }

  // --------------------------------------------------------------------------
  // Full quarterly financials (company-facts) — sources every statement line
  // needed to compute EV/EBITDA, ROIC, PEG, P/B, Debt-to-EBITDA, FCF Yield,
  // and Revenue Growth without the paid FMP statement endpoints.
  // --------------------------------------------------------------------------

  /**
   * Resolve a ticker symbol to its zero-padded 10-digit CIK using SEC's
   * ticker→CIK map. Cached in-process after the first successful load.
   */
  async resolveCik(symbol: string): Promise<string | null> {
    const ticker = symbol.toUpperCase().trim();
    if (!cikMapCache) {
      try {
        const resp = await axios.get<Record<string, { cik_str: number; ticker: string }>>(
          'https://www.sec.gov/files/company_tickers.json',
          { timeout: 30000, headers: { Accept: 'application/json', 'User-Agent': this.userAgent } }
        );
        const data = resp.data;
        if (!data || typeof data !== 'object') return null;
        const map = new Map<string, string>();
        for (const key of Object.keys(data)) {
          const row = data[key];
          if (row && row.ticker) {
            map.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, '0'));
          }
        }
        cikMapCache = map;
      } catch {
        return null; // don't cache failures; retry next call
      }
    }
    return cikMapCache.get(ticker) ?? null;
  }

  async fetchQuarterlyFinancials(cik: string): Promise<QuarterlyFinancialRecord[]> {
    if (!cik) return [];
    const paddedCik = cik.replace(/^0+/, '').padStart(10, '0');
    const usGaap = await this.fetchCompanyFacts(paddedCik);
    if (!usGaap) return [];

    // Flow (duration) concepts — standalone quarterly values via YTD differencing
    const revenue = this.flowChain(usGaap, CONCEPTS.revenue, 'USD');
    const operatingIncome = this.flowChain(usGaap, CONCEPTS.operatingIncome, 'USD');
    const dep = this.flowChain(usGaap, CONCEPTS.depreciationAndAmortization, 'USD');
    const tax = this.flowChain(usGaap, CONCEPTS.incomeTaxExpense, 'USD');
    const preTax = this.flowChain(usGaap, CONCEPTS.incomeBeforeTax, 'USD');
    const netIncome = this.flowChain(usGaap, CONCEPTS.netIncome, 'USD');
    const ocf = this.flowChain(usGaap, CONCEPTS.operatingCashFlow, 'USD');
    const capex = this.flowChain(usGaap, CONCEPTS.capex, 'USD');
    const eps = this.flowChain(usGaap, CONCEPTS.epsDiluted, 'USD/shares');
    const shares = this.flowChain(usGaap, CONCEPTS.dilutedShares, 'shares');

    // Instant (point-in-time) balance-sheet concepts
    const equity = this.instantChain(usGaap, CONCEPTS.stockholdersEquity, 'USD');
    const cash = this.instantChain(usGaap, CONCEPTS.cashAndEquivalents, 'USD');
    const debtCurrent = this.instantChain(usGaap, ['DebtCurrent'], 'USD');
    const longTermDebt = this.instantChain(usGaap, ['LongTermDebt'], 'USD');
    const shortTermBorrow = this.instantChain(usGaap, ['ShortTermBorrowings'], 'USD');
    const ltdCurrent = this.instantChain(usGaap, ['LongTermDebtCurrent'], 'USD');
    const ltdNoncurrent = this.instantChain(usGaap, ['LongTermDebtNoncurrent'], 'USD');

    // Skeleton of quarter end-dates + fp/fy labels, unioned across the
    // most reliably-filed flow concepts.
    const skeleton = new Map<string, StandaloneQuarter>();
    for (const m of [revenue, eps, netIncome, operatingIncome, ocf]) {
      for (const [k, v] of m) if (!skeleton.has(k)) skeleton.set(k, v);
    }

    const records: QuarterlyFinancialRecord[] = [];
    for (const [endKey, label] of skeleton) {
      const ocfVal = ocf.get(endKey)?.val ?? null;
      const capexVal = capex.get(endKey)?.val ?? null;
      // SEC files capex as a positive outflow → subtract to get FCF
      const freeCashFlow = ocfVal != null && capexVal != null ? ocfVal - capexVal : null;

      const dc = this.nearestInstant(debtCurrent, endKey);
      const ltd = this.nearestInstant(longTermDebt, endKey);
      let totalDebt: number | null;
      if (dc != null && ltd != null) {
        totalDebt = dc + ltd;
      } else {
        const stb = this.nearestInstant(shortTermBorrow, endKey);
        const c = this.nearestInstant(ltdCurrent, endKey);
        const nc = this.nearestInstant(ltdNoncurrent, endKey);
        totalDebt = stb == null && c == null && nc == null ? null : (stb ?? 0) + (c ?? 0) + (nc ?? 0);
      }

      records.push({
        end: new Date(endKey),
        period: label.fp,
        fiscalYear: label.fy,
        revenue: revenue.get(endKey)?.val ?? null,
        operatingIncome: operatingIncome.get(endKey)?.val ?? null,
        depreciationAndAmortization: dep.get(endKey)?.val ?? null,
        incomeTaxExpense: tax.get(endKey)?.val ?? null,
        incomeBeforeTax: preTax.get(endKey)?.val ?? null,
        netIncome: netIncome.get(endKey)?.val ?? null,
        operatingCashFlow: ocfVal,
        capex: capexVal,
        freeCashFlow,
        dilutedShares: shares.get(endKey)?.val ?? null,
        epsDiluted: eps.get(endKey)?.val ?? null,
        stockholdersEquity: this.nearestInstant(equity, endKey),
        cashAndEquivalents: this.nearestInstant(cash, endKey),
        totalDebt,
      });
    }

    records.sort((a, b) => a.end.getTime() - b.end.getTime());
    return records;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async fetchCompanyFacts(paddedCik: string): Promise<UsGaapFacts | null> {
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;
    try {
      const resp = await axios.get<CompanyFacts>(url, {
        timeout: 60000,
        maxContentLength: 100 * 1024 * 1024,
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
      });
      const usGaap = resp.data?.facts?.['us-gaap'];
      return usGaap ?? null;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = (error as AxiosError).response?.status;
        if (status === 404) return null;
        if (status === 403) {
          throw new SecEdgarFetcherError('Missing or invalid User-Agent', 'AUTH_ERROR', 403);
        }
        if (status !== undefined) {
          throw new SecEdgarFetcherError(`SEC EDGAR request failed with HTTP ${status}`, 'NETWORK_ERROR', status);
        }
        throw new SecEdgarFetcherError(`SEC EDGAR network error: ${(error as AxiosError).message}`, 'NETWORK_ERROR');
      }
      throw new SecEdgarFetcherError(
        `Unexpected error fetching SEC company facts: ${error instanceof Error ? error.message : String(error)}`,
        'PARSE_ERROR'
      );
    }
  }

  private getConceptEntries(usGaap: UsGaapFacts, concept: string, unit: string): SecEdgarEntry[] | null {
    const entries = usGaap[concept]?.units?.[unit];
    return entries && entries.length > 0 ? entries : null;
  }

  /**
   * Merge a fallback chain of flow concepts into a single standalone-quarter
   * series keyed by end-date. The first concept that supplies a value for a
   * given end-date wins (companies switch tags across years).
   */
  private flowChain(
    usGaap: UsGaapFacts,
    concepts: readonly string[],
    unit: string
  ): Map<string, StandaloneQuarter> {
    const out = new Map<string, StandaloneQuarter>();
    for (const name of concepts) {
      const entries = this.getConceptEntries(usGaap, name, unit);
      if (!entries) continue;
      const m = this.deriveStandaloneQuarters(entries);
      for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
    }
    return out;
  }

  private instantChain(
    usGaap: UsGaapFacts,
    concepts: readonly string[],
    unit: string
  ): Map<string, number> {
    const out = new Map<string, number>();
    for (const name of concepts) {
      const entries = this.getConceptEntries(usGaap, name, unit);
      if (!entries) continue;
      const m = this.deriveInstantByEnd(entries);
      for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
    }
    return out;
  }

  /**
   * Derive standalone quarterly values from YTD-cumulative flow facts.
   * Q1 is the 3-month period as filed; Q2/Q3 are taken standalone when the
   * company files a 3-month context, otherwise differenced from YTD
   * (Q2 = H1 − Q1, Q3 = 9mo − H1); Q4 = FY(10-K) − 9mo YTD.
   */
  private deriveStandaloneQuarters(rawEntries: SecEdgarEntry[]): Map<string, StandaloneQuarter> {
    const filtered = rawEntries.filter((e) => e.form === '10-Q' || e.form === '10-K');

    // Dedupe by (end, form, fp, start), preferring framed then latest-filed.
    const dedupeMap = new Map<string, SecEdgarEntry>();
    for (const e of filtered) {
      if (!e.start) continue; // flow facts always have a start
      const key = `${e.end}|${e.form}|${e.fp}|${e.start}`;
      const ex = dedupeMap.get(key);
      if (!ex || preferEntry(e, ex)) dedupeMap.set(key, e);
    }

    interface FyGroup {
      q1?: SecEdgarEntry; q2s?: SecEdgarEntry; q3s?: SecEdgarEntry;
      h1?: SecEdgarEntry; q3ytd?: SecEdgarEntry; fy?: SecEdgarEntry;
    }
    const byFy = new Map<number, FyGroup>();
    const take = (cur: SecEdgarEntry | undefined, cand: SecEdgarEntry) =>
      !cur || preferEntry(cand, cur) ? cand : cur;

    for (const e of dedupeMap.values()) {
      const durationDays = (new Date(e.end).getTime() - new Date(e.start).getTime()) / MS_PER_DAY;
      const g = byFy.get(e.fy) ?? {};
      if (e.form === '10-K' && e.fp === 'FY') g.fy = take(g.fy, e);
      else if (e.fp === 'Q1' && durationDays <= STANDALONE_MAX_DAYS) g.q1 = take(g.q1, e);
      else if (e.fp === 'Q2' && durationDays <= STANDALONE_MAX_DAYS) g.q2s = take(g.q2s, e);
      else if (e.fp === 'Q3' && durationDays <= STANDALONE_MAX_DAYS) g.q3s = take(g.q3s, e);
      else if (e.fp === 'Q2' && durationDays > STANDALONE_MAX_DAYS) g.h1 = take(g.h1, e);
      else if (e.fp === 'Q3' && durationDays > STANDALONE_MAX_DAYS) g.q3ytd = take(g.q3ytd, e);
      byFy.set(e.fy, g);
    }

    const out = new Map<string, StandaloneQuarter>();
    for (const [fy, g] of byFy) {
      if (g.q1) out.set(g.q1.end, { val: g.q1.val, fp: 'Q1', fy });
      if (g.q2s) out.set(g.q2s.end, { val: g.q2s.val, fp: 'Q2', fy });
      else if (g.h1 && g.q1) out.set(g.h1.end, { val: g.h1.val - g.q1.val, fp: 'Q2', fy });
      if (g.q3s) out.set(g.q3s.end, { val: g.q3s.val, fp: 'Q3', fy });
      else if (g.q3ytd && g.h1) out.set(g.q3ytd.end, { val: g.q3ytd.val - g.h1.val, fp: 'Q3', fy });
      if (g.fy && g.q3ytd) out.set(g.fy.end, { val: g.fy.val - g.q3ytd.val, fp: 'Q4', fy });
    }
    return out;
  }

  /** Latest consolidated value per period-end for an instant (balance-sheet) concept. */
  private deriveInstantByEnd(rawEntries: SecEdgarEntry[]): Map<string, number> {
    const filtered = rawEntries.filter((e) => e.form === '10-Q' || e.form === '10-K');
    const dedupe = new Map<string, SecEdgarEntry>();
    for (const e of filtered) {
      const ex = dedupe.get(e.end);
      if (!ex || preferEntry(e, ex)) dedupe.set(e.end, e);
    }
    const out = new Map<string, number>();
    for (const [end, e] of dedupe) out.set(end, e.val);
    return out;
  }

  /** Exact end-date match, else the closest instant within ±7 days. */
  private nearestInstant(map: Map<string, number>, endKey: string): number | null {
    const exact = map.get(endKey);
    if (exact !== undefined) return exact;
    const t = new Date(endKey).getTime();
    let best: number | null = null;
    let bestDiff = Infinity;
    for (const [k, v] of map) {
      const diff = Math.abs(new Date(k).getTime() - t) / MS_PER_DAY;
      if (diff <= NEAREST_INSTANT_DAYS && diff < bestDiff) {
        bestDiff = diff;
        best = v;
      }
    }
    return best;
  }
}

type UsGaapFacts = NonNullable<NonNullable<CompanyFacts['facts']>['us-gaap']>;

/** Prefer a framed (consolidated, non-dimensional) entry; tie-break on latest filed. */
function preferEntry(cand: SecEdgarEntry, cur: SecEdgarEntry): boolean {
  const candFramed = !!cand.frame;
  const curFramed = !!cur.frame;
  if (candFramed !== curFramed) return candFramed;
  return cand.filed > cur.filed;
}

export { SecEdgarFetcher as default };
