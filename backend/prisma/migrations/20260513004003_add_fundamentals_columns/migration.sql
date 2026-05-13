-- AlterTable
ALTER TABLE "financial_ratios" ADD COLUMN     "debtToEquity" DECIMAL(12,4),
ADD COLUMN     "eps" DECIMAL(12,4),
ADD COLUMN     "fcf" BIGINT,
ADD COLUMN     "period" VARCHAR(20),
ADD COLUMN     "revenue" BIGINT,
ADD COLUMN     "revenueGrowthYoy" DECIMAL(8,4),
ADD COLUMN     "roe" DECIMAL(8,4);
