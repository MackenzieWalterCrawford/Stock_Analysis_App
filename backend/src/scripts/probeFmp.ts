import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function probe(label: string, url: string) {
  console.log(`\n--- ${label} ---`);
  console.log(`URL: ${url.replace(process.env.FMP_API_KEY || '', '<KEY>')}`);
  try {
    const response = await axios.get(url, { timeout: 20000 });
    const data = response.data;
    if (Array.isArray(data)) {
      console.log(`status=${response.status}, array length=${data.length}`);
      if (data.length > 0) {
        console.log('first record keys:', Object.keys(data[0]).slice(0, 12));
        console.log('first record sample:', JSON.stringify(data[0], null, 2).slice(0, 500));
      }
    } else {
      console.log(`status=${response.status}, body:`, JSON.stringify(data).slice(0, 500));
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.log(`status=${err.response?.status} (${err.response?.statusText})`);
      console.log('body:', JSON.stringify(err.response?.data).slice(0, 500));
    } else {
      console.log('unexpected error:', err);
    }
  }
}

async function main() {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    console.error('FMP_API_KEY not set');
    process.exit(1);
  }

  await probe(
    'v3 key-metrics (quarter)',
    `https://financialmodelingprep.com/api/v3/key-metrics/AAPL?period=quarter&limit=8&apikey=${key}`
  );
  await probe(
    'v3 income-statement (quarter)',
    `https://financialmodelingprep.com/api/v3/income-statement/AAPL?period=quarter&limit=8&apikey=${key}`
  );
  await probe(
    'stable key-metrics (limit=5)',
    `https://financialmodelingprep.com/stable/key-metrics?symbol=AAPL&period=quarter&limit=5&apikey=${key}`
  );
  await probe(
    'stable income-statement (limit=5)',
    `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&limit=5&apikey=${key}`
  );
  await probe(
    'stable ratios (limit=5)',
    `https://financialmodelingprep.com/stable/ratios?symbol=AAPL&period=quarter&limit=5&apikey=${key}`
  );
  await probe(
    'stable key-metrics (annual default, limit=5)',
    `https://financialmodelingprep.com/stable/key-metrics?symbol=AAPL&limit=5&apikey=${key}`
  );
  await probe(
    'stable ratios (annual default, limit=5)',
    `https://financialmodelingprep.com/stable/ratios?symbol=AAPL&limit=5&apikey=${key}`
  );

  // Dump full income statement keys to confirm eps fields
  console.log('\n--- income-statement full first-record keys ---');
  const resp = await axios.get(
    `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&limit=1&apikey=${key}`
  );
  const first = resp.data[0];
  console.log('all keys:', Object.keys(first));
  console.log('eps:', first.eps, 'epsDiluted:', first.epsDiluted, 'revenue:', first.revenue, 'period:', first.period);
}

main();
