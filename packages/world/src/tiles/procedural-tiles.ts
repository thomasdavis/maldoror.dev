import type { PixelGrid, RGB, Pixel } from '@maldoror/protocol';
import { PROC_GEN_SIZE, RESOLUTIONS } from '@maldoror/protocol';

/**
 * Fast Procedural Tile Generator - Pixel Art Style
 *
 * Generates tiles at 16x16 pixel art resolution, then upscales.
 * Uses simple hash-based patterns for speed, not expensive noise functions.
 */

// ============================================
// FAST HASH FUNCTIONS
// ============================================

/**
 * Fast integer hash
 */
function hash(x: number, y: number, seed: number = 0): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

/**
 * Hash returning integer 0-n
 */
function hashInt(x: number, y: number, seed: number, max: number): number {
  return Math.floor(hash(x, y, seed) * max);
}

// ============================================
// COLOR UTILITIES
// ============================================

function rgb(r: number, g: number, b: number): RGB {
  return {
    r: Math.max(0, Math.min(255, Math.round(r))),
    g: Math.max(0, Math.min(255, Math.round(g))),
    b: Math.max(0, Math.min(255, Math.round(b))),
  };
}

function pickColor(palette: RGB[], x: number, y: number, seed: number): RGB {
  const idx = hashInt(x, y, seed, palette.length);
  return palette[idx]!;
}

// ============================================
// TILE TYPE DEFINITIONS
// ============================================

export type TerrainType = 'grass' | 'dirt' | 'stone' | 'water' | 'sand' | 'void';

// Pixel art palettes - limited colors for retro look
const PALETTES: Record<TerrainType, RGB[]> = {
  grass: [
    rgb(34, 139, 34),   // Forest green
    rgb(46, 125, 50),   // Dark green
    rgb(56, 142, 60),   // Medium green
    rgb(76, 175, 80),   // Light green
  ],
  dirt: [
    rgb(101, 67, 33),   // Dark brown
    rgb(139, 90, 43),   // Medium brown
    rgb(160, 120, 60),  // Light brown
    rgb(120, 80, 40),   // Reddish brown
  ],
  stone: [
    rgb(96, 96, 96),    // Dark gray
    rgb(128, 128, 128), // Medium gray
    rgb(144, 144, 144), // Light gray
    rgb(112, 112, 112), // Another gray
  ],
  water: [
    rgb(30, 100, 180),  // Deep blue
    rgb(50, 130, 200),  // Medium blue
    rgb(70, 150, 220),  // Light blue
    rgb(100, 170, 230), // Highlight blue
  ],
  sand: [
    rgb(237, 201, 175), // Light sand
    rgb(245, 222, 179), // Wheat
    rgb(210, 180, 140), // Tan
    rgb(194, 178, 128), // Dark sand
  ],
  void: [
    rgb(20, 20, 30),
    rgb(15, 15, 25),
    rgb(25, 25, 35),
    rgb(10, 10, 20),
  ],
};

// ============================================
// NEIGHBOR INFORMATION
// ============================================

export interface NeighborInfo {
  north?: TerrainType;
  south?: TerrainType;
  east?: TerrainType;
  west?: TerrainType;
  northEast?: TerrainType;
  northWest?: TerrainType;
  southEast?: TerrainType;
  southWest?: TerrainType;
}

// ============================================
// SIMPLE TILE GENERATORS (16x16)
// ============================================

const SIZE = PROC_GEN_SIZE;

/**
 * Generate grass - simple hash-based variation
 */
