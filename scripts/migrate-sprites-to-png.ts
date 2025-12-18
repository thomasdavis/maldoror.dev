#!/usr/bin/env npx tsx
/**
 * Migration script: Convert JSON sprite/building storage to PNG files
 *
 * This script:
 * 1. Reads existing JSON sprite files from /app/sprites/*.json
 * 2. Converts each frame/resolution to individual PNG files
 * 3. Inserts corresponding rows into sprite_frames table
 * 4. Does the same for building JSON files
 *
 * Usage:
 *   npx tsx scripts/migrate-sprites-to-png.ts
 *
 * Set environment variables:
 *   SPRITES_DIR - Directory containing sprite JSON files (default: /app/sprites)
 *   BUILDINGS_DIR - Directory containing building JSON files (default: /app/buildings)
 *   DATABASE_URL - PostgreSQL connection string
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';
import type { Sprite, BuildingSprite, PixelGrid, Pixel } from '@maldoror/protocol';
import { RESOLUTIONS } from '@maldoror/protocol';

const SPRITES_DIR = process.env.SPRITES_DIR || '/app/sprites';
const BUILDINGS_DIR = process.env.BUILDINGS_DIR || '/app/buildings';

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

/**
 * Convert PixelGrid to RGBA buffer for sharp
 */
function pixelGridToRgbaBuffer(pixels: PixelGrid): { buffer: Buffer; width: number; height: number } {
  const height = pixels.length;
  const width = pixels[0]?.length ?? 0;
  const buffer = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const row = pixels[y];
    if (!row) continue;

    for (let x = 0; x < width; x++) {
      const pixel = row[x];
      const idx = (y * width + x) * 4;

      if (pixel && 'r' in pixel) {
        buffer[idx] = pixel.r;
        buffer[idx + 1] = pixel.g;
        buffer[idx + 2] = pixel.b;
        buffer[idx + 3] = 255;
      } else {
        buffer[idx] = 0;
        buffer[idx + 1] = 0;
        buffer[idx + 2] = 0;
        buffer[idx + 3] = 0;
      }
    }
  }

  return { buffer, width, height };
}

/**
 * Save a PixelGrid as a PNG file
 */
