import { ChunkGenerator, type GeneratedChunk } from './chunk-generator.js';
import { CHUNK_SIZE } from './constants.js';

interface CacheEntry {
  chunk: GeneratedChunk;
  lastAccessed: number;
  accessCount: number;
}

/**
 * LRU cache for generated chunks
 */
export class ChunkCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private generator: ChunkGenerator;

  constructor(generator: ChunkGenerator, maxSize: number = 256) {
    this.generator = generator;
    this.maxSize = maxSize;
  }

  private getKey(chunkX: number, chunkY: number): string {
    return `${chunkX},${chunkY}`;
  }

  /**
   * Get chunk, generating if not cached
   */
  getChunk(chunkX: number, chunkY: number): GeneratedChunk {
    const key = this.getKey(chunkX, chunkY);

    const cached = this.cache.get(key);
    if (cached) {
      cached.lastAccessed = Date.now();
      cached.accessCount++;
      return cached.chunk;
    }

    // Generate chunk
    const chunk = this.generator.generateChunk(chunkX, chunkY);

    // Evict if necessary
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      chunk,
      lastAccessed: Date.now(),
      accessCount: 1,
    });

    return chunk;
  }

  /**
   * Get tile at world coordinates
   */
  getTileAt(worldX: number, worldY: number): {
    char: string;
    fg?: string;
    bg?: string;
  } | null {
    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkY = Math.floor(worldY / CHUNK_SIZE);

    const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

    const chunk = this.getChunk(chunkX, chunkY);
    const tile = chunk.tiles[localY]?.[localX];

    if (!tile) return null;

    return {
      char: tile.char,
      fg: tile.fg,
      bg: tile.bg,
    };
  }

  /**
   * Get chunks needed to fill a viewport
   */
  getChunksForViewport(
    viewportX: number,
    viewportY: number,
    viewportWidth: number,
    viewportHeight: number
  ): GeneratedChunk[] {
    const chunks: GeneratedChunk[] = [];

    const minChunkX = Math.floor(viewportX / CHUNK_SIZE);
    const maxChunkX = Math.floor((viewportX + viewportWidth - 1) / CHUNK_SIZE);
    const minChunkY = Math.floor(viewportY / CHUNK_SIZE);
    const maxChunkY = Math.floor((viewportY + viewportHeight - 1) / CHUNK_SIZE);

    for (let cy = minChunkY; cy <= maxChunkY; cy++) {
      for (let cx = minChunkX; cx <= maxChunkX; cx++) {
        chunks.push(this.getChunk(cx, cy));
      }
    }

    return chunks;
  }

  /**
   * Evict least recently used chunk
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Preload chunks around a position
   */
  preloadAround(centerX: number, centerY: number, radius: number = 2): void {
    const centerChunkX = Math.floor(centerX / CHUNK_SIZE);
    const centerChunkY = Math.floor(centerY / CHUNK_SIZE);

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        this.getChunk(centerChunkX + dx, centerChunkY + dy);
      }
    }
  }

  /**
   * Get cache stats
   */
  getStats(): { size: number; maxSize: number; hitRate: number } {
    let totalAccess = 0;
    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount;
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.cache.size > 0 ? totalAccess / this.cache.size : 0,
    };
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the underlying generator
   */
  getGenerator(): ChunkGenerator {
    return this.generator;
  }
}
