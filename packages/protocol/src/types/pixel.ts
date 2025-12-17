/**
 * RGB color for a single pixel
 */
export interface RGB {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

/**
 * A single pixel can be a color or transparent
 */
export type Pixel = RGB | null;

/**
 * A pixel grid - 2D array of pixels [y][x]
 * Row-major for efficient line rendering
 */
export type PixelGrid = Pixel[][];

/**
 * Standard tile size in pixels
 * Tiles are square: 16x16 pixels
 * Each pixel = 2 terminal chars wide, 1 char tall
 * So a tile is 32 chars wide x 16 chars tall in terminal
 */
export const TILE_SIZE = 16;

/**
 * Sprite dimensions in pixels
 * Sprites are 16x24 (width x height) to fit nicely on tiles
 * but be taller for humanoid shapes
 */
export const PIXEL_SPRITE_WIDTH = 16;
export const PIXEL_SPRITE_HEIGHT = 24;

/**
 * Chunk size in tiles (for tilemaps)
 */
export const CHUNK_SIZE_TILES = 16;

/**
 * A complete pixel-based sprite with all directions and animation frames
 * Re-uses Direction and AnimationFrame from position.ts and player.ts
 */
export interface Sprite {
  width: number;   // pixels (should be PIXEL_SPRITE_WIDTH)
  height: number;  // pixels (should be PIXEL_SPRITE_HEIGHT)
  frames: {
    up: [PixelGrid, PixelGrid, PixelGrid, PixelGrid];
    down: [PixelGrid, PixelGrid, PixelGrid, PixelGrid];
    left: [PixelGrid, PixelGrid, PixelGrid, PixelGrid];
    right: [PixelGrid, PixelGrid, PixelGrid, PixelGrid];
  };
}

/**
 * A pixel-based tile (grass, dirt, water, etc.)
 * Named "Tile" to be the primary tile type for the pixel rendering system
 */
export interface Tile {
  id: string;
  name: string;
  pixels: PixelGrid;  // TILE_SIZE x TILE_SIZE
  walkable: boolean;
  animated?: boolean;
  animationFrames?: PixelGrid[];  // For animated tiles like water
}

/**
 * A tilemap chunk stored in database
 * Chunks are 16x16 tiles
 */
export interface TilemapChunk {
  chunkX: number;
  chunkY: number;
  tiles: string[][];  // Tile IDs, [y][x], CHUNK_SIZE_TILES x CHUNK_SIZE_TILES
}

/**
 * Player visual state for rendering and broadcast
 * Uses Direction and AnimationFrame from other modules
 */
export interface PlayerVisualState {
  userId: string;
  username: string;
  x: number;          // World position in tiles
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';  // Inline for circular dep avoidance
  animationFrame: 0 | 1 | 2 | 3;  // Inline for circular dep avoidance
  isMoving: boolean;
  spriteId?: string;  // Reference to sprite in DB
}

/**
 * World data provider interface
 * Used by renderers to get tile and player data
 */
export interface WorldDataProvider {
  getTile(tileX: number, tileY: number): Tile | null;
  getPlayers(): PlayerVisualState[];
  getPlayerSprite(userId: string): Sprite | null;
  getLocalPlayerId(): string;
}