async function savePixelGridAsPng(pixels: PixelGrid, filePath: string): Promise<void> {
  const { buffer, width, height } = pixelGridToRgbaBuffer(pixels);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await sharp(buffer, {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(filePath);
}

/**
 * Migrate a single sprite JSON file to PNGs
 */
async function migrateSprite(userId: string, jsonPath: string): Promise<{ files: number; size: number }> {
  console.log(`  Migrating sprite for user ${userId}...`);

  const json = await fs.promises.readFile(jsonPath, 'utf-8');
  const sprite = JSON.parse(json) as Sprite;

  const spriteDir = path.join(SPRITES_DIR, userId);
  if (!fs.existsSync(spriteDir)) {
    fs.mkdirSync(spriteDir, { recursive: true });
  }

  let totalFiles = 0;
  let totalSize = 0;

  // Process each direction and frame
  for (const direction of DIRECTIONS) {
    for (let frameNum = 0; frameNum < 4; frameNum++) {
      for (const resolution of RESOLUTIONS) {
        // Get pixels from the appropriate resolution
        let pixels: PixelGrid | undefined;
        const resKey = String(resolution);

        if (sprite.resolutions?.[resKey]) {
          const dirFrames = sprite.resolutions[resKey][direction];
          pixels = dirFrames?.[frameNum];
        } else if (resolution === 256) {
          pixels = sprite.frames[direction]?.[frameNum];
        }

        if (!pixels || pixels.length === 0) continue;

        const filePath = path.join(spriteDir, `frame_${direction}_${frameNum}_${resolution}.png`);
        const relativePath = `${userId}/frame_${direction}_${frameNum}_${resolution}.png`;

        await savePixelGridAsPng(pixels, filePath);

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
        const stat = await fs.promises.stat(filePath);
        totalSize += stat.size;
      }
    }
  }

  return { files: totalFiles, size: totalSize };
}

/**
 * Migrate a single building JSON file to PNGs
 */
async function migrateBuilding(buildingId: string, jsonPath: string): Promise<{ files: number; size: number }> {
  console.log(`  Migrating building ${buildingId}...`);

  const json = await fs.promises.readFile(jsonPath, 'utf-8');
  const sprite = JSON.parse(json) as BuildingSprite;

  const buildingDir = path.join(BUILDINGS_DIR, buildingId);
  if (!fs.existsSync(buildingDir)) {
    fs.mkdirSync(buildingDir, { recursive: true });
  }

  let totalFiles = 0;
  let totalSize = 0;

  // Process each tile position
  for (let tileY = 0; tileY < 3; tileY++) {
    for (let tileX = 0; tileX < 3; tileX++) {
      const tile = sprite.tiles[tileY]?.[tileX];
      if (!tile) continue;

      for (const resolution of RESOLUTIONS) {
        const pixels = tile.resolutions[String(resolution)];
        if (!pixels || pixels.length === 0) continue;

        const filePath = path.join(buildingDir, `tile_${tileX}_${tileY}_${resolution}.png`);
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
        const stat = await fs.promises.stat(filePath);
        totalSize += stat.size;
      }
    }
  }

  return { files: totalFiles, size: totalSize };
}

/**
 * Main migration function
 */
async function migrate(): Promise<void> {
  console.log('Starting sprite/building migration to PNG format...\n');
  console.log(`Sprites directory: ${SPRITES_DIR}`);
  console.log(`Buildings directory: ${BUILDINGS_DIR}\n`);

  let totalSprites = 0;
  let totalBuildings = 0;
  let totalFiles = 0;
  let totalSize = 0;
  let originalSize = 0;

  // Migrate sprites
  if (fs.existsSync(SPRITES_DIR)) {
    const files = await fs.promises.readdir(SPRITES_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    console.log(`Found ${jsonFiles.length} sprite JSON files to migrate`);

    for (const file of jsonFiles) {
      const userId = path.basename(file, '.json');
      const jsonPath = path.join(SPRITES_DIR, file);

      try {
        const jsonStat = await fs.promises.stat(jsonPath);
        originalSize += jsonStat.size;

        const result = await migrateSprite(userId, jsonPath);
        totalSprites++;
        totalFiles += result.files;
        totalSize += result.size;

        console.log(`    Created ${result.files} PNGs (${(result.size / 1024).toFixed(1)}KB)`);
      } catch (error) {
        console.error(`  Failed to migrate sprite ${userId}:`, error);
      }
    }
  } else {
    console.log('No sprites directory found, skipping sprite migration');
  }

  console.log('');

  // Migrate buildings
  if (fs.existsSync(BUILDINGS_DIR)) {
    const files = await fs.promises.readdir(BUILDINGS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    console.log(`Found ${jsonFiles.length} building JSON files to migrate`);

    for (const file of jsonFiles) {
      const buildingId = path.basename(file, '.json');
      const jsonPath = path.join(BUILDINGS_DIR, file);

      try {
        const jsonStat = await fs.promises.stat(jsonPath);
        originalSize += jsonStat.size;

        const result = await migrateBuilding(buildingId, jsonPath);
        totalBuildings++;
        totalFiles += result.files;
        totalSize += result.size;

        console.log(`    Created ${result.files} PNGs (${(result.size / 1024).toFixed(1)}KB)`);
      } catch (error) {
        console.error(`  Failed to migrate building ${buildingId}:`, error);
      }
    }
  } else {
    console.log('No buildings directory found, skipping building migration');
  }

  // Summary
  console.log('\n=== Migration Summary ===');
  console.log(`Sprites migrated: ${totalSprites}`);
  console.log(`Buildings migrated: ${totalBuildings}`);
  console.log(`Total PNG files created: ${totalFiles}`);
  console.log(`Original JSON size: ${(originalSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`New PNG size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`Space saved: ${((1 - totalSize / originalSize) * 100).toFixed(1)}%`);

  console.log('\nMigration complete!');
  console.log('\nNote: Original JSON files were NOT deleted.');
  console.log('After verifying the migration, you can manually delete them:');
  console.log(`  rm ${SPRITES_DIR}/*.json`);
  console.log(`  rm ${BUILDINGS_DIR}/*.json`);

  process.exit(0);
}

// Run migration
migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
