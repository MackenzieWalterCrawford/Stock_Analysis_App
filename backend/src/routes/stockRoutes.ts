import { Router } from 'express';
import {
  getHistory,
  getLatest,
  getRatio,
  syncStock,
  getDateRange,
} from '../controllers/stockController';

export const stockRouter = Router();

// Must be registered before /:symbol routes to prevent 'ratio' matching as a symbol param
stockRouter.get('/ratio', getRatio);

stockRouter.get('/:symbol/history', getHistory);
stockRouter.get('/:symbol/latest', getLatest);
stockRouter.post('/:symbol/sync', syncStock);
stockRouter.get('/:symbol/date-range', getDateRange);
