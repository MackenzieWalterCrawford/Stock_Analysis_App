import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function probe(label: string, url: string) {
  console.log(`\n--- ${label} ---`);
  const key = process.env.FMP_API_KEY || '';
  console.log(`URL: ${url.replace(key, '<KEY>')}`);
  try {
    const r = await axios.get(url, { timeout: 20000 });
    const d = r.data;
    if (Array.isArray(d)) {
      console.log(`status=${r.status}, length=${d.length}`);
      if (d.length > 0) {
        const dates = d.map((x: any) => `${x.date}(${x.period ?? '-'})`).join(', ');
        console.log('dates/periods:', dates);
        if (d[0].eps != null || d[0].epsDiluted != null) {
          const epsSummary = d.map((x: any) => `${x.date}=${x.epsDiluted ?? x.eps}`).join(' ');
          console.log('eps:', epsSummary);
        }
      }
    } else {
      console.log(`status=${r.status}, body:`, JSON.stringify(d).slice(0, 400));
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.log(`status=${err.response?.status}, body:`, JSON.stringify(err.response?.data).slice(0, 400));
    } else {
      console.log('err:', err);
    }
  }
}

async function main() {
  const k = process.env.FMP_API_KEY || '';
  // Try larger limits
  await probe('limit=10', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&limit=10&apikey=${k}`);
  await probe('limit=20', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&limit=20&apikey=${k}`);
  // date-windowed
  await probe('from/to 2023', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&from=2023-01-01&to=2024-12-31&limit=5&apikey=${k}`);
  // historical EPS endpoint variants
  await probe('historical-eps', `https://financialmodelingprep.com/stable/historical-eps?symbol=AAPL&apikey=${k}`);
  await probe('earnings', `https://financialmodelingprep.com/stable/earnings?symbol=AAPL&limit=20&apikey=${k}`);
  await probe('earnings-surprises', `https://financialmodelingprep.com/stable/earnings-surprises?symbol=AAPL&limit=20&apikey=${k}`);
  // Annual default (might have higher limit allowance)
  await probe('annual limit=20', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&limit=20&apikey=${k}`);
  // Try "FY" period explicitly
  await probe('period=FY limit=10', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=FY&limit=10&apikey=${k}`);
  // Earnings family at limit=5 (within plan cap)
  await probe('earnings limit=5', `https://financialmodelingprep.com/stable/earnings?symbol=AAPL&limit=5&apikey=${k}`);
  await probe('earnings-surprises limit=5', `https://financialmodelingprep.com/stable/earnings-surprises?symbol=AAPL&limit=5&apikey=${k}`);
  await probe('earnings-historical limit=5', `https://financialmodelingprep.com/stable/earnings-historical?symbol=AAPL&limit=5&apikey=${k}`);
  await probe('earning-historical limit=5', `https://financialmodelingprep.com/stable/earning-historical?symbol=AAPL&limit=5&apikey=${k}`);
  await probe('historical/earnings', `https://financialmodelingprep.com/stable/historical/earnings?symbol=AAPL&limit=5&apikey=${k}`);
  // Try date-shifted income-statement to walk back history
  await probe('to=2024-06-30 limit=5', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&to=2024-06-30&limit=5&apikey=${k}`);
  await probe('to=2025-01-01 limit=5', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&to=2025-01-01&limit=5&apikey=${k}`);
  // Default limit (no limit param)
  await probe('no limit param', `https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&period=quarter&apikey=${k}`);
}

main();
