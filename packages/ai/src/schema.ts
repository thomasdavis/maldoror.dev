import { z } from 'zod';

/**
 * Schema for a single sprite cell
 */
export const SpriteCellSchema = z.object({
  char: z.string().length(1).describe('ASCII character for this cell'),
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Foreground color as hex (e.g., #FF0000)'),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Background color as hex (e.g., #000000)'),
});

/**
 * Schema for a single animation frame (7x12 grid)
 */
export const SpriteFrameSchema = z.array(
  z.array(SpriteCellSchema).length(7).describe('Row of 7 cells')
).length(12).describe('12 rows making a 7x12 sprite');

/**
 * Schema for all directional frames
 */
export const DirectionalFramesSchema = z.object({
  up: z.array(SpriteFrameSchema).length(4).describe('4 animation frames for facing up'),
  down: z.array(SpriteFrameSchema).length(4).describe('4 animation frames for facing down'),
  left: z.array(SpriteFrameSchema).length(4).describe('4 animation frames for facing left'),
  right: z.array(SpriteFrameSchema).length(4).describe('4 animation frames for facing right'),
});

/**
 * Schema for complete sprite data
 */
export const SpriteGridSchema = z.object({
  width: z.literal(7).describe('Sprite width in characters'),
  height: z.literal(12).describe('Sprite height in characters'),
  frames: DirectionalFramesSchema,
});

/**
 * Type exports
 */
export type SpriteCell = z.infer<typeof SpriteCellSchema>;
export type SpriteFrame = z.infer<typeof SpriteFrameSchema>;
export type DirectionalFrames = z.infer<typeof DirectionalFramesSchema>;
export type SpriteGrid = z.infer<typeof SpriteGridSchema>;
