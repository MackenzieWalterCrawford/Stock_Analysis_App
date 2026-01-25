import { createClient, RedisClientType } from 'redis';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** Cache service configuration options */
export interface CacheConfig {
  /** Redis connection URL (default: redis://localhost:6379) */
  url?: string;
  /** Enable/disable caching (default: true) */
  enabled?: boolean;
  /** Default TTL in seconds (default: 3600) */
  defaultTTL?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

/** Supported timeframe values for stock data */
export type Timeframe = '1W' | '1M' | 'YTD' | '1Y' | '5Y';

/** TTL values in seconds for each timeframe */
const TIMEFRAME_TTL: Record<Timeframe, number> = {
  '5Y': 24 * 60 * 60,  // 24 hours
  '1Y': 12 * 60 * 60,  // 12 hours
  'YTD': 6 * 60 * 60,  // 6 hours
  '1M': 3 * 60 * 60,   // 3 hours
  '1W': 1 * 60 * 60,   // 1 hour
};

// ============================================================================
// CacheService
// ============================================================================

export class CacheService {
  private client: RedisClientType;
  private connected: boolean = false;
  private enabled: boolean;
  private defaultTTL: number;
  private debug: boolean;
  private reconnecting: boolean = false;

  /**
   * Create a new CacheService instance
   * @param config - Optional configuration options
   */
  constructor(config: CacheConfig = {}) {
    const redisUrl = config.url || process.env.REDIS_URL || 'redis://localhost:6379';
    this.enabled = config.enabled ?? (process.env.USE_CACHE !== 'false');
    this.defaultTTL = config.defaultTTL ?? 3600;
    this.debug = config.debug ?? (process.env.NODE_ENV === 'development');

    this.client = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            this.log('Max reconnection attempts reached, stopping reconnection');
            return new Error('Max reconnection attempts reached');
          }
          const delay = Math.min(retries * 100, 3000);
          this.log(`Reconnecting in ${delay}ms (attempt ${retries})`);
          return delay;
        },
      },
    });

    this.setupEventHandlers();
  }

  // --------------------------------------------------------------------------
  // Connection Management
  // --------------------------------------------------------------------------

  /**
   * Connect to Redis server
   * @returns Promise that resolves when connected
   */
  async connect(): Promise<void> {
    if (!this.enabled) {
      this.log('Caching is disabled via configuration');
      return;
    }

    if (this.connected) {
      return;
    }

    try {
      await this.client.connect();
      this.connected = true;
      console.log('[CacheService] Connected to Redis');
    } catch (error) {
      console.warn('[CacheService] Failed to connect to Redis:', this.getErrorMessage(error));
      this.connected = false;
    }
  }

  /**
   * Disconnect from Redis server
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      await this.client.quit();
      this.connected = false;
      console.log('[CacheService] Disconnected from Redis');
    } catch (error) {
      console.warn('[CacheService] Error during disconnect:', this.getErrorMessage(error));
      this.connected = false;
    }
  }

  /**
   * Check if Redis is currently connected
   * @returns true if connected, false otherwise
   */
  isConnected(): boolean {
    return this.connected && this.enabled;
  }

  // --------------------------------------------------------------------------
  // Core Cache Operations
  // --------------------------------------------------------------------------

  /**
   * Retrieve cached data by key
   * @param key - Cache key to retrieve
   * @returns Cached value or null if not found/unavailable
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const data = await this.client.get(key);

      if (data === null) {
        this.logDebug(`Cache miss: ${key}`);
        return null;
      }

      const parsed = JSON.parse(data) as T;
      this.logDebug(`Cache hit: ${key}`);
      return parsed;
    } catch (error) {
      console.warn(`[CacheService] Error getting key "${key}":`, this.getErrorMessage(error));
      return null;
    }
  }

  /**
   * Store data in cache with optional TTL
   * @param key - Cache key
   * @param value - Value to cache (will be JSON serialized)
   * @param ttlSeconds - Time to live in seconds (optional, uses defaultTTL if not provided)
   */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      const ttl = ttlSeconds ?? this.defaultTTL;

      if (ttl > 0) {
        await this.client.setEx(key, ttl, serialized);
      } else {
        await this.client.set(key, serialized);
      }

      this.logDebug(`Cache set: ${key} (TTL: ${ttl}s)`);
    } catch (error) {
      console.warn(`[CacheService] Error setting key "${key}":`, this.getErrorMessage(error));
    }
  }

  /**
   * Remove a specific key from cache
   * @param key - Cache key to delete
   */
  async delete(key: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.client.del(key);
      this.logDebug(`Cache delete: ${key}`);
    } catch (error) {
      console.warn(`[CacheService] Error deleting key "${key}":`, this.getErrorMessage(error));
    }
  }

  /**
   * Clear all data from the cache
   * Use with caution - this removes all cached data
   */
  async flush(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.client.flushDb();
      console.log('[CacheService] Cache flushed');
    } catch (error) {
      console.warn('[CacheService] Error flushing cache:', this.getErrorMessage(error));
    }
  }

  // --------------------------------------------------------------------------
  // Stock-Specific Cache Methods
  // --------------------------------------------------------------------------

  /**
   * Get cached stock historical data
   * @param symbol - Stock ticker symbol
   * @param timeframe - Data timeframe
   * @returns Cached data or null
   */
  async getStockHistory<T>(symbol: string, timeframe: string): Promise<T | null> {
    const key = this.buildStockHistoryKey(symbol, timeframe);
    return this.get<T>(key);
  }

  /**
   * Cache stock historical data
   * @param symbol - Stock ticker symbol
   * @param timeframe - Data timeframe
   * @param data - Data to cache
   */
  async setStockHistory(symbol: string, timeframe: string, data: unknown): Promise<void> {
    const key = this.buildStockHistoryKey(symbol, timeframe);
    const ttl = this.getTTLForTimeframe(timeframe);
    await this.set(key, data, ttl);
  }

  /**
   * Get cached price ratio data
   * @param symbol1 - First stock symbol
   * @param symbol2 - Second stock symbol
   * @param timeframe - Data timeframe
   * @returns Cached data or null
   */
  async getPriceRatio<T>(symbol1: string, symbol2: string, timeframe: string): Promise<T | null> {
    const key = this.buildPriceRatioKey(symbol1, symbol2, timeframe);
    return this.get<T>(key);
  }

  /**
   * Cache price ratio data
   * @param symbol1 - First stock symbol
   * @param symbol2 - Second stock symbol
   * @param timeframe - Data timeframe
   * @param data - Data to cache
   */
  async setPriceRatio(symbol1: string, symbol2: string, timeframe: string, data: unknown): Promise<void> {
    const key = this.buildPriceRatioKey(symbol1, symbol2, timeframe);
    const ttl = this.getTTLForTimeframe(timeframe);
    await this.set(key, data, ttl);
  }

  /**
   * Invalidate all cached data for a specific stock symbol
   * @param symbol - Stock ticker symbol
   */
  async invalidateStock(symbol: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const pattern = `stock:*:${symbol.toUpperCase()}:*`;
      const keys = await this.client.keys(pattern);

      if (keys.length > 0) {
        await this.client.del(keys);
        this.log(`Invalidated ${keys.length} cache entries for ${symbol}`);
      }
    } catch (error) {
      console.warn(`[CacheService] Error invalidating stock "${symbol}":`, this.getErrorMessage(error));
    }
  }

  // --------------------------------------------------------------------------
  // Cache Key Builders
  // --------------------------------------------------------------------------

  /**
   * Build cache key for stock historical data
   * @param symbol - Stock ticker symbol
   * @param timeframe - Data timeframe
   * @returns Formatted cache key
   */
  buildStockHistoryKey(symbol: string, timeframe: string): string {
    return `stock:history:${symbol.toUpperCase()}:${timeframe}`;
  }

  /**
   * Build cache key for price ratio data
   * @param symbol1 - First stock symbol
   * @param symbol2 - Second stock symbol
   * @param timeframe - Data timeframe
   * @returns Formatted cache key
   */
  buildPriceRatioKey(symbol1: string, symbol2: string, timeframe: string): string {
    return `stock:ratio:${symbol1.toUpperCase()}:${symbol2.toUpperCase()}:${timeframe}`;
  }

  // --------------------------------------------------------------------------
  // TTL Management
  // --------------------------------------------------------------------------

  /**
   * Get the appropriate TTL for a given timeframe
   * @param timeframe - Data timeframe (1W, 1M, YTD, 1Y, 5Y)
   * @returns TTL in seconds
   */
  getTTLForTimeframe(timeframe: string): number {
    const tf = timeframe.toUpperCase() as Timeframe;
    return TIMEFRAME_TTL[tf] ?? this.defaultTTL;
  }

  // --------------------------------------------------------------------------
  // Cache Warmup
  // --------------------------------------------------------------------------

  /**
   * Pre-populate cache with data for frequently requested stocks
   * @param symbols - Array of stock symbols to warm up
   * @param dataFetcher - Function to fetch data for a symbol
   */
  async warmup<T>(
    symbols: string[],
    dataFetcher: (symbol: string, timeframe: string) => Promise<T>
  ): Promise<void> {
    if (!this.isAvailable()) {
      console.log('[CacheService] Skipping warmup - cache not available');
      return;
    }

    console.log(`[CacheService] Starting cache warmup for ${symbols.length} symbols`);

    const timeframes: Timeframe[] = ['1Y', '1M', '1W'];

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        try {
          const key = this.buildStockHistoryKey(symbol, timeframe);
          const existing = await this.client.exists(key);

          if (!existing) {
            const data = await dataFetcher(symbol, timeframe);
            await this.setStockHistory(symbol, timeframe, data);
            this.logDebug(`Warmed up: ${symbol} ${timeframe}`);
          }
        } catch (error) {
          console.warn(
            `[CacheService] Warmup failed for ${symbol} ${timeframe}:`,
            this.getErrorMessage(error)
          );
        }
      }
    }

    console.log('[CacheService] Cache warmup complete');
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Setup Redis client event handlers
   */
  private setupEventHandlers(): void {
    this.client.on('error', (error) => {
      console.error('[CacheService] Redis error:', this.getErrorMessage(error));
      this.connected = false;
    });

    this.client.on('connect', () => {
      this.log('Connecting to Redis...');
    });

    this.client.on('ready', () => {
      this.connected = true;
      this.reconnecting = false;
      this.log('Redis connection ready');
    });

    this.client.on('end', () => {
      this.connected = false;
      this.log('Redis connection closed');
    });

    this.client.on('reconnecting', () => {
      this.reconnecting = true;
      this.log('Attempting to reconnect to Redis...');
    });
  }

  /**
   * Check if cache operations are available
   */
  private isAvailable(): boolean {
    if (!this.enabled) {
      return false;
    }

    if (!this.connected) {
      this.logDebug('Cache operation skipped - not connected');
      return false;
    }

    return true;
  }

  /**
   * Extract error message from unknown error type
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Log a message with the CacheService prefix
   */
  private log(message: string): void {
    console.log(`[CacheService] ${message}`);
  }

  /**
   * Log a debug message (only in debug mode)
   */
  private logDebug(message: string): void {
    if (this.debug) {
      console.log(`[CacheService] ${message}`);
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let cacheInstance: CacheService | null = null;

/**
 * Get the singleton CacheService instance
 * Creates a new instance if one doesn't exist
 * @param config - Optional configuration (only used on first call)
 * @returns CacheService singleton instance
 */
export function getCacheService(config?: CacheConfig): CacheService {
  if (!cacheInstance) {
    cacheInstance = new CacheService(config);
  }
  return cacheInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export async function resetCacheService(): Promise<void> {
  if (cacheInstance) {
    await cacheInstance.disconnect();
    cacheInstance = null;
  }
}

// Export types and default instance
export default CacheService;
