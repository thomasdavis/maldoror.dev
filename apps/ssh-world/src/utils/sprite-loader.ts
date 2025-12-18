import type { PixelGrid, DirectionFrames } from '@maldoror/protocol';
import { loadSpriteFrame } from './sprite-storage.js';
import { loadBuildingTile } from './building-storage.js';

type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * LRU Cache for loaded pixel grids
 * Evicts least recently used entries when size limit is reached
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key exists, delete it first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Delete all entries matching a prefix
   */
  deleteByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Sprite Loader with LRU caching
 * Loads sprite frames on demand and caches them
 */
export class SpriteLoader {
  private cache: LRUCache<string, PixelGrid>;
  private loadingPromises = new Map<string, Promise<PixelGrid | null>>();

  constructor(maxCacheEntries = 1000) {
    // Default: ~1000 frames cached
    // 4 directions × 4 frames × ~60 sprites = ~960 entries for one resolution
    this.cache = new LRUCache(maxCacheEntries);
  }

  private getCacheKey(userId: string, direction: string, frameNum: number, resolution: number): string {
    return `sprite:${userId}:${direction}:${frameNum}:${resolution}`;
  }

  /**
   * Load a single sprite frame, with caching
   */
  async loadFrame(
    userId: string,
    direction: Direction,
    frameNum: number,
    resolution: number
  ): Promise<PixelGrid | null> {
    const key = this.getCacheKey(userId, direction, frameNum, resolution);

    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    // Check if already loading
    const loading = this.loadingPromises.get(key);
    if (loading) {
      return loading;
    }

    // Load from disk
    const promise = loadSpriteFrame(userId, direction, frameNum, resolution);
    this.loadingPromises.set(key, promise);

    try {
      const pixels = await promise;
      if (pixels) {
        this.cache.set(key, pixels);
      }
      return pixels;
    } finally {
      this.loadingPromises.delete(key);
    }
  }

  /**
   * Load all frames for a direction at a specific resolution
   */
  async loadDirection(
    userId: string,
    direction: Direction,
    resolution: number
  ): Promise<DirectionFrames | null> {
    const frames: PixelGrid[] = [];

    for (let frameNum = 0; frameNum < 4; frameNum++) {
      const frame = await this.loadFrame(userId, direction, frameNum, resolution);
      if (!frame) return null;
      frames.push(frame);
    }

    return frames as DirectionFrames;
  }

  /**
   * Preload all frames for a sprite at a specific resolution
   */
  async preload(userId: string, resolution: number): Promise<void> {
    const directions: Direction[] = ['up', 'down', 'left', 'right'];
    const promises: Promise<PixelGrid | null>[] = [];

    for (const direction of directions) {
      for (let frameNum = 0; frameNum < 4; frameNum++) {
        promises.push(this.loadFrame(userId, direction, frameNum, resolution));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Clear cache for a specific user
   */
  clearUser(userId: string): void {
    this.cache.deleteByPrefix(`sprite:${userId}:`);
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

/**
 * Building Loader with LRU caching
 * Loads building tiles on demand and caches them
 */
export class BuildingLoader {
  private cache: LRUCache<string, PixelGrid>;
  private loadingPromises = new Map<string, Promise<PixelGrid | null>>();

  constructor(maxCacheEntries = 500) {
    // Default: ~500 tiles cached
    // 9 tiles × ~50 buildings = ~450 entries for one resolution
    this.cache = new LRUCache(maxCacheEntries);
  }

  private getCacheKey(buildingId: string, tileX: number, tileY: number, resolution: number): string {
    return `building:${buildingId}:${tileX}:${tileY}:${resolution}`;
  }

  /**
   * Load a single building tile, with caching
   */
  async loadTile(
    buildingId: string,
    tileX: number,
    tileY: number,
    resolution: number
  ): Promise<PixelGrid | null> {
    const key = this.getCacheKey(buildingId, tileX, tileY, resolution);

    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    // Check if already loading
    const loading = this.loadingPromises.get(key);
    if (loading) {
      return loading;
    }

    // Load from disk
    const promise = loadBuildingTile(buildingId, tileX, tileY, resolution);
    this.loadingPromises.set(key, promise);

    try {
      const pixels = await promise;
      if (pixels) {
        this.cache.set(key, pixels);
      }
      return pixels;
    } finally {
      this.loadingPromises.delete(key);
    }
  }

  /**
   * Load all tiles for a building at a specific resolution
   * Returns a 3x3 array of PixelGrids
   */
  async loadBuilding(
    buildingId: string,
    resolution: number
  ): Promise<PixelGrid[][] | null> {
    const tiles: PixelGrid[][] = [];

    for (let tileY = 0; tileY < 3; tileY++) {
      const row: PixelGrid[] = [];
      for (let tileX = 0; tileX < 3; tileX++) {
        const tile = await this.loadTile(buildingId, tileX, tileY, resolution);
        if (!tile) return null;
        row.push(tile);
      }
      tiles.push(row);
    }

    return tiles;
  }

  /**
   * Preload all tiles for a building at a specific resolution
   */
  async preload(buildingId: string, resolution: number): Promise<void> {
    const promises: Promise<PixelGrid | null>[] = [];

    for (let tileY = 0; tileY < 3; tileY++) {
      for (let tileX = 0; tileX < 3; tileX++) {
        promises.push(this.loadTile(buildingId, tileX, tileY, resolution));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Clear cache for a specific building
   */
  clearBuilding(buildingId: string): void {
    this.cache.deleteByPrefix(`building:${buildingId}:`);
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

// Global singleton instances
let globalSpriteLoader: SpriteLoader | null = null;
let globalBuildingLoader: BuildingLoader | null = null;

/**
 * Get the global sprite loader instance
 */
export function getSpriteLoader(): SpriteLoader {
  if (!globalSpriteLoader) {
    globalSpriteLoader = new SpriteLoader();
  }
  return globalSpriteLoader;
}

/**
 * Get the global building loader instance
 */
export function getBuildingLoader(): BuildingLoader {
  if (!globalBuildingLoader) {
    globalBuildingLoader = new BuildingLoader();
  }
  return globalBuildingLoader;
}