function generateGrass(worldX: number, worldY: number, seed: number): PixelGrid {
  const palette = PALETTES.grass;
  const grid: PixelGrid = [];

  for (let y = 0; y < SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < SIZE; x++) {
      // World-based coordinates for consistent patterns
      const wx = worldX * SIZE + x;
      const wy = worldY * SIZE + y;

      // Pick from palette based on hash
      const color = pickColor(palette, wx, wy, seed);

      // Occasional darker grass blade
      if (hash(wx, wy, seed + 100) > 0.92) {
        row.push(rgb(color.r * 0.7, color.g * 0.8, color.b * 0.7));
      } else {
        row.push(color);
      }
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Generate dirt - hash-based with occasional pebbles
 */
function generateDirt(worldX: number, worldY: number, seed: number): PixelGrid {
  const palette = PALETTES.dirt;
  const grid: PixelGrid = [];

  for (let y = 0; y < SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < SIZE; x++) {
      const wx = worldX * SIZE + x;
      const wy = worldY * SIZE + y;

      const color = pickColor(palette, wx, wy, seed);

      // Occasional pebble (lighter spot)
      if (hash(wx, wy, seed + 200) > 0.95) {
        row.push(rgb(color.r * 1.2, color.g * 1.2, color.b * 1.1));
      } else {
        row.push(color);
      }
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Generate stone - hash-based with crack lines
 */
function generateStone(worldX: number, worldY: number, seed: number): PixelGrid {
  const palette = PALETTES.stone;
  const grid: PixelGrid = [];

  for (let y = 0; y < SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < SIZE; x++) {
      const wx = worldX * SIZE + x;
      const wy = worldY * SIZE + y;

      const color = pickColor(palette, wx, wy, seed);

      // Occasional crack (darker line)
      const crackChance = hash(wx, wy, seed + 300);
      if (crackChance > 0.93) {
        row.push(rgb(color.r * 0.6, color.g * 0.6, color.b * 0.6));
      } else if (crackChance > 0.88) {
        // Lighter highlight
        row.push(rgb(color.r * 1.15, color.g * 1.15, color.b * 1.15));
      } else {
        row.push(color);
      }
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Generate water - with animated wave pattern
 */
function generateWater(worldX: number, worldY: number, seed: number, tick: number = 0): PixelGrid {
  const palette = PALETTES.water;
  const grid: PixelGrid = [];

  for (let y = 0; y < SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < SIZE; x++) {
      const wx = worldX * SIZE + x;
      const wy = worldY * SIZE + y;

      // Simple wave pattern using sin
      const wave = Math.sin((wx + tick * 0.5) * 0.4) * 0.5 + 0.5;
      const wave2 = Math.sin((wy - tick * 0.3) * 0.5) * 0.5 + 0.5;
      const combined = (wave + wave2) / 2;

      // Pick base color
      const baseIdx = hashInt(wx, wy, seed, palette.length - 1);
      const color = palette[baseIdx]!;

      // Apply wave brightness variation
      const brightness = 0.85 + combined * 0.3;
      row.push(rgb(color.r * brightness, color.g * brightness, color.b * brightness));
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Generate sand - simple dithered pattern
 */
function generateSand(worldX: number, worldY: number, seed: number): PixelGrid {
  const palette = PALETTES.sand;
  const grid: PixelGrid = [];

  for (let y = 0; y < SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < SIZE; x++) {
      const wx = worldX * SIZE + x;
      const wy = worldY * SIZE + y;

      const color = pickColor(palette, wx, wy, seed);

      // Occasional shell/pebble
      if (hash(wx, wy, seed + 400) > 0.97) {
        row.push(rgb(180, 170, 160)); // Gray pebble
      } else {
        row.push(color);
      }
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Generate void
 */
function generateVoid(worldX: number, worldY: number, seed: number): PixelGrid {
  const palette = PALETTES.void;
  const grid: PixelGrid = [];

  for (let y = 0; y < SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < SIZE; x++) {
      const wx = worldX * SIZE + x;
      const wy = worldY * SIZE + y;
      row.push(pickColor(palette, wx, wy, seed));
    }
    grid.push(row);
  }

  return grid;
}

// ============================================
// MAIN GENERATOR
// ============================================

/**
 * Generate a complete terrain tile at 16x16
 */
export function generateProceduralTile(
  terrainType: TerrainType,
  worldTileX: number,
  worldTileY: number,
  seed: number,
  _neighbors: NeighborInfo, // Kept for API compat, ignored for speed
  tick: number = 0
): PixelGrid {
  switch (terrainType) {
    case 'grass':
      return generateGrass(worldTileX, worldTileY, seed);
    case 'dirt':
      return generateDirt(worldTileX, worldTileY, seed);
    case 'stone':
      return generateStone(worldTileX, worldTileY, seed);
    case 'water':
      return generateWater(worldTileX, worldTileY, seed, tick);
    case 'sand':
      return generateSand(worldTileX, worldTileY, seed);
    case 'void':
    default:
      return generateVoid(worldTileX, worldTileY, seed);
  }
}

/**
 * Upscale a pixel grid using nearest neighbor
 */
function upscaleNearest(grid: PixelGrid, targetSize: number): PixelGrid {
  const srcSize = grid.length;
  if (srcSize === targetSize) return grid;

  const scale = targetSize / srcSize;
  const result: PixelGrid = [];

  for (let y = 0; y < targetSize; y++) {
    const row: Pixel[] = [];
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < targetSize; x++) {
      const srcX = Math.floor(x / scale);
      row.push(grid[srcY]?.[srcX] ?? null);
    }
    result.push(row);
  }

  return result;
}

/**
 * Generate all resolutions by upscaling from 16x16 source
 */
export function generateAllResolutions(grid: PixelGrid): Record<string, PixelGrid> {
  const resolutions: Record<string, PixelGrid> = {};
  for (const size of RESOLUTIONS) {
    resolutions[String(size)] = upscaleNearest(grid, size);
  }
  return resolutions;
}

/**
 * Generate water animation frames
 */
export function generateWaterAnimationFrames(
  worldTileX: number,
  worldTileY: number,
  seed: number,
  _neighbors: NeighborInfo,
  frameCount: number = 4
): PixelGrid[] {
  const frames: PixelGrid[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    const tick = frame * 15;
    frames.push(generateProceduralTile('water', worldTileX, worldTileY, seed, {}, tick));
  }

  return frames;
}

// Legacy export for API compatibility
export function generateTerrainPixel(
  _terrainType: TerrainType,
  _worldTileX: number,
  _worldTileY: number,
  _localX: number,
  _localY: number,
  _seed: number,
  _neighbors: NeighborInfo,
  _tick: number = 0
): RGB {
  // This is no longer used - tiles are generated as complete grids
  return rgb(0, 0, 0);
}
