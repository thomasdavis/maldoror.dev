import type { Tile, PixelGrid, RGB, Pixel } from '@maldoror/protocol';
import { BASE_SIZE, RESOLUTIONS } from '@maldoror/protocol';

/**
 * Helper to create RGB color
 */
function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
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
 * Generate all resolution versions of a pixel grid
 */
function generateAllResolutions(baseGrid: PixelGrid): Record<string, PixelGrid> {
  const resolutions: Record<string, PixelGrid> = {};
  for (const size of RESOLUTIONS) {
    resolutions[String(size)] = downscaleGrid(baseGrid, size);
  }
  return resolutions;
}

// ============================================
// COBBLESTONE ROAD COLORS
// ============================================

const STONE_BASE = rgb(120, 115, 105);      // Warm gray stone
const STONE_LIGHT = rgb(140, 135, 125);     // Lighter stone highlights
const STONE_DARK = rgb(80, 75, 70);         // Dark grout lines
const STONE_MID = rgb(100, 95, 88);         // Mid-tone stone
const CURB_COLOR = rgb(60, 58, 55);         // Dark curb/edge

/**
 * Seeded random for deterministic cobblestone patterns
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * Neighbor connection flags
 */
interface RoadNeighbors {
  north: boolean;
  south: boolean;
  east: boolean;
  west: boolean;
}

/**
 * Create a cobblestone road tile with specific edge connections
 * Edges without connections get a curb/border
 */
function createCobblestoneRoad(
  seed: number,
  neighbors: RoadNeighbors
): PixelGrid {
  const grid: PixelGrid = [];

  // Curb width in pixels (at BASE_SIZE)
  const curbWidth = Math.floor(BASE_SIZE * 0.08); // 8% of tile = curb

  for (let y = 0; y < BASE_SIZE; y++) {
    const row: (RGB | null)[] = [];
    for (let x = 0; x < BASE_SIZE; x++) {
      // Check if we're in a curb zone
      const inNorthCurb = !neighbors.north && y < curbWidth;
      const inSouthCurb = !neighbors.south && y >= BASE_SIZE - curbWidth;
      const inWestCurb = !neighbors.west && x < curbWidth;
      const inEastCurb = !neighbors.east && x >= BASE_SIZE - curbWidth;

      if (inNorthCurb || inSouthCurb || inWestCurb || inEastCurb) {
        // Curb edge
        row.push(CURB_COLOR);
      } else {
        // Cobblestone pattern
        // Create irregular stone shapes using noise-like patterns
        const stoneSize = 20; // Size of each cobblestone
        const stoneX = Math.floor(x / stoneSize);
        const stoneY = Math.floor(y / stoneSize);
        const localY = y % stoneSize;

        // Offset alternating rows for a more natural look
        const offsetX = (stoneY % 2 === 0) ? 0 : stoneSize / 2;
        const adjustedX = (x + offsetX) % stoneSize;

        // Grout lines between stones
        const isGrout = adjustedX < 2 || localY < 2;

        if (isGrout) {
          row.push(STONE_DARK);
        } else {
          // Stone surface with variation
          const stoneSeed = stoneX * 1000 + stoneY + seed;
          const stoneRand = seededRandom(stoneSeed);
          const variation = stoneRand();

          if (variation < 0.3) {
            row.push(STONE_LIGHT);
          } else if (variation < 0.5) {
            row.push(STONE_MID);
          } else {
            row.push(STONE_BASE);
          }
        }
      }
    }
    grid.push(row);
  }

  return grid;
}

// ============================================
// ROAD TILE VARIANTS
// ============================================

// Isolated road (no connections)
const ROAD_SINGLE_PIXELS = createCobblestoneRoad(1000, {
  north: false, south: false, east: false, west: false
});
export const ROAD_SINGLE: Tile = {
  id: 'road-single',
  name: 'Road (Single)',
  pixels: ROAD_SINGLE_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_SINGLE_PIXELS),
};

