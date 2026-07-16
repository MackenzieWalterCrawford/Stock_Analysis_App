-- AlterTable: add TTM ratio-component columns declared in schema.prisma but
-- never migrated (EV/EBITDA, ROIC, PEG, Debt-to-EBITDA all depend on these).
ALTER TABLE "financial_ratios" ADD COLUMN     "ebitdaTtm" BIGINT,
ADD COLUMN     "dilutedShares" BIGINT,
ADD COLUMN     "totalDebt" BIGINT,
ADD COLUMN     "cashAndEquivalents" BIGINT,
ADD COLUMN     "epsGrowthYoy" DECIMAL(8,4),
ADD COLUMN     "roic" DECIMAL(8,4);
