import { FundamentalFetcher } from '../services/fundamentalFetcher';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const fetcher = new FundamentalFetcher();
  const result = await fetcher.syncFundamentals('AAPL');
  console.log('=== syncFundamentals result ===');
  console.log(JSON.stringify(result, null, 2));
  await fetcher.disconnect();
}

main().catch((err) => {
  console.error('TOP-LEVEL ERROR:', err);
  process.exit(1);
});
