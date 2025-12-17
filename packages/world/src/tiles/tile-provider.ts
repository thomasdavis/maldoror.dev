import type { Tile, Sprite, PlayerVisualState, PixelGrid, RGB, WorldDataProvider, Pixel, DirectionFrames } from '@maldoror/protocol';
import { CHUNK_SIZE_TILES, BASE_SIZE, RESOLUTIONS } from '@maldoror/protocol';
import { BASE_TILES, getTileById } from './base-tiles.js';
import { SeededRandom, ValueNoise } from '../noise/noise.js';
import {
  generateProceduralTile,
  generateAllResolutions,
  generateWaterAnimationFrames,
  type TerrainType,
  type NeighborInfo,
} from './procedural-tiles.js';

/**
 * Rotate a pixel grid by 90 degrees clockwise
 */
function rotateGrid90(grid: PixelGrid): PixelGrid {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const result: PixelGrid = [];

  for (let x = 0; x < width; x++) {
    const row: Pixel[] = [];
    for (let y = height - 1; y >= 0; y--) {
      row.push(grid[y]?.[x] ?? null);
    }
    result.push(row);
  }
  return result;
}

/**
 * Rotate a pixel grid by specified amount (0, 1, 2, or 3 times 90 degrees)
 */
function rotateGrid(grid: PixelGrid, rotations: number): PixelGrid {
  let result = grid;
  for (let i = 0; i < (rotations % 4); i++) {
    result = rotateGrid90(result);
  }
  return result;
}

/**
 * Simple hash for deterministic rotation based on position
 */
function positionHash(x: number, y: number): number {
  // Mix x and y to get varied rotations
  let hash = x * 374761393 + y * 668265263;
  hash = (hash ^ (hash >> 13)) * 1274126177;
  return hash;
}

/**
 * Configuration for the tile provider
 */
export interface TileProviderConfig {
  worldSeed: bigint;
  chunkCacheSize?: number;
}

/**
 * Cached chunk data
 */
interface ChunkData {
  tiles: string[][];  // Tile IDs
  accessedAt: number;
}

/**
 * Cached procedural tile data
 */
interface ProceduralTileCache {
  tile: Tile;
  accessedAt: number;
}

/**
 * TileProvider - Provides tile and player data to the renderer
 *
 * Handles:
 * - Tile lookups by world coordinates
 * - Procedural tile generation with neighbor blending
 * - Chunk generation and caching
 * - Player sprite management
 */
export class TileProvider implements WorldDataProvider {
  private worldSeed: bigint;
  private noise: ValueNoise;
  private chunkCache: Map<string, ChunkData> = new Map();
  private tileCache: Map<string, ProceduralTileCache> = new Map();
  private maxChunks: number;
  private maxTiles: number;
  private players: Map<string, PlayerVisualState> = new Map();
  private sprites: Map<string, Sprite> = new Map();
  private localPlayerId: string = '';
  private useProceduralTiles: boolean = true;

  constructor(config: TileProviderConfig) {
    this.worldSeed = config.worldSeed;
    this.noise = new ValueNoise(config.worldSeed);
    this.maxChunks = config.chunkCacheSize ?? 64;
    this.maxTiles = 256; // Cache up to 256 procedural tiles
  }

  /**
   * Enable or disable procedural tile generation
   */
  setProceduralTiles(enabled: boolean): void {
    this.useProceduralTiles = enabled;
    if (!enabled) {
      this.tileCache.clear();
    }
  }

  /**
   * Set the local player ID (for username rendering)
   */
  setLocalPlayerId(userId: string): void {
    this.localPlayerId = userId;
  }

  /**
   * Get the local player ID
   */
  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  /**
   * Get tile ID at world coordinates (for neighbor lookups)
   */
  private getTileId(tileX: number, tileY: number): string | null {
    const chunkX = Math.floor(tileX / CHUNK_SIZE_TILES);
    const chunkY = Math.floor(tileY / CHUNK_SIZE_TILES);

    const chunk = this.getChunk(chunkX, chunkY);
    if (!chunk) return null;

    const localX = ((tileX % CHUNK_SIZE_TILES) + CHUNK_SIZE_TILES) % CHUNK_SIZE_TILES;
    const localY = ((tileY % CHUNK_SIZE_TILES) + CHUNK_SIZE_TILES) % CHUNK_SIZE_TILES;

    return chunk.tiles[localY]?.[localX] ?? null;
  }

  /**
   * Get neighbor terrain types for a tile
   */
  private getNeighborInfo(tileX: number, tileY: number): NeighborInfo {
    return {
      north: this.getTileId(tileX, tileY - 1) as TerrainType | undefined,
      south: this.getTileId(tileX, tileY + 1) as TerrainType | undefined,
      east: this.getTileId(tileX + 1, tileY) as TerrainType | undefined,
      west: this.getTileId(tileX - 1, tileY) as TerrainType | undefined,
      northEast: this.getTileId(tileX + 1, tileY - 1) as TerrainType | undefined,
      northWest: this.getTileId(tileX - 1, tileY - 1) as TerrainType | undefined,
      southEast: this.getTileId(tileX + 1, tileY + 1) as TerrainType | undefined,
      southWest: this.getTileId(tileX - 1, tileY + 1) as TerrainType | undefined,
    };
  }

