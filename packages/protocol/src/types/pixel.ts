import type { NPCVisualState } from './npc.js';

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
 * Base tile/sprite size in pixels (highest resolution at 100% zoom)
 */
export const BASE_SIZE = 256;
export const PROC_GEN_SIZE = 16; // Procedural generation at pixel art size, then upscales

/**
 * Render tile size at 0% zoom (baseline)
 */
export const TILE_SIZE = 26;  // ~10% of 256

/**
 * Available resolutions at 10% zoom increments
 * 0% = 26px, 10% = 51px, ... 100% = 256px
 */
export const RESOLUTIONS = [26, 51, 77, 102, 128, 154, 179, 205, 230, 256];

/**
 * Sprite dimensions - same as tiles, use RESOLUTIONS array for different zoom levels
 * AI generates 1024x1024 high-quality images, saved to disk, then pixelated to all resolutions
 */
export const PIXEL_SPRITE_WIDTH = BASE_SIZE;
export const PIXEL_SPRITE_HEIGHT = BASE_SIZE;

/**
 * Chunk size in tiles (for tilemaps)
 */
export const CHUNK_SIZE_TILES = 16;

/**
 * Sprite frames for a single direction
 */
export type DirectionFrames = [PixelGrid, PixelGrid, PixelGrid, PixelGrid];

/**
 * A complete pixel-based sprite with all directions and animation frames
 * Supports multiple resolutions for different zoom levels
 */
export interface Sprite {
  width: number;   // Base width (highest resolution)
  height: number;  // Base height (highest resolution)
  frames: {
    up: DirectionFrames;
    down: DirectionFrames;
    left: DirectionFrames;
    right: DirectionFrames;
  };
  // Pre-computed resolutions for different zoom levels (optional)
  // Keys are sizes like "256", "128", "64", "32", "16"
  resolutions?: Record<string, {
    up: DirectionFrames;
    down: DirectionFrames;
    left: DirectionFrames;
    right: DirectionFrames;
  }>;
}

/**
 * A pixel-based tile (grass, dirt, water, etc.)
 * Supports multiple resolutions for different zoom levels
 */
export interface Tile {
  id: string;
  name: string;
  pixels: PixelGrid;  // Base resolution (256x256)
  walkable: boolean;
  animated?: boolean;
  animationFrames?: PixelGrid[];  // For animated tiles at base resolution
  // Pre-computed resolutions (keys are sizes: "26", "51", etc.)
  resolutions?: Record<string, PixelGrid>;
  animationResolutions?: Record<string, PixelGrid[]>;
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
 * Building tile for overlay rendering (imported type to avoid circular dep)
 */
export interface BuildingTileData {
  pixels: PixelGrid;
  resolutions: Record<string, PixelGrid>;
}

/**
 * Building direction type for camera rotation support
 * north = 0° (camera at default), east = 90° CW, south = 180°, west = 270° CW
 */
export type BuildingDirection = 'north' | 'east' | 'south' | 'west';

/**
 * World data provider interface
 * Used by renderers to get tile, player, and NPC data
 */
export interface WorldDataProvider {
  getTile(tileX: number, tileY: number): Tile | null;
  getBuildingTileAt?(tileX: number, tileY: number, direction?: BuildingDirection): BuildingTileData | null;
  getPlayers(): PlayerVisualState[];
  getPlayerSprite(userId: string): Sprite | null;
  getLocalPlayerId(): string;
  // NPC methods (optional for backwards compatibility)
  getNPCs?(): NPCVisualState[];
  getNPCSprite?(npcId: string): Sprite | null;
  // Road methods (optional for backwards compatibility)
  hasRoadAt?(x: number, y: number): boolean;
  getRoadTileAt?(x: number, y: number): Tile | null;
  // Terrain lighting methods (optional for backwards compatibility)
  getBrightnessAt?(worldX: number, worldY: number): number;
  generateBrightnessGrid?(
    viewportX: number,
    viewportY: number,
    cellsWide: number,
    cellsHigh: number,
    tilesPerCellX?: number,
    tilesPerCellY?: number
  ): number[][];
}
