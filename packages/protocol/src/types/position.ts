/**
 * World coordinates (absolute position in game world)
 */
export interface WorldCoord {
  x: number;
  y: number;
}

/**
 * Screen coordinates (position on terminal)
 */
export interface ScreenCoord {
  x: number;
  y: number;
}

/**
 * Chunk coordinates
 */
export interface ChunkCoord {
  chunkX: number;
  chunkY: number;
}

/**
 * Rectangle definition
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Cardinal directions
 */
export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Direction vectors for movement
 */
export const DIRECTION_VECTORS: Record<Direction, WorldCoord> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
