import * as fs from 'fs';
import type { Sprite, PixelGrid, DirectionFrames } from '@maldoror/protocol';
import { RESOLUTIONS } from '@maldoror/protocol';
import type { NPCRecord } from '@maldoror/protocol';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';
import {
  ensureNPCDir,
  getNPCPngPath,
  savePixelGridAsPng,
  loadPngAsPixelGrid,
  deleteNPCPngs,
} from './png-storage.js';

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

/**
 * NPC data with sprite for creation
 */
export interface NPCCreateData {
  creatorId: string;
  name: string;
  prompt: string;
  spawnX: number;
  spawnY: number;
  roamRadius?: number;
  playerAffinity?: number;
  sprite: Sprite;
}

/**
 * Create a new NPC and save its sprite to disk
 * Returns the created NPC record
 */
export async function createNPC(data: NPCCreateData): Promise<NPCRecord> {
  // Insert NPC record into database
  const [npcRecord] = await db.insert(schema.npcs).values({
    creatorId: data.creatorId,
    name: data.name,
    prompt: data.prompt,
    spawnX: data.spawnX,
    spawnY: data.spawnY,
    roamRadius: data.roamRadius ?? 15,
    playerAffinity: data.playerAffinity ?? 50,
    modelUsed: 'gpt-image-1-mini',
  }).returning();

  if (!npcRecord) {
    throw new Error('Failed to create NPC record');
  }

  // Save sprite to disk
  await saveNPCSpriteToDisk(npcRecord.id, data.sprite);

  console.log(`[NPC] Created NPC "${data.name}" at (${data.spawnX}, ${data.spawnY})`);

  return npcRecord as NPCRecord;
}

/**
 * Save an NPC sprite to disk as individual PNG files per frame/resolution
 */
export async function saveNPCSpriteToDisk(npcId: string, sprite: Sprite): Promise<void> {
  ensureNPCDir(npcId);

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

        const filePath = getNPCPngPath(npcId, direction, frameNum, resolution);
        await savePixelGridAsPng(pixels, filePath);

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

  console.log(`[NPC] Saved sprite for ${npcId}: ${totalFiles} PNGs (${(totalSize / 1024).toFixed(1)}KB total)`);
}

/**
 * Load a single NPC sprite frame at a specific resolution
 */
export async function loadNPCFrame(
  npcId: string,
  direction: string,
  frameNum: number,
  resolution: number
): Promise<PixelGrid | null> {
  const filePath = getNPCPngPath(npcId, direction, frameNum, resolution);

  try {
    return await loadPngAsPixelGrid(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.error(`[NPC] Failed to load frame ${direction}_${frameNum}@${resolution} for ${npcId}:`, error);
    return null;
  }
}

/**
 * Load a full NPC sprite from disk
 * Only loads base resolution (256) - renderer handles scaling
 */
export async function loadNPCSpriteFromDisk(npcId: string): Promise<Sprite | null> {
  // Check if files exist by trying to load one frame
  const testFrame = await loadNPCFrame(npcId, 'down', 0, 256);
  if (!testFrame) {
    return null;
  }

  const width = testFrame[0]?.length ?? 256;
  const height = testFrame.length;

  // Initialize the sprite structure
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

  // Load all base resolution frames
  for (const direction of DIRECTIONS) {
    for (let frameNum = 0; frameNum < 4; frameNum++) {
      const pixels = await loadNPCFrame(npcId, direction, frameNum, 256);
      if (pixels) {
        sprite.frames[direction][frameNum] = pixels;
      }
    }
  }

  return sprite;
}

/**
 * Load all NPCs from database
 */
export async function loadAllNPCs(): Promise<NPCRecord[]> {
  const records = await db.select().from(schema.npcs);
  console.log(`[NPC] Loaded ${records.length} NPCs from database`);
  return records as NPCRecord[];
}

/**
 * Get an NPC by ID
 */
export async function getNPC(npcId: string): Promise<NPCRecord | null> {
  const [record] = await db.select().from(schema.npcs).where(eq(schema.npcs.id, npcId));
  return (record as NPCRecord) || null;
}

/**
 * Delete an NPC and its sprite files
 */
export async function deleteNPC(npcId: string): Promise<void> {
  // Delete PNG files
  await deleteNPCPngs(npcId);

  // Delete database record
  await db.delete(schema.npcs).where(eq(schema.npcs.id, npcId));

  console.log(`[NPC] Deleted NPC ${npcId}`);
}

/**
 * Check if an NPC sprite exists on disk
 */
export async function npcSpriteExists(npcId: string): Promise<boolean> {
  const frame = await loadNPCFrame(npcId, 'down', 0, 256);
  return frame !== null;
}
