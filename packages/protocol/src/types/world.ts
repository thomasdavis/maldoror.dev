/**
 * Terrain types
 */
export type TerrainType = 'grass' | 'dirt' | 'stone' | 'water';

/**
 * Single ASCII tile in the world (legacy)
 * For pixel-based tiles, use Tile from pixel.ts
 */
export interface AsciiTile {
  char: string;
  fg?: string;  // Foreground color (hex)
  bg?: string;  // Background color (hex)
  walkable: boolean;
  terrain: TerrainType;
}

/**
 * Chunk of ASCII tiles (32x32) - legacy
 * For pixel-based chunks, use TilemapChunk from pixel.ts
 */
export interface AsciiChunk {
  x: number;       // Chunk X coordinate
  y: number;       // Chunk Y coordinate
  tiles: AsciiTile[][]; // [y][x] - row-major for efficient line rendering
  generatedAt: number;
}

/**
 * World configuration (singleton)
 */
export interface WorldConfig {
  seed: bigint;
  name: string;
  tickRateHz: number;
  chunkSize: number;
}

/**
 * Chunk delta (modification to generated chunk)
 */
export interface ChunkDelta {
  chunkX: number;
  chunkY: number;
  tileX: number;
  tileY: number;
  tileChar: string;
  tileColor?: string;
  placedBy?: string;
}

/**
 * Entity in the world (NPCs, items, etc.)
 */
export interface Entity {
  id: string;
  type: string;
  x: number;
  y: number;
  displayChar: string;
  color?: string;
  metadata?: Record<string, unknown>;
}