  /**
   * Get tile at world coordinates
   */
  getTile(tileX: number, tileY: number): Tile | null {
    const tileId = this.getTileId(tileX, tileY);
    if (!tileId) return null;

    // Use procedural generation if enabled
    if (this.useProceduralTiles) {
      return this.getProceduralTile(tileX, tileY, tileId as TerrainType);
    }

    // Fall back to base tiles
    const baseTile = getTileById(tileId);
    if (!baseTile) return BASE_TILES.void ?? null;

    // Determine rotation based on world position
    const rotation = Math.abs(positionHash(tileX, tileY)) % 4;

    if (rotation === 0 || baseTile.animated) {
      return baseTile;
    }

    return {
      ...baseTile,
      pixels: rotateGrid(baseTile.pixels, rotation),
    };
  }

  /**
   * Get or generate a procedural tile with neighbor blending
   */
  private getProceduralTile(tileX: number, tileY: number, terrainType: TerrainType): Tile {
    const cacheKey = `${tileX},${tileY}`;

    // Check cache
    const cached = this.tileCache.get(cacheKey);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.tile;
    }

    // Get neighbor info for blending
    const neighbors = this.getNeighborInfo(tileX, tileY);

    // Use world seed + position for deterministic generation
    const tileSeed = Number(this.worldSeed & 0xffffffffn) + tileX * 374761393 + tileY * 668265263;

    // Generate the tile
    const isWater = terrainType === 'water';
    const pixels = generateProceduralTile(terrainType, tileX, tileY, tileSeed, neighbors, 0);
    const resolutions = generateAllResolutions(pixels);

    let tile: Tile;

    if (isWater) {
      // Generate animation frames for water
      const animationFrames = generateWaterAnimationFrames(tileX, tileY, tileSeed, neighbors, 4);
      const animationResolutions: Record<string, PixelGrid[]> = {};

      for (const size of RESOLUTIONS) {
        animationResolutions[String(size)] = animationFrames.map(frame =>
          downscaleGrid(frame, size)
        );
      }

      tile = {
        id: terrainType,
        name: terrainType.charAt(0).toUpperCase() + terrainType.slice(1),
        pixels,
        walkable: false,
        animated: true,
        animationFrames,
        resolutions,
        animationResolutions,
      };
    } else {
      tile = {
        id: terrainType,
        name: terrainType.charAt(0).toUpperCase() + terrainType.slice(1),
        pixels,
        walkable: terrainType !== 'void',
        resolutions,
      };
    }

    // Cache the tile
    this.tileCache.set(cacheKey, { tile, accessedAt: Date.now() });
    this.evictOldTiles();

    return tile;
  }

  /**
   * Evict old tiles from cache
   */
  private evictOldTiles(): void {
    if (this.tileCache.size <= this.maxTiles) return;

    const entries = Array.from(this.tileCache.entries())
      .sort((a, b) => a[1].accessedAt - b[1].accessedAt);

    const toRemove = entries.slice(0, entries.length - this.maxTiles);
    for (const [key] of toRemove) {
      this.tileCache.delete(key);
    }
  }

  /**
   * Update player visual state
   */
  updatePlayer(state: PlayerVisualState): void {
    this.players.set(state.userId, state);
  }

  /**
   * Remove player
   */
  removePlayer(userId: string): void {
    this.players.delete(userId);
  }

  /**
   * Get all players
   */
  getPlayers(): PlayerVisualState[] {
    return Array.from(this.players.values());
  }

  /**
   * Set player sprite
   */
  setPlayerSprite(userId: string, sprite: Sprite): void {
    this.sprites.set(userId, sprite);
  }

  /**
   * Get player sprite
   */
  getPlayerSprite(userId: string): Sprite | null {
    return this.sprites.get(userId) ?? null;
  }

  /**
   * Get or generate chunk
   */
  private getChunk(chunkX: number, chunkY: number): ChunkData | null {
    const key = `${chunkX},${chunkY}`;

    let chunk = this.chunkCache.get(key);
    if (chunk) {
      chunk.accessedAt = Date.now();
      return chunk;
    }

    // Generate new chunk
    chunk = this.generateChunk(chunkX, chunkY);
    this.chunkCache.set(key, chunk);

    // Evict old chunks if needed
    this.evictOldChunks();

    return chunk;
  }

  /**
   * Generate a chunk procedurally
   */
  private generateChunk(chunkX: number, chunkY: number): ChunkData {
    const tiles: string[][] = [];
    const seed = this.worldSeed + BigInt(chunkX * 1000000) + BigInt(chunkY);
    const rand = new SeededRandom(seed);

    for (let y = 0; y < CHUNK_SIZE_TILES; y++) {
      const row: string[] = [];
      for (let x = 0; x < CHUNK_SIZE_TILES; x++) {
        const worldX = chunkX * CHUNK_SIZE_TILES + x;
        const worldY = chunkY * CHUNK_SIZE_TILES + y;

        // Use noise to determine terrain
        const elevation = this.noise.sample(worldX * 0.05, worldY * 0.05);
        const moisture = this.noise.sample(worldX * 0.03 + 1000, worldY * 0.03 + 1000);

        row.push(this.getTileIdFromTerrain(elevation, moisture, rand));
      }
      tiles.push(row);
    }

    return {
      tiles,
      accessedAt: Date.now(),
    };
  }

  /**
   * Determine tile type from terrain values
   */
  private getTileIdFromTerrain(elevation: number, moisture: number, _rand: SeededRandom): string {
    // Water in low areas
    if (elevation < 0.3) {
      return 'water';
    }

    // Beach/sand at water edges
    if (elevation < 0.35) {
      return 'sand';
    }

    // Stone at high elevations
    if (elevation > 0.75) {
      return 'stone';
    }

    // Dirt in dry areas
    if (moisture < 0.35) {
      return 'dirt';
    }

    // Default to grass
    return 'grass';
  }

  /**
   * Evict least recently used chunks
   */
  private evictOldChunks(): void {
    if (this.chunkCache.size <= this.maxChunks) return;

    // Sort by access time and remove oldest
    const entries = Array.from(this.chunkCache.entries())
      .sort((a, b) => a[1].accessedAt - b[1].accessedAt);

    const toRemove = entries.slice(0, entries.length - this.maxChunks);
    for (const [key] of toRemove) {
      this.chunkCache.delete(key);
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.chunkCache.clear();
    this.tileCache.clear();
  }
}

