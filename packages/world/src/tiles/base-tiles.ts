import type { Tile, PixelGrid, RGB } from '@maldoror/protocol';

/**
 * Helper to create RGB color
 */
function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

/**
 * Seeded random for deterministic tile generation
 */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/**
 * Create a deterministic varied tile
 */
function createSeededVariedTile(
  seed: number,
  baseColor: RGB,
  variations: RGB[],
  variationChance: number = 0.3
): PixelGrid {
  const rand = seededRandom(seed);
  const grid: PixelGrid = [];
  for (let y = 0; y < 16; y++) {
    const row: (RGB | null)[] = [];
    for (let x = 0; x < 16; x++) {
      if (rand() < variationChance && variations.length > 0) {
        row.push(variations[Math.floor(rand() * variations.length)]!);
      } else {
        row.push(baseColor);
      }
    }
    grid.push(row);
  }
  return grid;
}

// ============================================
// GRASS TILES
// ============================================

const GRASS_BASE = rgb(34, 139, 34);      // Forest green
const GRASS_LIGHT = rgb(50, 160, 50);     // Lighter green
const GRASS_DARK = rgb(28, 120, 28);      // Darker green
const GRASS_ACCENT = rgb(60, 179, 60);    // Bright accent

export const GRASS_TILE: Tile = {
  id: 'grass',
  name: 'Grass',
  pixels: createSeededVariedTile(12345, GRASS_BASE, [GRASS_LIGHT, GRASS_DARK, GRASS_ACCENT], 0.4),
  walkable: true,
};

// ============================================
// DIRT TILES
// ============================================

const DIRT_BASE = rgb(139, 90, 43);       // Brown
const DIRT_LIGHT = rgb(160, 110, 60);     // Lighter brown
const DIRT_DARK = rgb(110, 70, 30);       // Darker brown

export const DIRT_TILE: Tile = {
  id: 'dirt',
  name: 'Dirt',
  pixels: createSeededVariedTile(67890, DIRT_BASE, [DIRT_LIGHT, DIRT_DARK], 0.35),
  walkable: true,
};

// ============================================
// STONE TILES
// ============================================

const STONE_BASE = rgb(128, 128, 128);    // Gray
const STONE_LIGHT = rgb(150, 150, 150);   // Light gray
const STONE_DARK = rgb(100, 100, 100);    // Dark gray
const STONE_ACCENT = rgb(90, 90, 95);     // Slight blue tint

export const STONE_TILE: Tile = {
  id: 'stone',
  name: 'Stone',
  pixels: createSeededVariedTile(11111, STONE_BASE, [STONE_LIGHT, STONE_DARK, STONE_ACCENT], 0.5),
  walkable: true,
};

// ============================================
// WATER TILES (animated)
// ============================================

const WATER_BASE = rgb(30, 100, 180);     // Deep blue
const WATER_LIGHT = rgb(50, 130, 210);    // Light blue
const WATER_DARK = rgb(20, 80, 150);      // Dark blue
const WATER_SHIMMER = rgb(80, 160, 230);  // Shimmer

function createWaterFrame(seed: number): PixelGrid {
  return createSeededVariedTile(seed, WATER_BASE, [WATER_LIGHT, WATER_DARK, WATER_SHIMMER], 0.5);
}

export const WATER_TILE: Tile = {
  id: 'water',
  name: 'Water',
  pixels: createWaterFrame(22222),
  walkable: false,
  animated: true,
  animationFrames: [
    createWaterFrame(22222),
    createWaterFrame(33333),
    createWaterFrame(44444),
    createWaterFrame(55555),
  ],
};

// ============================================
// SAND TILES
// ============================================

const SAND_BASE = rgb(210, 180, 140);     // Tan
const SAND_LIGHT = rgb(230, 200, 160);    // Light tan
const SAND_DARK = rgb(190, 160, 120);     // Dark tan

export const SAND_TILE: Tile = {
  id: 'sand',
  name: 'Sand',
  pixels: createSeededVariedTile(99999, SAND_BASE, [SAND_LIGHT, SAND_DARK], 0.3),
  walkable: true,
};

// ============================================
// VOID/EMPTY TILE
// ============================================

const VOID_COLOR = rgb(10, 10, 15);

export const VOID_TILE: Tile = {
  id: 'void',
  name: 'Void',
  pixels: Array(16).fill(null).map(() => Array(16).fill(VOID_COLOR)),
  walkable: false,
};

// ============================================
// ALL BASE TILES
// ============================================

export const BASE_TILES: Record<string, Tile> = {
  grass: GRASS_TILE,
  dirt: DIRT_TILE,
  stone: STONE_TILE,
  water: WATER_TILE,
  sand: SAND_TILE,
  void: VOID_TILE,
};

/**
 * Get a tile by ID
 */
export function getTileById(id: string): Tile | undefined {
  return BASE_TILES[id];
}
