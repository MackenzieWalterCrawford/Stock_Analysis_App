-- CreateTable
CREATE TABLE "stock_prices" (
    "id" SERIAL NOT NULL,
    "symbol" VARCHAR(10) NOT NULL,
    "date" DATE NOT NULL,
    "open" DECIMAL(12,4) NOT NULL,
    "high" DECIMAL(12,4) NOT NULL,
    "low" DECIMAL(12,4) NOT NULL,
    "close" DECIMAL(12,4) NOT NULL,
    "volume" BIGINT NOT NULL,
    "change" DECIMAL(12,4) NOT NULL,
    "changePercent" DECIMAL(12,6) NOT NULL,
    "vwap" DECIMAL(12,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_ratios" (
    "id" SERIAL NOT NULL,
    "symbol" VARCHAR(10) NOT NULL,
    "date" DATE NOT NULL,
    "peRatio" DECIMAL(12,4),
    "priceToFcf" DECIMAL(12,4),
    "priceToOcf" DECIMAL(12,4),
    "marketCap" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_ratios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_prices_symbol_date_idx" ON "stock_prices"("symbol", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "stock_prices_symbol_date_key" ON "stock_prices"("symbol", "date");

-- CreateIndex
CREATE INDEX "financial_ratios_symbol_date_idx" ON "financial_ratios"("symbol", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "financial_ratios_symbol_date_key" ON "financial_ratios"("symbol", "date");
