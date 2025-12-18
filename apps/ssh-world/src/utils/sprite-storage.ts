import * as fs from 'fs';
import type { Sprite, PixelGrid, DirectionFrames } from '@maldoror/protocol';
import { RESOLUTIONS } from '@maldoror/protocol';
import { db, schema } from '@maldoror/db';
import { eq, and } from 'drizzle-orm';
import {
  ensureSpriteDir,
  getSpritePngPath,
  savePixelGridAsPng,
  loadPngAsPixelGrid,
  deleteSpritePngs,
} from './png-storage.js';

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
type Direction = typeof DIRECTIONS[number];

/**
 * Save a sprite to disk as individual PNG files per frame/resolution
 * Also inserts rows into the sprite_frames table
 */
export async function saveSpriteToDisk(userId: string, sprite: Sprite): Promise<void> {
  ensureSpriteDir(userId);

  let totalFiles = 0;
  let totalSize = 0;

  // For each direction and frame
  for (const direction of DIRECTIONS) {
    for (let frameNum = 0; frameNum < 4; frameNum++) {
      // Save each resolution as a separate PNG
      for (const resolution of RESOLUTIONS) {
        // Get pixels from the appropriate resolution
        let pixels: PixelGrid | undefined;
        const resKey = String(resolution);

        if (sprite.resolutions?.[resKey]) {
          const dirFrames = sprite.resolutions[resKey][direction];
          pixels = dirFrames?.[frameNum];
        } else if (resolution === 256) {
          // Fall back to base frames for resolution 256
          pixels = sprite.frames[direction]?.[frameNum];
        }

        if (!pixels) continue;

        const filePath = getSpritePngPath(userId, direction, frameNum, resolution);
        const relativePath = `${userId}/frame_${direction}_${frameNum}_${resolution}.png`;

        await savePixelGridAsPng(pixels, filePath);

        // Get dimensions from the pixels
        const height = pixels.length;
        const width = pixels[0]?.length ?? 0;

        // Insert database row
        await db.insert(schema.spriteFrames).values({
          userId,
          direction,
          frameNum,
          resolution,
          filePath: relativePath,
          width,
          height,
        }).onConflictDoUpdate({
          target: [schema.spriteFrames.userId, schema.spriteFrames.direction, schema.spriteFrames.frameNum, schema.spriteFrames.resolution],
          set: { filePath: relativePath, width, height },
        });

        totalFiles++;
        try {
          const stat = await fs.promises.stat(filePath);
          totalSize += stat.size;
        } catch {
          // Ignore stat errors
        }
      }
    }
  }

  console.log(`[Sprite] Saved sprite for ${userId}: ${totalFiles} PNGs (${(totalSize / 1024).toFixed(1)}KB total)`);
}

/**
 * Load a single sprite frame at a specific resolution
 * Returns null if not found
 */
export async function loadSpriteFrame(
  userId: string,
  direction: string,
  frameNum: number,
  resolution: number
): Promise<PixelGrid | null> {
  const filePath = getSpritePngPath(userId, direction, frameNum, resolution);

  try {
    return await loadPngAsPixelGrid(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.error(`[Sprite] Failed to load frame ${direction}_${frameNum}@${resolution} for ${userId}:`, error);
    return null;
  }
}

/**
 * Load all frames for a direction at a specific resolution
 */
export async function loadDirectionFrames(
  userId: string,
  direction: string,
  resolution: number
): Promise<DirectionFrames | null> {
  const frames: PixelGrid[] = [];

  for (let frameNum = 0; frameNum < 4; frameNum++) {
    const frame = await loadSpriteFrame(userId, direction, frameNum, resolution);
    if (!frame) return null;
    frames.push(frame);
  }

  return frames as DirectionFrames;
}

/**
 * Load a full sprite from disk
 * OPTIMIZED: Only loads base resolution (256) to avoid memory explosion
 * The renderer's scaling cache handles other resolutions on-demand
 */
export async function loadSpriteFromDisk(userId: string): Promise<Sprite | null> {
  // Only check for base resolution frames (256)
  const frameRecords = await db.select()
    .from(schema.spriteFrames)
    .where(and(
      eq(schema.spriteFrames.userId, userId),
      eq(schema.spriteFrames.resolution, 256)
    ));

  if (frameRecords.length === 0) {
    return null;
  }

  // Get dimensions from any frame record
  const firstRecord = frameRecords[0];
  const width = firstRecord?.width ?? 256;
  const height = firstRecord?.height ?? 256;

  // Initialize the sprite structure - only base frames, no pre-loaded resolutions
  const sprite: Sprite = {
    width,
    height,
    frames: {
      up: [[], [], [], []] as unknown as DirectionFrames,
      down: [[], [], [], []] as unknown as DirectionFrames,
      left: [[], [], [], []] as unknown as DirectionFrames,
      right: [[], [], [], []] as unknown as DirectionFrames,
    },
    resolutions: {},
  };

  // Load only base resolution frames (16 files instead of 160)
  for (const record of frameRecords) {
    const pixels = await loadSpriteFrame(userId, record.direction, record.frameNum, 256);
    if (pixels) {
      const dir = record.direction as Direction;
      sprite.frames[dir][record.frameNum] = pixels;
    }
  }

  return sprite;
}

/**
 * Load only specific resolution for a sprite (for rendering)
 * More efficient than loading the full sprite
 */
export async function loadSpriteAtResolution(
  userId: string,
  resolution: number
): Promise<Record<Direction, DirectionFrames> | null> {
  const frameRecords = await db.select()
    .from(schema.spriteFrames)
    .where(and(
      eq(schema.spriteFrames.userId, userId),
      eq(schema.spriteFrames.resolution, resolution)
    ));

  if (frameRecords.length === 0) {
    return null;
  }

  const result: Record<Direction, DirectionFrames> = {
    up: [[], [], [], []] as unknown as DirectionFrames,
    down: [[], [], [], []] as unknown as DirectionFrames,
    left: [[], [], [], []] as unknown as DirectionFrames,
    right: [[], [], [], []] as unknown as DirectionFrames,
  };

  for (const record of frameRecords) {
    const pixels = await loadSpriteFrame(userId, record.direction, record.frameNum, resolution);
    if (pixels) {
      const dir = record.direction as Direction;
      result[dir][record.frameNum] = pixels;
    }
  }

  return result;
}

/**
 * Check if a sprite has PNG files on disk
 */
export async function spriteExistsOnDisk(userId: string): Promise<boolean> {
  const count = await db.select()
    .from(schema.spriteFrames)
    .where(eq(schema.spriteFrames.userId, userId))
    .limit(1);

  return count.length > 0;
}

/**
 * Delete a sprite's PNG files and database records
 */
export async function deleteSpriteFromDisk(userId: string): Promise<void> {
  // Delete PNG files
  await deleteSpritePngs(userId);

  // Delete database records (should cascade from users table, but just in case)
  await db.delete(schema.spriteFrames)
    .where(eq(schema.spriteFrames.userId, userId));

  console.log(`[Sprite] Deleted sprite for ${userId}`);
}
