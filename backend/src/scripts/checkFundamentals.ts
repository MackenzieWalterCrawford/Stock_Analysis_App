import { PrismaClient } from '../generated/prisma';

async function main() {
  const prisma = new PrismaClient();

  const totalRows = await prisma.financialRatio.count({ where: { symbol: 'AAPL' } });
  console.log(`Total AAPL rows in financial_ratios: ${totalRows}`);

  if (totalRows > 0) {
    const sample = await prisma.financialRatio.findMany({
      where: { symbol: 'AAPL' },
      orderBy: { date: 'desc' },
      take: 5,
    });
    for (const r of sample) {
      console.log({
        date: r.date.toISOString().split('T')[0],
        peRatio: r.peRatio?.toString() ?? null,
        eps: r.eps?.toString() ?? null,
        revenue: r.revenue?.toString() ?? null,
        period: r.period,
      });
    }
  }

  const totalPrices = await prisma.stockPrice.count({ where: { symbol: 'AAPL' } });
  console.log(`Total AAPL rows in stock_prices: ${totalPrices}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
