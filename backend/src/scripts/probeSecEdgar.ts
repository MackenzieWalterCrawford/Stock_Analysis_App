import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const USER_AGENT = 'StockAnalysisApp research mackenzie.walter.crawford@gmail.com';
const BASE = 'https://data.sec.gov/api/xbrl/companyconcept';

interface XbrlEntry {
  accn: string;
  cik: number;
  entityName: string;
  loc: string;
  end: string;
  val: number;
  accession?: string;
  filed: string;
  form: string;
  fp: string;
  fy: number;
  frame?: string;
  start?: string;
}

interface XbrlResponse {
  cik: number;
  taxonomy: string;
  tag: string;
  label: string;
  description: string;
  entityName: string;
  units: {
    [key: string]: XbrlEntry[];
  };
}

async function fetchConcept(cik: string, tag: string, withUserAgent: boolean = true): Promise<{ status: number; data?: XbrlResponse; headers?: Record<string, string>; error?: string }> {
  const url = `${BASE}/${cik}/${tag}.json`;
  const headers: Record<string, string> = withUserAgent ? { 'User-Agent': USER_AGENT } : {};
  try {
    const r = await axios.get(url, { headers, timeout: 30000 });
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (typeof v === 'string') responseHeaders[k] = v;
    }
    return { status: r.status, data: r.data as XbrlResponse, headers: responseHeaders };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const responseHeaders: Record<string, string> = {};
      if (err.response?.headers) {
        for (const [k, v] of Object.entries(err.response.headers)) {
          if (typeof v === 'string') responseHeaders[k] = v;
        }
      }
      return {
        status: err.response?.status ?? 0,
        headers: responseHeaders,
        error: `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data).slice(0, 200)}`
      };
    }
    return { status: 0, error: String(err) };
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== SEC EDGAR XBRL Probe ===\n');

  // -------------------------------------------------------
  // Q6 first: test without User-Agent
  // -------------------------------------------------------
  console.log('### Q6 — Rate limits and headers ###\n');
  console.log('--- Without User-Agent ---');
  const noUA = await fetchConcept('CIK0000320193', 'us-gaap/EarningsPerShareDiluted', false);
  console.log(`status: ${noUA.status}`);
  if (noUA.error) console.log('error:', noUA.error);
  if (noUA.headers) {
    console.log('response headers:', JSON.stringify(noUA.headers, null, 2));
  }

  await sleep(500);

  console.log('\n--- With User-Agent ---');
  const withUA = await fetchConcept('CIK0000320193', 'us-gaap/EarningsPerShareDiluted', true);
  console.log(`status: ${withUA.status}`);
  if (withUA.error) console.log('error:', withUA.error);
  if (withUA.headers) {
    const rateLimitHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(withUA.headers)) {
      if (k.toLowerCase().includes('rate') || k.toLowerCase().includes('limit') ||
          k.toLowerCase().includes('retry') || k.toLowerCase().includes('x-') ||
          k.toLowerCase() === 'content-type') {
        rateLimitHeaders[k] = v;
      }
    }
    console.log('rate-limit / notable headers:', JSON.stringify(rateLimitHeaders, null, 2));
    console.log('all headers:', JSON.stringify(withUA.headers, null, 2));
  }

  if (!withUA.data) {
    console.log('No AAPL data — aborting further AAPL tests.');
    return;
  }

  await sleep(500);

  // -------------------------------------------------------
  // Q1 — AAPL Response shape
  // -------------------------------------------------------
  console.log('\n\n### Q1 — AAPL Response shape ###\n');
  const aaplData = withUA.data;
  console.log('Top-level keys:', Object.keys(aaplData));
  console.log('entityName:', aaplData.entityName);
  console.log('taxonomy:', aaplData.taxonomy);
  console.log('tag:', aaplData.tag);
  console.log('units keys:', Object.keys(aaplData.units));

  const usdShares = aaplData.units['USD/shares'];
  if (!usdShares) {
    console.log('No USD/shares unit found. Available units:', Object.keys(aaplData.units));
  } else {
    console.log(`\nusd/shares total entries: ${usdShares.length}`);

    // Full set of fp values
    const fpValues = [...new Set(usdShares.map(e => e.fp))].sort();
    console.log('All fp values:', fpValues);

    // Full set of form values
    const formValues = [...new Set(usdShares.map(e => e.form))].sort();
    console.log('All form values:', formValues);

    // Keys of a single entry
    console.log('\nEntry keys:', Object.keys(usdShares[0]));

    // Sample: find a recent 10-Q
    const recent10Q = [...usdShares].filter(e => e.form === '10-Q').sort((a, b) => b.filed.localeCompare(a.filed))[0];
    console.log('\nSample — recent 10-Q:', JSON.stringify(recent10Q, null, 2));

    // Sample: find a recent 10-K
    const recent10K = [...usdShares].filter(e => e.form === '10-K').sort((a, b) => b.filed.localeCompare(a.filed))[0];
    console.log('\nSample — recent 10-K:', JSON.stringify(recent10K, null, 2));

    // Sample: find an older entry
    const older = [...usdShares].sort((a, b) => a.filed.localeCompare(b.filed))[0];
    console.log('\nSample — oldest entry:', JSON.stringify(older, null, 2));
  }

  // -------------------------------------------------------
  // Q2 — Quarterly vs YTD semantics
  // -------------------------------------------------------
  console.log('\n\n### Q2 — Quarterly vs YTD semantics ###\n');
  if (usdShares) {
    // Find entries with fp=Q2 and form=10-Q
    const q2Entries = usdShares.filter(e => e.fp === 'Q2' && e.form === '10-Q').sort((a, b) => b.end.localeCompare(a.end));
    console.log('fp=Q2, form=10-Q entries (most recent first):');
    q2Entries.slice(0, 6).forEach(e => {
      console.log(`  end=${e.end}, filed=${e.filed}, val=${e.val}, fy=${e.fy}, accn=${e.accn}`);
    });

    // Cross-check: find the entry matching end='2026-03-28' (AAPL Q2 FY26) and end='2025-03-29' (AAPL Q2 FY25)
    const q2fy26 = usdShares.filter(e => e.end === '2026-03-28');
    const q2fy25 = usdShares.filter(e => e.end === '2025-03-29');
    console.log('\nAll entries with end=2026-03-28:', JSON.stringify(q2fy26, null, 2));
    console.log('\nAll entries with end=2025-03-29:', JSON.stringify(q2fy25, null, 2));

    // Also look at Q1 entries to check if Q2 would be cumulative
    const q1Entries = usdShares.filter(e => e.fp === 'Q1' && e.form === '10-Q' && e.fy === 2026);
    console.log('\nfp=Q1, form=10-Q, fy=2026:', JSON.stringify(q1Entries, null, 2));

    // Also show fp=Q1 for fy=2025
    const q1_2025 = usdShares.filter(e => e.fp === 'Q1' && e.form === '10-Q' && e.fy === 2025);
    console.log('\nfp=Q1, form=10-Q, fy=2025:', JSON.stringify(q1_2025, null, 2));
  }

  // -------------------------------------------------------
  // Q3 — How Q4 is reported (10-K)
  // -------------------------------------------------------
  console.log('\n\n### Q3 — How Q4 is reported ###\n');
  if (usdShares) {
    const tenKEntries = usdShares.filter(e => e.form === '10-K').sort((a, b) => b.end.localeCompare(a.end));
    console.log('All 10-K entries (most recent first):');
    tenKEntries.slice(0, 8).forEach(e => {
      console.log(`  end=${e.end}, filed=${e.filed}, val=${e.val}, fp=${e.fp}, fy=${e.fy}, accn=${e.accn}`);
    });

    // Specifically look at end near 2025-09-27 and 2024-09-28
    const fy25annual = usdShares.filter(e => e.end === '2025-09-27');
    const fy24annual = usdShares.filter(e => e.end === '2024-09-28');
    console.log('\nentries with end=2025-09-27:', JSON.stringify(fy25annual, null, 2));
    console.log('\nentries with end=2024-09-28:', JSON.stringify(fy24annual, null, 2));
  }

  // -------------------------------------------------------
  // Q5 — Restatements (same end date, different accn/filed)
  // -------------------------------------------------------
  console.log('\n\n### Q5 — Restatements ###\n');
  if (usdShares) {
    // Group by end date, look for duplicates
    const byEnd: Record<string, XbrlEntry[]> = {};
    for (const e of usdShares) {
      if (!byEnd[e.end]) byEnd[e.end] = [];
      byEnd[e.end].push(e);
    }
    const dupes = Object.entries(byEnd).filter(([, entries]) => entries.length > 1);
    console.log(`End dates with multiple entries: ${dupes.length}`);
    // Show first 5 with multiple entries
    dupes.slice(0, 5).forEach(([end, entries]) => {
      console.log(`\n  end=${end} (${entries.length} entries):`);
      entries.sort((a, b) => b.filed.localeCompare(a.filed)).forEach(e => {
        console.log(`    filed=${e.filed}, val=${e.val}, form=${e.form}, fp=${e.fp}, accn=${e.accn}`);
      });
    });

    // Also look for same end+form+fp duplicates specifically (true restatements)
    const byEndFormFp: Record<string, XbrlEntry[]> = {};
    for (const e of usdShares) {
      const key = `${e.end}|${e.form}|${e.fp}`;
      if (!byEndFormFp[key]) byEndFormFp[key] = [];
      byEndFormFp[key].push(e);
    }
    const trueDupes = Object.entries(byEndFormFp).filter(([, entries]) => entries.length > 1);
    console.log(`\nSame end+form+fp with multiple accn/filed: ${trueDupes.length}`);
    trueDupes.slice(0, 5).forEach(([key, entries]) => {
      console.log(`\n  key=${key} (${entries.length} entries):`);
      entries.sort((a, b) => b.filed.localeCompare(a.filed)).forEach(e => {
        console.log(`    filed=${e.filed}, val=${e.val}, accn=${e.accn}`);
      });
    });
  }

  // -------------------------------------------------------
  // Q8 — Recency lag
  // -------------------------------------------------------
  console.log('\n\n### Q8 — Recency lag ###\n');
  if (usdShares) {
    const sorted = [...usdShares].sort((a, b) => b.filed.localeCompare(a.filed));
    console.log('5 most recently filed entries:');
    sorted.slice(0, 5).forEach(e => {
      console.log(`  filed=${e.filed}, end=${e.end}, form=${e.form}, fp=${e.fp}, val=${e.val}`);
    });

    // Most recent 10-Q entry
    const mostRecentQ = usdShares.filter(e => e.form === '10-Q').sort((a, b) => b.filed.localeCompare(a.filed))[0];
    console.log('\nMost recent 10-Q entry:', JSON.stringify(mostRecentQ, null, 2));

    // Most recent 10-K entry
    const mostRecentK = usdShares.filter(e => e.form === '10-K').sort((a, b) => b.filed.localeCompare(a.filed))[0];
    console.log('\nMost recent 10-K entry:', JSON.stringify(mostRecentK, null, 2));
  }

  await sleep(500);

  // -------------------------------------------------------
  // Q4 — MSFT
  // -------------------------------------------------------
  console.log('\n\n### Q4 — MSFT Response ###\n');
  const msftResult = await fetchConcept('CIK0000789019', 'us-gaap/EarningsPerShareDiluted', true);
  console.log(`MSFT fetch status: ${msftResult.status}`);
  if (!msftResult.data) {
    console.log('No MSFT data:', msftResult.error);
  } else {
    const msft = msftResult.data;
    console.log('entityName:', msft.entityName);
    console.log('units keys:', Object.keys(msft.units));

    const msftShares = msft.units['USD/shares'];
    if (msftShares) {
      console.log(`total entries: ${msftShares.length}`);

      const msftFp = [...new Set(msftShares.map(e => e.fp))].sort();
      console.log('All fp values:', msftFp);

      const msftForms = [...new Set(msftShares.map(e => e.form))].sort();
      console.log('All form values:', msftForms);

      // Recent 10-K entries
      const msftK = msftShares.filter(e => e.form === '10-K').sort((a, b) => b.end.localeCompare(a.end));
      console.log('\n10-K entries (5 most recent):');
      msftK.slice(0, 5).forEach(e => {
        console.log(`  end=${e.end}, filed=${e.filed}, val=${e.val}, fp=${e.fp}, fy=${e.fy}`);
      });

      // Recent 10-Q Q2 entries
      const msftQ2 = msftShares.filter(e => e.fp === 'Q2' && e.form === '10-Q').sort((a, b) => b.end.localeCompare(a.end));
      console.log('\nfp=Q2, form=10-Q entries (5 most recent):');
      msftQ2.slice(0, 5).forEach(e => {
        console.log(`  end=${e.end}, filed=${e.filed}, val=${e.val}, fy=${e.fy}`);
      });

      // Recent 10-Q Q1 entries (for cross-check)
      const msftQ1 = msftShares.filter(e => e.fp === 'Q1' && e.form === '10-Q').sort((a, b) => b.end.localeCompare(a.end));
      console.log('\nfp=Q1, form=10-Q entries (3 most recent):');
      msftQ1.slice(0, 3).forEach(e => {
        console.log(`  end=${e.end}, filed=${e.filed}, val=${e.val}, fy=${e.fy}`);
      });

      // Sample recent 10-Q
      const msftRecentQ = msftShares.filter(e => e.form === '10-Q').sort((a, b) => b.filed.localeCompare(a.filed))[0];
      console.log('\nMost recent 10-Q entry:', JSON.stringify(msftRecentQ, null, 2));

      // MSFT fiscal year: ends June 30. Check fp labels
      // Find a June 30 period end 10-K
      const msftJuneK = msftShares.filter(e => e.form === '10-K' && e.end.includes('-06-'));
      console.log('\n10-K entries ending in June (fiscal year end):');
      msftJuneK.slice(-5).forEach(e => {
        console.log(`  end=${e.end}, filed=${e.filed}, val=${e.val}, fp=${e.fp}, fy=${e.fy}`);
      });
    }
  }

  await sleep(500);

  // -------------------------------------------------------
  // Q7 — Non-US fallback: ASML
  // -------------------------------------------------------
  console.log('\n\n### Q7a — ASML (CIK 0000937966) ###\n');
  const asmlResult = await fetchConcept('CIK0000937966', 'us-gaap/EarningsPerShareDiluted', true);
  console.log(`ASML fetch status: ${asmlResult.status}`);
  if (!asmlResult.data) {
    console.log('No ASML data:', asmlResult.error);
  } else {
    const asml = asmlResult.data;
    console.log('entityName:', asml.entityName);
    console.log('units keys:', Object.keys(asml.units));

    const asmlShares = asml.units['USD/shares'];
    if (asmlShares && asmlShares.length > 0) {
      console.log(`USD/shares entries: ${asmlShares.length}`);
      const recent = [...asmlShares].sort((a, b) => b.end.localeCompare(a.end)).slice(0, 3);
      console.log('Recent USD/shares entries:', JSON.stringify(recent, null, 2));
    } else {
      console.log('No USD/shares entries.');
      // Check for other unit types
      for (const [unit, entries] of Object.entries(asml.units)) {
        console.log(`  unit=${unit}: ${entries.length} entries`);
        if (entries.length > 0) {
          const recent = [...entries].sort((a, b) => b.end.localeCompare(a.end))[0];
          console.log('    most recent:', JSON.stringify(recent));
        }
      }
    }
  }

  await sleep(500);

  // Try ASML with ifrs-full tag
  console.log('\n--- ASML ifrs-full/EarningsPerShareDiluted ---');
  const asmlIfrs = await fetchConcept('CIK0000937966', 'ifrs-full/EarningsPerShareDiluted', true);
  console.log(`status: ${asmlIfrs.status}`);
  if (!asmlIfrs.data) {
    console.log('error:', asmlIfrs.error);
  } else {
    const ifrs = asmlIfrs.data;
    console.log('entityName:', ifrs.entityName);
    console.log('taxonomy:', ifrs.taxonomy);
    console.log('units keys:', Object.keys(ifrs.units));
    for (const [unit, entries] of Object.entries(ifrs.units)) {
      console.log(`  unit=${unit}: ${entries.length} entries`);
      if (entries.length > 0) {
        const recent = [...entries].sort((a, b) => b.end.localeCompare(a.end)).slice(0, 3);
        console.log('  recent:', JSON.stringify(recent, null, 2));
      }
    }
  }

  await sleep(500);

  // Q7b — Nestlé: just try a completely bogus CIK to show the error shape
  console.log('\n\n### Q7b — Nestlé (no SEC CIK) ###\n');
  console.log('Nestlé does not file with SEC. Attempting CIK lookup for illustration...');
  const nesn = await fetchConcept('CIK0000000000', 'us-gaap/EarningsPerShareDiluted', true);
  console.log(`status: ${nesn.status}`);
  console.log('error:', nesn.error ?? 'none');
  if (nesn.headers) {
    console.log('headers:', JSON.stringify(nesn.headers, null, 2));
  }

  // Also try the EDGAR company search to confirm Nestlé doesn't appear
  console.log('\nAttempting EDGAR company search for "Nestle"...');
  try {
    const searchResult = await axios.get(
      'https://efts.sec.gov/LATEST/search-index?q=%22Nestle%22&dateRange=custom&startdt=2020-01-01&forms=20-F',
      { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 }
    );
    console.log(`EDGAR search status: ${searchResult.status}`);
    console.log('Search result sample:', JSON.stringify(searchResult.data).slice(0, 500));
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.log(`EDGAR search error: ${err.response?.status}`);
    }
  }

  console.log('\n=== Probe complete ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
