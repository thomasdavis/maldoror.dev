import * as fs from 'fs';
import type { BuildingSprite, PixelGrid } from '@maldoror/protocol';
import { RESOLUTIONS } from '@maldoror/protocol';
import { db, schema } from '@maldoror/db';
import { eq, and } from 'drizzle-orm';
import {
  ensureBuildingDir,
  getBuildingPngPath,
  savePixelGridAsPng,
  loadPngAsPixelGrid,
  deleteBuildingPngs,
} from './png-storage.js';

/**
 * Save a building sprite to disk as individual PNG files per tile/resolution
 * Also inserts rows into the building_tiles table
 */
export async function saveBuildingToDisk(buildingId: string, sprite: BuildingSprite): Promise<void> {
  ensureBuildingDir(buildingId);

  let totalFiles = 0;
  let totalSize = 0;

  // For each tile position in the 3x3 grid
  for (let tileY = 0; tileY < 3; tileY++) {
    for (let tileX = 0; tileX < 3; tileX++) {
      const tile = sprite.tiles[tileY]?.[tileX];
      if (!tile) continue;

      // Save each resolution as a separate PNG
      for (const resolution of RESOLUTIONS) {
        const pixels = tile.resolutions[String(resolution)];
        if (!pixels) continue;

        const filePath = getBuildingPngPath(buildingId, tileX, tileY, resolution);
        const relativePath = `${buildingId}/tile_${tileX}_${tileY}_${resolution}.png`;

        await savePixelGridAsPng(pixels, filePath);

        // Insert database row
        await db.insert(schema.buildingTiles).values({
          buildingId,
          tileX,
          tileY,
          resolution,
          filePath: relativePath,
        }).onConflictDoUpdate({
          target: [schema.buildingTiles.buildingId, schema.buildingTiles.tileX, schema.buildingTiles.tileY, schema.buildingTiles.resolution],
          set: { filePath: relativePath },
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

  console.log(`[Building] Saved building ${buildingId}: ${totalFiles} PNGs (${(totalSize / 1024).toFixed(1)}KB total)`);
}

/**
 * Load a single building tile at a specific resolution
 * Returns null if not found
 */
export async function loadBuildingTile(
  buildingId: string,
  tileX: number,
  tileY: number,
  resolution: number
): Promise<PixelGrid | null> {
  const filePath = getBuildingPngPath(buildingId, tileX, tileY, resolution);

  try {
    return await loadPngAsPixelGrid(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.error(`[Building] Failed to load tile ${tileX},${tileY}@${resolution} for ${buildingId}:`, error);
    return null;
  }
}

/**
 * Load a full building sprite from disk
 * This reconstructs the BuildingSprite from individual PNGs
 * Use sparingly - prefer loadBuildingTile for specific resolutions
 */
export async function loadBuildingFromDisk(buildingId: string): Promise<BuildingSprite | null> {
  // Check if any tiles exist for this building
  const tileRecords = await db.select()
    .from(schema.buildingTiles)
    .where(eq(schema.buildingTiles.buildingId, buildingId));

  if (tileRecords.length === 0) {
    return null;
  }

  // Initialize the sprite structure
  const sprite: BuildingSprite = {
    width: 3,
    height: 3,
    tiles: [],
  };

  // Initialize 3x3 tile grid
  for (let y = 0; y < 3; y++) {
    const row = [];
    for (let x = 0; x < 3; x++) {
      row.push({
        pixels: [] as PixelGrid,
        resolutions: {} as Record<string, PixelGrid>,
      });
    }
    sprite.tiles.push(row);
  }

  // Load each PNG file
  for (const record of tileRecords) {
    const pixels = await loadBuildingTile(buildingId, record.tileX, record.tileY, record.resolution);
    if (pixels) {
      const tile = sprite.tiles[record.tileY]?.[record.tileX];
      if (tile) {
        tile.resolutions[String(record.resolution)] = pixels;
        // Use base resolution (256) as the default pixels
        if (record.resolution === 256) {
          tile.pixels = pixels;
        }
      }
    }
  }

  return sprite;
}

/**
 * Load only specific resolutions for a building (for preview or rendering)
 * More efficient than loading the full sprite
 */
export async function loadBuildingAtResolution(
  buildingId: string,
  resolution: number
): Promise<Map<string, PixelGrid> | null> {
  const tileRecords = await db.select()
    .from(schema.buildingTiles)
    .where(and(
      eq(schema.buildingTiles.buildingId, buildingId),
      eq(schema.buildingTiles.resolution, resolution)
    ));

  if (tileRecords.length === 0) {
    return null;
  }

  const tiles = new Map<string, PixelGrid>();

  for (const record of tileRecords) {
    const pixels = await loadBuildingTile(buildingId, record.tileX, record.tileY, resolution);
    if (pixels) {
      tiles.set(`${record.tileX},${record.tileY}`, pixels);
    }
  }

  return tiles;
}

/**
 * Check if a building has PNG files on disk
 */
export async function buildingExistsOnDisk(buildingId: string): Promise<boolean> {
  const count = await db.select()
    .from(schema.buildingTiles)
    .where(eq(schema.buildingTiles.buildingId, buildingId))
    .limit(1);

  return count.length > 0;
}

/**
 * Delete a building's PNG files and database records
 */
export async function deleteBuildingFromDisk(buildingId: string): Promise<void> {
  // Delete PNG files
  await deleteBuildingPngs(buildingId);

  // Delete database records (should cascade from buildings table, but just in case)
  await db.delete(schema.buildingTiles)
    .where(eq(schema.buildingTiles.buildingId, buildingId));

  console.log(`[Building] Deleted building ${buildingId}`);
}
