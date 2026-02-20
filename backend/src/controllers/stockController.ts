import { Request, Response } from 'express';
import { createStockService, StockServiceError } from '../services/stockService';

const stockService = createStockService();

const VALID_TIMEFRAMES = ['5Y', '1Y', 'YTD', '1M', '1W'];

function isValidSymbol(s: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(s);
}

function isValidTimeframe(t: string): boolean {
  return VALID_TIMEFRAMES.includes(t);
}

/** Safely coerce an Express param/query value to a plain string */
function str(val: unknown, fallback = ''): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return fallback;
}

function toJSON(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  );
}

function getStatusCode(err: StockServiceError): number {
  switch (err.code) {
    case 'INVALID_TIMEFRAME':
      return 400;
    case 'NO_DATA':
      return 404;
    case 'DATABASE_ERROR':
      return 500;
    default:
      return 500;
  }
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  const symbol = str(req.params.symbol);
  const timeframe = str(req.query.timeframe, '1M');

  if (!isValidSymbol(symbol)) {
    res.status(400).json({ success: false, error: 'Invalid symbol' });
    return;
  }
  if (!isValidTimeframe(timeframe)) {
    res
      .status(400)
      .json({ success: false, error: 'Invalid timeframe. Must be one of: 5Y, 1Y, YTD, 1M, 1W' });
    return;
  }

  try {
    const data = await stockService.getHistoricalData(symbol.toUpperCase(), timeframe);
    res.json({ success: true, data: toJSON(data) });
  } catch (err) {
    if (err instanceof StockServiceError) {
      res.status(getStatusCode(err)).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export async function getLatest(req: Request, res: Response): Promise<void> {
  const symbol = str(req.params.symbol);

  if (!isValidSymbol(symbol)) {
    res.status(400).json({ success: false, error: 'Invalid symbol' });
    return;
  }

  try {
    const data = await stockService.getHistoricalData(symbol.toUpperCase(), '1W');
    const latest = data[data.length - 1] ?? null;
    if (!latest) {
      res.status(404).json({ success: false, error: 'No data found' });
      return;
    }
    res.json({ success: true, data: toJSON(latest) });
  } catch (err) {
    if (err instanceof StockServiceError) {
      res.status(getStatusCode(err)).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export async function getRatio(req: Request, res: Response): Promise<void> {
  const base = str(req.query.base);
  const compare = str(req.query.compare);
  const timeframe = str(req.query.timeframe, '1M');

  if (!isValidSymbol(base)) {
    res.status(400).json({ success: false, error: 'Invalid or missing base symbol' });
    return;
  }
  if (!isValidSymbol(compare)) {
    res.status(400).json({ success: false, error: 'Invalid or missing compare symbol' });
    return;
  }
  if (!isValidTimeframe(timeframe)) {
    res
      .status(400)
      .json({ success: false, error: 'Invalid timeframe. Must be one of: 5Y, 1Y, YTD, 1M, 1W' });
    return;
  }

  try {
    const data = await stockService.getPriceRatio(
      base.toUpperCase(),
      compare.toUpperCase(),
      timeframe
    );
    res.json({ success: true, data: toJSON(data) });
  } catch (err) {
    if (err instanceof StockServiceError) {
      res.status(getStatusCode(err)).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export async function syncStock(req: Request, res: Response): Promise<void> {
  const symbol = str(req.params.symbol);

  if (!isValidSymbol(symbol)) {
    res.status(400).json({ success: false, error: 'Invalid symbol' });
    return;
  }

  try {
    const result = await stockService.refreshData(symbol.toUpperCase());
    res.json({ success: true, data: toJSON(result) });
  } catch (err) {
    if (err instanceof StockServiceError) {
      res.status(getStatusCode(err)).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export async function getDateRange(req: Request, res: Response): Promise<void> {
  const symbol = str(req.params.symbol);

  if (!isValidSymbol(symbol)) {
    res.status(400).json({ success: false, error: 'Invalid symbol' });
    return;
  }

  try {
    const range = await stockService.getAvailableDateRange(symbol.toUpperCase());
    res.json({ success: true, data: range });
  } catch (err) {
    if (err instanceof StockServiceError) {
      res.status(getStatusCode(err)).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