// Straight roads
const ROAD_STRAIGHT_NS_PIXELS = createCobblestoneRoad(2000, {
  north: true, south: true, east: false, west: false
});
export const ROAD_STRAIGHT_NS: Tile = {
  id: 'road-straight-ns',
  name: 'Road (North-South)',
  pixels: ROAD_STRAIGHT_NS_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_STRAIGHT_NS_PIXELS),
};

const ROAD_STRAIGHT_EW_PIXELS = createCobblestoneRoad(2001, {
  north: false, south: false, east: true, west: true
});
export const ROAD_STRAIGHT_EW: Tile = {
  id: 'road-straight-ew',
  name: 'Road (East-West)',
  pixels: ROAD_STRAIGHT_EW_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_STRAIGHT_EW_PIXELS),
};

// Dead ends (single connection)
const ROAD_END_N_PIXELS = createCobblestoneRoad(2100, {
  north: true, south: false, east: false, west: false
});
export const ROAD_END_N: Tile = {
  id: 'road-end-n',
  name: 'Road End (North)',
  pixels: ROAD_END_N_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_END_N_PIXELS),
};

const ROAD_END_S_PIXELS = createCobblestoneRoad(2101, {
  north: false, south: true, east: false, west: false
});
export const ROAD_END_S: Tile = {
  id: 'road-end-s',
  name: 'Road End (South)',
  pixels: ROAD_END_S_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_END_S_PIXELS),
};

const ROAD_END_E_PIXELS = createCobblestoneRoad(2102, {
  north: false, south: false, east: true, west: false
});
export const ROAD_END_E: Tile = {
  id: 'road-end-e',
  name: 'Road End (East)',
  pixels: ROAD_END_E_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_END_E_PIXELS),
};

const ROAD_END_W_PIXELS = createCobblestoneRoad(2103, {
  north: false, south: false, east: false, west: true
});
export const ROAD_END_W: Tile = {
  id: 'road-end-w',
  name: 'Road End (West)',
  pixels: ROAD_END_W_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_END_W_PIXELS),
};

// Corners (2 connections, perpendicular)
const ROAD_CORNER_NE_PIXELS = createCobblestoneRoad(3000, {
  north: true, south: false, east: true, west: false
});
export const ROAD_CORNER_NE: Tile = {
  id: 'road-corner-ne',
  name: 'Road Corner (NE)',
  pixels: ROAD_CORNER_NE_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_CORNER_NE_PIXELS),
};

const ROAD_CORNER_SE_PIXELS = createCobblestoneRoad(3001, {
  north: false, south: true, east: true, west: false
});
export const ROAD_CORNER_SE: Tile = {
  id: 'road-corner-se',
  name: 'Road Corner (SE)',
  pixels: ROAD_CORNER_SE_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_CORNER_SE_PIXELS),
};

const ROAD_CORNER_SW_PIXELS = createCobblestoneRoad(3002, {
  north: false, south: true, east: false, west: true
});
export const ROAD_CORNER_SW: Tile = {
  id: 'road-corner-sw',
  name: 'Road Corner (SW)',
  pixels: ROAD_CORNER_SW_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_CORNER_SW_PIXELS),
};

const ROAD_CORNER_NW_PIXELS = createCobblestoneRoad(3003, {
  north: true, south: false, east: false, west: true
});
export const ROAD_CORNER_NW: Tile = {
  id: 'road-corner-nw',
  name: 'Road Corner (NW)',
  pixels: ROAD_CORNER_NW_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_CORNER_NW_PIXELS),
};

// T-intersections (3 connections)
const ROAD_T_NES_PIXELS = createCobblestoneRoad(4000, {
  north: true, south: true, east: true, west: false
});
export const ROAD_T_NES: Tile = {
  id: 'road-t-nes',
  name: 'Road T (N-E-S)',
  pixels: ROAD_T_NES_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_T_NES_PIXELS),
};

const ROAD_T_ESW_PIXELS = createCobblestoneRoad(4001, {
  north: false, south: true, east: true, west: true
});
export const ROAD_T_ESW: Tile = {
  id: 'road-t-esw',
  name: 'Road T (E-S-W)',
  pixels: ROAD_T_ESW_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_T_ESW_PIXELS),
};

