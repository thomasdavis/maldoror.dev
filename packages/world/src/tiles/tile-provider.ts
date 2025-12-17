import type { Tile, Sprite, PlayerVisualState, PixelGrid, RGB, WorldDataProvider, Pixel } from '@maldoror/protocol';
import { CHUNK_SIZE_TILES } from '@maldoror/protocol';
import { BASE_TILES, getTileById } from './base-tiles.js';
import { SeededRandom, ValueNoise } from '../noise/noise.js';

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
 * TileProvider - Provides tile and player data to the renderer
 *
 * Handles:
 * - Tile lookups by world coordinates
 * - Chunk generation and caching
 * - Player sprite management
 */
export class TileProvider implements WorldDataProvider {
  private worldSeed: bigint;
  private noise: ValueNoise;
  private chunkCache: Map<string, ChunkData> = new Map();
  private maxChunks: number;
  private players: Map<string, PlayerVisualState> = new Map();
  private sprites: Map<string, Sprite> = new Map();
  private localPlayerId: string = '';

  constructor(config: TileProviderConfig) {
    this.worldSeed = config.worldSeed;
    this.noise = new ValueNoise(config.worldSeed);
    this.maxChunks = config.chunkCacheSize ?? 64;
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
   * Get tile at world coordinates
   */
  getTile(tileX: number, tileY: number): Tile | null {
    const chunkX = Math.floor(tileX / CHUNK_SIZE_TILES);
    const chunkY = Math.floor(tileY / CHUNK_SIZE_TILES);

    const chunk = this.getChunk(chunkX, chunkY);
    if (!chunk) return null;

    const localX = ((tileX % CHUNK_SIZE_TILES) + CHUNK_SIZE_TILES) % CHUNK_SIZE_TILES;
    const localY = ((tileY % CHUNK_SIZE_TILES) + CHUNK_SIZE_TILES) % CHUNK_SIZE_TILES;

    const tileId = chunk.tiles[localY]?.[localX];
    if (!tileId) return null;

    const baseTile = getTileById(tileId);
    if (!baseTile) return BASE_TILES.void ?? null;

    // Determine rotation based on world position (0, 1, 2, or 3 = 0°, 90°, 180°, 270°)
    const rotation = Math.abs(positionHash(tileX, tileY)) % 4;

    // Return rotated tile (skip rotation for animated tiles to preserve animation)
    if (rotation === 0 || baseTile.animated) {
      return baseTile;
    }

    // Create rotated version of the tile
    return {
      ...baseTile,
      pixels: rotateGrid(baseTile.pixels, rotation),
    };
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
  }
}

/**
 * Create a placeholder sprite for players without generated sprites
 * 16x24 pixels, simple humanoid shape with walking animation
 */
export function createPlaceholderSprite(baseColor: RGB = { r: 100, g: 150, b: 255 }): Sprite {
  const darkColor: RGB = {
    r: Math.floor(baseColor.r * 0.6),
    g: Math.floor(baseColor.g * 0.6),
    b: Math.floor(baseColor.b * 0.6),
  };
  const skinColor: RGB = { r: 255, g: 220, b: 180 };
  const hairColor: RGB = { r: 60, g: 40, b: 30 };

  // Walking animation offsets: [frame0, frame1, frame2, frame3]
  // Each frame alternates leg positions for walking animation
  const legOffsets: Record<number, { leftLeg: number; rightLeg: number }> = {
    0: { leftLeg: 0, rightLeg: 0 },    // Standing
    1: { leftLeg: -2, rightLeg: 2 },   // Left forward
    2: { leftLeg: 0, rightLeg: 0 },    // Standing
    3: { leftLeg: 2, rightLeg: -2 },   // Right forward
  };

  // Create a walking animation frame
  const createFrame = (direction: 'up' | 'down' | 'left' | 'right', frameNum: number): PixelGrid => {
    const grid: PixelGrid = [];
    const offset = legOffsets[frameNum] ?? { leftLeg: 0, rightLeg: 0 };

    for (let y = 0; y < 24; y++) {
      const row: (RGB | null)[] = [];
      for (let x = 0; x < 16; x++) {
        // Hair (y: 0-1, x: 5-10)
        if (y >= 0 && y <= 1 && x >= 5 && x <= 10) {
          row.push(hairColor);
        }
        // Head (y: 2-6, x: 5-10)
        else if (y >= 2 && y <= 6 && x >= 5 && x <= 10) {
          // Face features based on direction
          if (direction === 'down' && y === 4 && (x === 6 || x === 9)) {
            row.push({ r: 50, g: 50, b: 50 }); // Eyes
          } else if (direction === 'up' && y === 3 && x >= 6 && x <= 9) {
            row.push(hairColor); // Back of head
          } else if (direction === 'left' && x === 5) {
            row.push(skinColor);
          } else if (direction === 'right' && x === 10) {
            row.push(skinColor);
          } else {
            row.push(skinColor);
          }
        }
        // Body (y: 7-15, x: 4-11)
        else if (y >= 7 && y <= 15 && x >= 4 && x <= 11) {
          row.push(baseColor);
        }
        // Arms (y: 8-13, x: 2-3 and 12-13)
        else if (y >= 8 && y <= 13 && (x === 2 || x === 3 || x === 12 || x === 13)) {
          // Hide back arm based on direction
          if (direction === 'left' && x > 8) {
            row.push(null);
          } else if (direction === 'right' && x < 8) {
            row.push(null);
          } else {
            row.push(skinColor);
          }
        }
        // Legs with walking animation (y: 16-23)
        else if (y >= 16 && y <= 23) {
          // Left leg (base x: 5-7)
          const leftLegY = y - offset.leftLeg;
          const rightLegY = y - offset.rightLeg;

          // Check if this pixel is part of a leg
          const isLeftLeg = x >= 5 && x <= 7 && leftLegY >= 16 && leftLegY <= 23;
          const isRightLeg = x >= 8 && x <= 10 && rightLegY >= 16 && rightLegY <= 23;

          if (isLeftLeg || isRightLeg) {
            row.push(darkColor);
          } else {
            row.push(null);
          }
        }
        else {
          row.push(null);
        }
      }
      grid.push(row);
    }

    return grid;
  };

  return {
    width: 16,
    height: 24,
    frames: {
      up: [createFrame('up', 0), createFrame('up', 1), createFrame('up', 2), createFrame('up', 3)],
      down: [createFrame('down', 0), createFrame('down', 1), createFrame('down', 2), createFrame('down', 3)],
      left: [createFrame('left', 0), createFrame('left', 1), createFrame('left', 2), createFrame('left', 3)],
      right: [createFrame('right', 0), createFrame('right', 1), createFrame('right', 2), createFrame('right', 3)],
    },
  };
}
