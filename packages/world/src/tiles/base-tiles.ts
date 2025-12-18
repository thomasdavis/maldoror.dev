import type { Tile, PixelGrid, RGB, Pixel } from '@maldoror/protocol';
import { BASE_SIZE, RESOLUTIONS } from '@maldoror/protocol';

/**
 * Helper to create RGB color
 */
function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

// seededRandom removed during perf testing

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
 * Generate all resolution versions of a pixel grid
 */
function generateAllResolutions(baseGrid: PixelGrid): Record<string, PixelGrid> {
  const resolutions: Record<string, PixelGrid> = {};
  for (const size of RESOLUTIONS) {
    resolutions[String(size)] = downscaleGrid(baseGrid, size);
  }
  return resolutions;
}

/**
 * Generate all resolution versions for animation frames
 */
function generateAnimationResolutions(frames: PixelGrid[]): Record<string, PixelGrid[]> {
  const resolutions: Record<string, PixelGrid[]> = {};
  for (const size of RESOLUTIONS) {
    resolutions[String(size)] = frames.map(frame => downscaleGrid(frame, size));
  }
  return resolutions;
}

/**
 * Create a solid color tile at BASE_SIZE (256x256) - for perf testing
 */
function createSolidTile(color: RGB): PixelGrid {
  const grid: PixelGrid = [];
  for (let y = 0; y < BASE_SIZE; y++) {
    const row: (RGB | null)[] = Array(BASE_SIZE).fill(color);
    grid.push(row);
  }
  return grid;
}

/**
 * Create a deterministic varied tile at BASE_SIZE (256x256)
 * DISABLED FOR PERF TESTING - using solid colors instead
 */
function createSeededVariedTile(
  _seed: number,
  baseColor: RGB,
  _variations: RGB[],
  _variationChance: number = 0.3
): PixelGrid {
  return createSolidTile(baseColor);
  /* ORIGINAL COMPLEX VERSION:
  const rand = seededRandom(seed);
  const grid: PixelGrid = [];
  for (let y = 0; y < BASE_SIZE; y++) {
    const row: (RGB | null)[] = [];
    for (let x = 0; x < BASE_SIZE; x++) {
      if (rand() < variationChance && variations.length > 0) {
        row.push(variations[Math.floor(rand() * variations.length)]!);
      } else {
        row.push(baseColor);
      }
    }
    grid.push(row);
  }
  return grid;
  */
}

// ============================================
// GRASS TILES
// ============================================

const GRASS_BASE = rgb(34, 139, 34);      // Forest green
const GRASS_LIGHT = rgb(50, 160, 50);     // Lighter green
const GRASS_DARK = rgb(28, 120, 28);      // Darker green
const GRASS_ACCENT = rgb(60, 179, 60);    // Bright accent

const GRASS_PIXELS = createSeededVariedTile(12345, GRASS_BASE, [GRASS_LIGHT, GRASS_DARK, GRASS_ACCENT], 0.4);

export const GRASS_TILE: Tile = {
  id: 'grass',
  name: 'Grass',
  pixels: GRASS_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(GRASS_PIXELS),
};

// ============================================
// DIRT TILES
// ============================================

const DIRT_BASE = rgb(139, 90, 43);       // Brown
const DIRT_LIGHT = rgb(160, 110, 60);     // Lighter brown
const DIRT_DARK = rgb(110, 70, 30);       // Darker brown

const DIRT_PIXELS = createSeededVariedTile(67890, DIRT_BASE, [DIRT_LIGHT, DIRT_DARK], 0.35);

export const DIRT_TILE: Tile = {
  id: 'dirt',
  name: 'Dirt',
  pixels: DIRT_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(DIRT_PIXELS),
};

// ============================================
// STONE TILES
// ============================================

const STONE_BASE = rgb(128, 128, 128);    // Gray
const STONE_LIGHT = rgb(150, 150, 150);   // Light gray
const STONE_DARK = rgb(100, 100, 100);    // Dark gray
const STONE_ACCENT = rgb(90, 90, 95);     // Slight blue tint

const STONE_PIXELS = createSeededVariedTile(11111, STONE_BASE, [STONE_LIGHT, STONE_DARK, STONE_ACCENT], 0.5);

export const STONE_TILE: Tile = {
  id: 'stone',
  name: 'Stone',
  pixels: STONE_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(STONE_PIXELS),
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

const WATER_PIXELS = createWaterFrame(22222);
const WATER_ANIMATION_FRAMES = [
  createWaterFrame(22222),
  createWaterFrame(33333),
  createWaterFrame(44444),
  createWaterFrame(55555),
];

export const WATER_TILE: Tile = {
  id: 'water',
  name: 'Water',
  pixels: WATER_PIXELS,
  walkable: false,
  animated: true,
  animationFrames: WATER_ANIMATION_FRAMES,
  resolutions: generateAllResolutions(WATER_PIXELS),
  animationResolutions: generateAnimationResolutions(WATER_ANIMATION_FRAMES),
};

// ============================================
// SAND TILES
// ============================================

const SAND_BASE = rgb(210, 180, 140);     // Tan
const SAND_LIGHT = rgb(230, 200, 160);    // Light tan
const SAND_DARK = rgb(190, 160, 120);     // Dark tan

const SAND_PIXELS = createSeededVariedTile(99999, SAND_BASE, [SAND_LIGHT, SAND_DARK], 0.3);

export const SAND_TILE: Tile = {
  id: 'sand',
  name: 'Sand',
  pixels: SAND_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(SAND_PIXELS),
};

// ============================================
// VOID/EMPTY TILE
// ============================================

const VOID_COLOR = rgb(10, 10, 15);

const VOID_PIXELS: PixelGrid = Array(BASE_SIZE).fill(null).map(() => Array(BASE_SIZE).fill(VOID_COLOR));

export const VOID_TILE: Tile = {
  id: 'void',
  name: 'Void',
  pixels: VOID_PIXELS,
  walkable: false,
  resolutions: generateAllResolutions(VOID_PIXELS),
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
