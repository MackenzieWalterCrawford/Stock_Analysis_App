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

const STANDALONE_MAX_DAYS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
}

export { SecEdgarFetcher as default };