const ROAD_T_SWN_PIXELS = createCobblestoneRoad(4002, {
  north: true, south: true, east: false, west: true
});
export const ROAD_T_SWN: Tile = {
  id: 'road-t-swn',
  name: 'Road T (S-W-N)',
  pixels: ROAD_T_SWN_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_T_SWN_PIXELS),
};

const ROAD_T_WNE_PIXELS = createCobblestoneRoad(4003, {
  north: true, south: false, east: true, west: true
});
export const ROAD_T_WNE: Tile = {
  id: 'road-t-wne',
  name: 'Road T (W-N-E)',
  pixels: ROAD_T_WNE_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_T_WNE_PIXELS),
};

// 4-way intersection (all connections)
const ROAD_CROSS_PIXELS = createCobblestoneRoad(5000, {
  north: true, south: true, east: true, west: true
});
export const ROAD_CROSS: Tile = {
  id: 'road-cross',
  name: 'Road Cross',
  pixels: ROAD_CROSS_PIXELS,
  walkable: true,
  resolutions: generateAllResolutions(ROAD_CROSS_PIXELS),
};

// ============================================
// ROAD TILE LOOKUP
// ============================================

/**
 * All road tiles by ID for easy lookup
 */
export const ROAD_TILES: Record<string, Tile> = {
  'road-single': ROAD_SINGLE,
  'road-straight-ns': ROAD_STRAIGHT_NS,
  'road-straight-ew': ROAD_STRAIGHT_EW,
  'road-end-n': ROAD_END_N,
  'road-end-s': ROAD_END_S,
  'road-end-e': ROAD_END_E,
  'road-end-w': ROAD_END_W,
  'road-corner-ne': ROAD_CORNER_NE,
  'road-corner-se': ROAD_CORNER_SE,
  'road-corner-sw': ROAD_CORNER_SW,
  'road-corner-nw': ROAD_CORNER_NW,
  'road-t-nes': ROAD_T_NES,
  'road-t-esw': ROAD_T_ESW,
  'road-t-swn': ROAD_T_SWN,
  'road-t-wne': ROAD_T_WNE,
  'road-cross': ROAD_CROSS,
};

/**
 * Get the appropriate road tile variant based on neighbor connections
 * @param hasNorth - Is there a road tile to the north?
 * @param hasSouth - Is there a road tile to the south?
 * @param hasEast - Is there a road tile to the east?
 * @param hasWest - Is there a road tile to the west?
 * @returns The appropriate road tile variant
 */
export function getRoadTileVariant(
  hasNorth: boolean,
  hasSouth: boolean,
  hasEast: boolean,
  hasWest: boolean
): Tile {
  const count = [hasNorth, hasSouth, hasEast, hasWest].filter(Boolean).length;

  // 4-way intersection
  if (count === 4) {
    return ROAD_CROSS;
  }

  // T-intersections (3 connections)
  if (count === 3) {
    if (!hasNorth) return ROAD_T_ESW;
    if (!hasSouth) return ROAD_T_WNE;
    if (!hasEast) return ROAD_T_SWN;
    if (!hasWest) return ROAD_T_NES;
  }

  // 2 connections
  if (count === 2) {
    // Straights
    if (hasNorth && hasSouth) return ROAD_STRAIGHT_NS;
    if (hasEast && hasWest) return ROAD_STRAIGHT_EW;
    // Corners
    if (hasNorth && hasEast) return ROAD_CORNER_NE;
    if (hasSouth && hasEast) return ROAD_CORNER_SE;
    if (hasSouth && hasWest) return ROAD_CORNER_SW;
    if (hasNorth && hasWest) return ROAD_CORNER_NW;
  }

  // Dead ends (1 connection)
  if (count === 1) {
    if (hasNorth) return ROAD_END_N;
    if (hasSouth) return ROAD_END_S;
    if (hasEast) return ROAD_END_E;
    if (hasWest) return ROAD_END_W;
  }

  // No connections - isolated tile
  return ROAD_SINGLE;
}
