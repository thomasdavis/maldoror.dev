import type { Direction } from './position.js';
import type { PixelGrid } from './pixel.js';

/**
 * Full sprite with all directions and animation frames
 * Each direction has 4 frames for walk cycle animation
 * Uses PixelGrid (RGB pixels) instead of character cells
 */
export interface SpriteGrid {
  width: number;   // pixels (should match SPRITE_WIDTH = 16)
  height: number;  // pixels (should match SPRITE_HEIGHT = 24)
  frames: {
    [K in Direction]: [PixelGrid, PixelGrid, PixelGrid, PixelGrid];  // 4 frames per direction
  };
}

/**
 * Avatar generation status
 */
export type AvatarGenerationStatus = 'pending' | 'generating' | 'completed' | 'failed';

/**
 * Avatar data
 */
export interface Avatar {
  id: string;
  userId: string;
  prompt: string;
  spriteJson?: SpriteGrid;
  generationStatus: AvatarGenerationStatus;
  generationError?: string;
  modelUsed?: string;
}

/**
 * Avatar vibe presets for generation
 */
export type AvatarVibePreset = 'bleak' | 'surreal' | 'aristocratic' | 'feral';

/**
 * Avatar generation request
 */
export interface AvatarGenerationRequest {
  userId: string;
  prompt: string;
  vibePreset?: AvatarVibePreset;
}