/**
 * Downscale a pixel grid using nearest-neighbor sampling
 */
function downscaleGrid(grid: PixelGrid, targetSize: number): PixelGrid {
  const srcSize = grid.length;
  if (srcSize === targetSize) return grid;

  const result: PixelGrid = [];
  for (let y = 0; y < targetSize; y++) {
    const row: Pixel[] = [];
    const srcY = Math.floor(y * srcSize / targetSize);
    for (let x = 0; x < targetSize; x++) {
      const srcX = Math.floor(x * srcSize / targetSize);
      row.push(grid[srcY]?.[srcX] ?? null);
    }
    result.push(row);
  }
  return result;
}

/**
 * Create a placeholder sprite for players without generated sprites
 * 256x256 pixels base with all resolutions pre-computed
 */
export function createPlaceholderSprite(baseColor: RGB = { r: 100, g: 150, b: 255 }): Sprite {
  const SIZE = BASE_SIZE;

  const darkColor: RGB = {
    r: Math.floor(baseColor.r * 0.6),
    g: Math.floor(baseColor.g * 0.6),
    b: Math.floor(baseColor.b * 0.6),
  };
  const skinColor: RGB = { r: 255, g: 220, b: 180 };
  const hairColor: RGB = { r: 60, g: 40, b: 30 };

  const createFrame = (): PixelGrid => {
    const grid: PixelGrid = [];

    // Scale factors for 256x256 (original was 16x16, so 16x scale)
    const scale = SIZE / 16;

    for (let y = 0; y < SIZE; y++) {
      const row: (RGB | null)[] = [];
      // Map to original 16x16 coordinate space
      const origY = Math.floor(y / scale);
      for (let x = 0; x < SIZE; x++) {
        const origX = Math.floor(x / scale);
        let pixel: RGB | null = null;

        // Hair (top)
        if (origY >= 0 && origY < 2 && origX >= 5 && origX <= 10) {
          pixel = hairColor;
        }
        // Head
        else if (origY >= 1 && origY < 5 && origX >= 5 && origX <= 10) {
          pixel = skinColor;
        }
        // Body
        else if (origY >= 5 && origY < 10 && origX >= 4 && origX <= 11) {
          pixel = baseColor;
        }
        // Legs
        else if (origY >= 10 && origY < 15) {
          if ((origX >= 5 && origX < 7) || (origX >= 9 && origX < 11)) {
            pixel = darkColor;
          }
        }

        row.push(pixel);
      }
      grid.push(row);
    }

    return grid;
  };

  const frame = createFrame();
  const baseFrames: DirectionFrames = [frame, frame, frame, frame];

  // Generate all resolutions
  const resolutions: Record<string, {
    up: DirectionFrames;
    down: DirectionFrames;
    left: DirectionFrames;
    right: DirectionFrames;
  }> = {};

  for (const size of RESOLUTIONS) {
    const scaledFrame = downscaleGrid(frame, size);
    const scaledFrames: DirectionFrames = [scaledFrame, scaledFrame, scaledFrame, scaledFrame];
    resolutions[String(size)] = {
      up: scaledFrames,
      down: scaledFrames,
      left: scaledFrames,
      right: scaledFrames,
    };
  }

  return {
    width: SIZE,
    height: SIZE,
    frames: {
      up: baseFrames,
      down: baseFrames,
      left: baseFrames,
      right: baseFrames,
    },
    resolutions,
  };
}
