import type { Direction } from './position.js';
import type { SpriteGrid } from './sprite.js';

/**
 * Animation frame index (0-3)
 */
export type AnimationFrame = 0 | 1 | 2 | 3;

/**
 * Player state as seen by others
 */
export interface PlayerPresence {
  userId: string;
  username: string;
  x: number;
  y: number;
  direction: Direction;
  animationFrame: AnimationFrame;
  spriteJson?: SpriteGrid;
}

/**
 * Full player state (authoritative)
 */
export interface PlayerState extends PlayerPresence {
  isOnline: boolean;
  lastSeenAt: Date;
  lastInputAt: Date;
  sessionId?: string;
}

/**
 * Viewport definition for a player
 */
export interface PlayerViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Player input types
 */
export type PlayerInputType = 'move' | 'chat' | 'action' | 'viewport';

/**
 * Base player input
 */
export interface BasePlayerInput {
  userId: string;
  sessionId: string;
  type: PlayerInputType;
  timestamp: number;
  sequence: number;
}

/**
 * Movement input
 */
export interface MoveInput extends BasePlayerInput {
  type: 'move';
  payload: {
    dx: number;
    dy: number;
  };
}

/**
 * Chat input
 */
export interface ChatInput extends BasePlayerInput {
  type: 'chat';
  payload: {
    message: string;
  };
}

/**
 * Viewport update input
 */
export interface ViewportInput extends BasePlayerInput {
  type: 'viewport';
  payload: PlayerViewport;
}

/**
 * Generic action input
 */
export interface ActionInput extends BasePlayerInput {
  type: 'action';
  payload: {
    action: string;
    data?: unknown;
  };
}

/**
 * Union of all player inputs
 */
export type PlayerInput = MoveInput | ChatInput | ViewportInput | ActionInput;
