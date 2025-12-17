/**
 * Size of a chunk in tiles (32x32)
 */
export const CHUNK_SIZE = 32;

/**
 * Hash grid cell size for spatial queries
 */
export const HASH_CELL_SIZE = 64;

/**
 * Terrain characters by type
 */
export const TERRAIN_CHARS = {
  grass: ['.', ',', "'", '`'],
  dirt: [':', ';', '"'],
  stone: ['#', '%'],
  water: ['~', '≈'],
} as const;

/**
 * Terrain colors (hex)
 */
export const TERRAIN_COLORS = {
  grass: ['#228B22', '#32CD32', '#2E8B57', '#3CB371'],
  dirt: ['#8B4513', '#A0522D', '#6B4423'],
  stone: ['#696969', '#808080', '#778899'],
  water: ['#1E90FF', '#4169E1', '#0000CD'],
} as const;
