import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getCacheService } from './services/cache';
import { stockRouter } from './routes/stockRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/stocks', stockRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

async function main() {
  try {
    await getCacheService().connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.warn('Redis connection failed, continuing without cache:', err);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

main().catch(console.error);
