/**
 * Unit tests for SecEdgarFetcher
 *
 * Uses jest.mock('axios') — no HTTP mocking library required.
 *
 * Fixture: sec-aapl-eps.json — real CIK0000320193 response captured from
 * https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/EarningsPerShareDiluted.json
 */

import axios, { AxiosError } from 'axios';
import * as path from 'path';
import * as fs from 'fs';
import {
  SecEdgarFetcher,
  SecEdgarFetcherError,
  QuarterlyEpsRecord,
} from '../secEdgarFetcher';

// ---------------------------------------------------------------------------
// Mock axios globally for all tests in this file
// ---------------------------------------------------------------------------
jest.mock('axios');
const mockedAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;

// isAxiosError must see the real implementation so our hand-crafted AxiosErrors
// are recognised correctly.
const realIsAxiosError = jest.requireActual<typeof import('axios')>('axios').isAxiosError;
jest.spyOn(axios, 'isAxiosError').mockImplementation(
  (err): err is AxiosError => realIsAxiosError(err)
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load the AAPL fixture from disk and parse it once for the whole test suite. */
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sec-aapl-eps.json');
const aaplFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as {
  units: { 'USD/shares': Array<{
    start: string;
    end: string;
    val: number;
    accn: string;
    fy: number;
    fp: string;
    form: string;
    filed: string;
    frame?: string;
  }> };
};

type FixtureEntry = (typeof aaplFixture)['units']['USD/shares'][number];

/** Build a minimal AxiosError with the given HTTP status. */
function makeAxiosError(status: number): AxiosError {
  const err = new Error(`Request failed with status code ${status}`) as AxiosError;
  err.isAxiosError = true;
  // Cast to satisfy TypeScript — we only need `response.status` to be present.
  (err as unknown as { response: { status: number } }).response = { status };
  return err;
}

/** Return a fake axios resolved response wrapping the given data. */
function axiosResolve<T>(data: T): Promise<{ data: T }> {
  return Promise.resolve({ data });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SecEdgarFetcher', () => {
  let fetcher: SecEdgarFetcher;

  beforeEach(() => {
    jest.clearAllMocks();
    fetcher = new SecEdgarFetcher();
  });

  // -------------------------------------------------------------------------
  // Test 1: Parses Q1 standalone correctly
  // -------------------------------------------------------------------------
  it('parses a standalone Q1 entry correctly from the AAPL fixture', async () => {
    mockedAxiosGet.mockReturnValueOnce(axiosResolve(aaplFixture));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('0000320193');

    // The fixture (captured 2026-05-12) contains AAPL Q1 FY2026:
    //   start=2025-09-28, end=2025-12-27, val=2.84, fy=2026, fp=Q1, form=10-Q
    // (There is also an older Q1 FY2026 with end=2024-12-28; this test targets the
    // current-year standalone entry ending 2025-12-27.)
    const q1Fy2026Latest = results.find(
      (r) =>
        r.period === 'Q1' &&
        r.fiscalYear === 2026 &&
        r.end.toISOString().slice(0, 10) === '2025-12-27'
    );

    expect(q1Fy2026Latest).toBeDefined();
    expect(q1Fy2026Latest!.eps).toBeCloseTo(2.84, 5);
  });

  // -------------------------------------------------------------------------
  // Test 2: Derives Q4 correctly via FY − Q3 YTD
  // -------------------------------------------------------------------------
  it('derives Q4 EPS as FY minus Q3 YTD for FY2025', async () => {
    mockedAxiosGet.mockReturnValueOnce(axiosResolve(aaplFixture));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('0000320193');

    // Compute expected Q4 FY2025 from the fixture directly (do not hard-code).
    // Production logic:
    //   fyByFy[2025] = last deduped 10-K with fp=FY fy=2025
    //   q3YtdByFy[2025] = first deduped Q3 with duration>100 days fy=2025, latest filed
    const usdShares: FixtureEntry[] = aaplFixture.units['USD/shares'];

    const filtered = usdShares.filter(
      (e) => e.form === '10-Q' || e.form === '10-K'
    );

    // Replicate deduplication
    const dedupeMap = new Map<string, FixtureEntry>();
    for (const e of filtered) {
      const key = `${e.end}|${e.form}|${e.fp}|${e.start}`;
      const existing = dedupeMap.get(key);
      if (!existing || e.filed > existing.filed) {
        dedupeMap.set(key, e);
      }
    }
    const deduped = Array.from(dedupeMap.values());

    // Replicate partitioning
    const STANDALONE_MAX_DAYS = 100;
    let fyEntry: FixtureEntry | undefined;
    let q3YtdEntry: FixtureEntry | undefined;

    for (const e of deduped) {
      const durationDays =
        (new Date(e.end).getTime() - new Date(e.start).getTime()) /
        (24 * 60 * 60 * 1000);

      if (e.form === '10-K' && e.fp === 'FY' && e.fy === 2025) {
        fyEntry = e; // last one wins (Map insertion order)
      } else if (e.fp === 'Q3' && durationDays > STANDALONE_MAX_DAYS && e.fy === 2025) {
        if (!q3YtdEntry || e.filed > q3YtdEntry.filed) {
          q3YtdEntry = e;
        }
      }
    }

    expect(fyEntry).toBeDefined();
    expect(q3YtdEntry).toBeDefined();

    const expectedQ4Eps = fyEntry!.val - q3YtdEntry!.val;
    const expectedEnd = fyEntry!.end; // FY annual end date becomes Q4 end date

    const q4Fy2025 = results.find(
      (r) => r.period === 'Q4' && r.fiscalYear === 2025
    );

    expect(q4Fy2025).toBeDefined();
    expect(q4Fy2025!.end.toISOString().slice(0, 10)).toBe(expectedEnd);
    expect(q4Fy2025!.eps).toBeCloseTo(expectedQ4Eps, 5);
  });

  // -------------------------------------------------------------------------
  // Test 3: Filters out 8-K and amended forms via synthetic fixture
  // -------------------------------------------------------------------------
  it('excludes entries from 8-K forms even when their end date matches a 10-Q entry', async () => {
    // Build a synthetic response that has:
    //  - One valid 10-Q standalone Q1 entry
    //  - One 8-K entry with a DIFFERENT end date that has no 10-Q/10-K counterpart
    //  - One 8-K entry with the SAME end date as the 10-Q (should not inflate the result)
    const syntheticWithEightK = {
      units: {
        'USD/shares': [
          {
            // Valid standalone Q1
            start: '2022-01-01',
            end: '2022-03-31',
            val: 1.50,
            accn: 'VALID-10Q-001',
            fy: 2022,
            fp: 'Q1',
            form: '10-Q',
            filed: '2022-04-20',
          },
          {
            // 8-K with unique end date — must NOT appear in results
            start: '2022-04-01',
            end: '2022-04-30',
            val: 9.99,
            accn: '8K-ONLY-001',
            fy: 2022,
            fp: 'Q1',
            form: '8-K',
            filed: '2022-05-02',
          },
          {
            // 8-K sharing end date with the valid 10-Q — also must not create a duplicate
            start: '2022-01-01',
            end: '2022-03-31',
            val: 1.60,          // different value — must NOT win
            accn: '8K-DUPE-002',
            fy: 2022,
            fp: 'Q1',
            form: '8-K',
            filed: '2022-04-25',
          },
        ],
      },
    };

    mockedAxiosGet.mockReturnValueOnce(axiosResolve(syntheticWithEightK));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('0000000099');

    // Only the 10-Q entry should survive
    expect(results).toHaveLength(1);
    expect(results[0].eps).toBeCloseTo(1.50, 5);

    // The 8-K-only end date must not appear
    const resultEnds = results.map((r) => r.end.toISOString().slice(0, 10));
    expect(resultEnds).not.toContain('2022-04-30');
  });

  // -------------------------------------------------------------------------
  // Test 4: Dedup — latest filed wins on restatements
  // -------------------------------------------------------------------------
  it('keeps the value from the later-filed entry when the same key appears twice', async () => {
    const syntheticResponse = {
      units: {
        'USD/shares': [
          {
            start: '2023-01-01',
            end: '2023-03-31',
            val: 1.00,
            accn: 'OLD-ACCN-001',
            fy: 2023,
            fp: 'Q1',
            form: '10-Q',
            filed: '2023-04-20',
          },
          {
            start: '2023-01-01',
            end: '2023-03-31',
            val: 1.25,          // restated value
            accn: 'NEW-ACCN-002',
            fy: 2023,
            fp: 'Q1',
            form: '10-Q',
            filed: '2023-05-15', // filed later
          },
        ],
      },
    };

    mockedAxiosGet.mockReturnValueOnce(axiosResolve(syntheticResponse));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('1234567890');

    expect(results).toHaveLength(1);
    expect(results[0].eps).toBeCloseTo(1.25, 5);
  });

  // -------------------------------------------------------------------------
  // Test 5: Returns [] when units["USD/shares"] is absent
  // -------------------------------------------------------------------------
  it('returns an empty array when the response has no USD/shares unit (e.g. ASML)', async () => {
    const aslmLikeResponse = {
      units: {
        'EUR/shares': [
          {
            start: '2023-01-01',
            end: '2023-03-31',
            val: 3.5,
            accn: 'ASML-001',
            fy: 2023,
            fp: 'Q1',
            form: '20-F',
            filed: '2023-04-25',
          },
        ],
      },
    };

    mockedAxiosGet.mockReturnValueOnce(axiosResolve(aslmLikeResponse));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('0000947263');

    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 6: Returns [] on HTTP 404
  // -------------------------------------------------------------------------
  it('returns an empty array on HTTP 404 without throwing', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError(404));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('0000000001');

    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 7: Throws AUTH_ERROR on HTTP 403
  // -------------------------------------------------------------------------
  it('throws a SecEdgarFetcherError with code AUTH_ERROR on HTTP 403', async () => {
    mockedAxiosGet.mockRejectedValueOnce(makeAxiosError(403));

    let caughtError: unknown;
    try {
      await fetcher.fetchQuarterlyEps('0000000001');
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(SecEdgarFetcherError);
    expect((caughtError as SecEdgarFetcherError).code).toBe('AUTH_ERROR');
  });

  // -------------------------------------------------------------------------
  // Test 8: Empty CIK short-circuits — axios is never called
  // -------------------------------------------------------------------------
  it('returns [] immediately for an empty CIK without calling axios', async () => {
    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('');

    expect(results).toEqual([]);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 9: CIK is zero-padded to 10 digits
  // -------------------------------------------------------------------------
  it('zero-pads the CIK to 10 digits in the request URL', async () => {
    mockedAxiosGet.mockReturnValueOnce(axiosResolve({ units: {} }));

    await fetcher.fetchQuarterlyEps('320193');

    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    const calledUrl = mockedAxiosGet.mock.calls[0][0] as string;
    expect(calledUrl).toContain('CIK0000320193');
  });

  // -------------------------------------------------------------------------
  // Test 10: User-Agent header is set
  // -------------------------------------------------------------------------
  it('sends a non-empty User-Agent header with every request', async () => {
    mockedAxiosGet.mockReturnValueOnce(axiosResolve({ units: {} }));

    await fetcher.fetchQuarterlyEps('320193');

    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    const callArgs = mockedAxiosGet.mock.calls[0];
    const config = callArgs[1] as { headers: Record<string, string> };
    expect(config).toBeDefined();
    expect(config.headers).toBeDefined();
    const userAgent: string = config.headers['User-Agent'];
    expect(typeof userAgent).toBe('string');
    expect(userAgent.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 11: Results sorted ascending by end date
  // -------------------------------------------------------------------------
  it('returns results sorted in ascending order by end date', async () => {
    mockedAxiosGet.mockReturnValueOnce(axiosResolve(aaplFixture));

    const results: QuarterlyEpsRecord[] = await fetcher.fetchQuarterlyEps('0000320193');

    expect(results.length).toBeGreaterThan(1);

    for (let i = 1; i < results.length; i++) {
      expect(results[i].end.getTime()).toBeGreaterThanOrEqual(
        results[i - 1].end.getTime()
      );
    }
  });
});
