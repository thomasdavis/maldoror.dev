import type { Direction, AnimationFrame } from '../types/index.js';

/**
 * Base event interface
 */
export interface BaseEvent {
  type: string;
  timestamp: number;
}

/**
 * Player moved event
 */
export interface PlayerMovedEvent extends BaseEvent {
  type: 'playerMoved';
  userId: string;
  x: number;
  y: number;
  direction: Direction;
  animationFrame: AnimationFrame;
}

/**
 * World update event (chunk loaded/modified)
 */
export interface WorldUpdateEvent extends BaseEvent {
  type: 'worldUpdate';
  chunkX: number;
  chunkY: number;
  updates: Array<{
    tileX: number;
    tileY: number;
    char: string;
    color?: string;
  }>;
}

/**
 * Viewport update event (full viewport refresh)
 */
export interface ViewportUpdateEvent extends BaseEvent {
  type: 'viewportUpdate';
  // Contains full viewport data
}

/**
 * Union of game events
 */
export type GameEvent = PlayerMovedEvent | WorldUpdateEvent | ViewportUpdateEvent;
