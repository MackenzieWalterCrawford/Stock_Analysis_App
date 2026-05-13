import { PrismaClient } from '../generated/prisma';
import { FundamentalFetcher } from '../services/fundamentalFetcher';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const prisma = new PrismaClient();
  const deleted = await prisma.financialRatio.deleteMany({ where: { symbol: 'AAPL' } });
  console.log(`Deleted ${deleted.count} existing AAPL fundamental rows`);

  const fetcher = new FundamentalFetcher(prisma);
  const result = await fetcher.syncFundamentals('AAPL');
  console.log('Sync result:', result);

  const rows = await prisma.financialRatio.findMany({
    where: { symbol: 'AAPL' },
    orderBy: { date: 'asc' },
  });
  console.log('\nFinal stored rows:');
  for (const r of rows) {
    console.log({
      date: r.date.toISOString().split('T')[0],
      period: r.period,
      eps: r.eps?.toString() ?? null,
      peRatio: r.peRatio?.toString() ?? null,
    });
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
