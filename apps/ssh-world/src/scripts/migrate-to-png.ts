#!/usr/bin/env node
/**
 * Migration script: Convert JSON sprite/building storage to PNG files
 * Run from apps/ssh-world: pnpm exec tsx src/scripts/migrate-to-png.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Sprite, BuildingSprite } from '@maldoror/protocol';
import { saveSpriteToDisk } from '../utils/sprite-storage.js';
import { saveBuildingToDisk } from '../utils/building-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPRITES_DIR = process.env.SPRITES_DIR || path.join(__dirname, '../../sprites');
const BUILDINGS_DIR = process.env.BUILDINGS_DIR || path.join(__dirname, '../../buildings');

async function migrate(): Promise<void> {
  console.log('Starting sprite/building migration to PNG format...\n');
  console.log(`Sprites directory: ${SPRITES_DIR}`);
  console.log(`Buildings directory: ${BUILDINGS_DIR}\n`);

  let totalSprites = 0;
  let totalBuildings = 0;
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

        console.log(`  Migrating sprite for user ${userId}...`);
        const json = await fs.promises.readFile(jsonPath, 'utf-8');
        const sprite = JSON.parse(json) as Sprite;

        await saveSpriteToDisk(userId, sprite);
        totalSprites++;
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

        console.log(`  Migrating building ${buildingId}...`);
        const json = await fs.promises.readFile(jsonPath, 'utf-8');
        const sprite = JSON.parse(json) as BuildingSprite;

        await saveBuildingToDisk(buildingId, sprite);
        totalBuildings++;
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
  console.log(`Original JSON size: ${(originalSize / 1024 / 1024).toFixed(2)}MB`);

  console.log('\nMigration complete!');
  console.log('\nNote: Original JSON files were NOT deleted.');
  console.log('After verifying, you can manually delete them.');

  process.exit(0);
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
