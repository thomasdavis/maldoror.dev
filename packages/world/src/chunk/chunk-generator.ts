import { ValueNoise } from '../noise/noise.js';
import { CHUNK_SIZE, TERRAIN_CHARS, TERRAIN_COLORS } from './constants.js';
import type { AsciiTile, TerrainType } from '@maldoror/protocol';

/**
 * Generated chunk with ASCII tiles (legacy)
 */
export interface GeneratedChunk {
  x: number;
  y: number;
  tiles: AsciiTile[][];
  generatedAt: number;
}

/**
 * Generate chunk seed from world seed and chunk coordinates
 */
export function getChunkSeed(worldSeed: bigint, chunkX: number, chunkY: number): bigint {
  const PRIME_X = 73856093n;
  const PRIME_Y = 19349669n;
  return worldSeed ^ (BigInt(chunkX) * PRIME_X) ^ (BigInt(chunkY) * PRIME_Y);
}

/**
 * Deterministic chunk generator
 */
export class ChunkGenerator {
  private worldSeed: bigint;
  private terrainNoise: ValueNoise;
  private detailNoise: ValueNoise;
  private moistureNoise: ValueNoise;

  constructor(worldSeed: bigint) {
    this.worldSeed = worldSeed;
    this.terrainNoise = new ValueNoise(worldSeed);
    this.detailNoise = new ValueNoise(worldSeed ^ 0xdeadbeefn);
    this.moistureNoise = new ValueNoise(worldSeed ^ 0xcafebaben);
  }

  /**
   * Generate a single chunk at the given chunk coordinates
   */
  generateChunk(chunkX: number, chunkY: number): GeneratedChunk {
    const tiles: AsciiTile[][] = [];

    // World coordinates of chunk origin
    const worldOriginX = chunkX * CHUNK_SIZE;
    const worldOriginY = chunkY * CHUNK_SIZE;

    for (let localY = 0; localY < CHUNK_SIZE; localY++) {
      const row: AsciiTile[] = [];

      for (let localX = 0; localX < CHUNK_SIZE; localX++) {
        const worldX = worldOriginX + localX;
        const worldY = worldOriginY + localY;

        const tile = this.generateTile(worldX, worldY);
        row.push(tile);
      }

      tiles.push(row);
    }

    return {
      x: chunkX,
      y: chunkY,
      tiles,
      generatedAt: Date.now(),
    };
  }

  /**
   * Generate a single tile based on noise values
   */
  private generateTile(worldX: number, worldY: number): AsciiTile {
    // Scale coordinates for noise sampling
    const nx = worldX * 0.02;
    const ny = worldY * 0.02;

    // Sample terrain noise at different frequencies
    const elevation = this.terrainNoise.fbm(nx, ny, 4, 2, 0.5);
    const moisture = this.moistureNoise.fbm(nx * 0.8, ny * 0.8, 3, 2, 0.5);
    const detail = this.detailNoise.sample(worldX, worldY, 0.1);

    // Determine terrain type based on elevation and moisture
    let terrainType: TerrainType;

    if (elevation < 0.3) {
      terrainType = moisture > 0.5 ? 'water' : 'dirt';
    } else if (elevation < 0.7) {
      terrainType = moisture > 0.4 ? 'grass' : 'dirt';
    } else {
      terrainType = 'stone';
    }

    // Select character and color
    const chars = TERRAIN_CHARS[terrainType];
    const colors = TERRAIN_COLORS[terrainType];

    const charIndex = Math.floor(detail * chars.length) % chars.length;
    const colorIndex = Math.floor((detail * 7) % colors.length);

    return {
      char: chars[charIndex]!,
      fg: colors[colorIndex],
      walkable: terrainType !== 'water',
      terrain: terrainType,
    };
  }

  /**
   * Get tile at world coordinates
   */
  getTileAt(worldX: number, worldY: number): AsciiTile {
    return this.generateTile(worldX, worldY);
  }

  /**
   * Get the world seed
   */
  getSeed(): bigint {
    return this.worldSeed;
  }
}
