/**
 * Terrain tile storage utilities
 *
 * Saves AI-generated terrain tiles as PNG files and loads them at startup.
 * Falls back to solid color tiles if AI tiles aren't available.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Tile, PixelGrid } from '@maldoror/protocol';
import { BASE_SIZE, RESOLUTIONS } from '@maldoror/protocol';
import {
  savePixelGridAsPng,
  loadPngAsPixelGrid,
} from './png-storage.js';
import { db, schema } from '@maldoror/db';

// Directory for terrain tile PNGs
const TERRAIN_DIR = 'data/terrain';

/**
 * Ensure terrain directory exists
 */
function ensureTerrainDir(): void {
  if (!fs.existsSync(TERRAIN_DIR)) {
    fs.mkdirSync(TERRAIN_DIR, { recursive: true });
  }
}

/**
 * Get path for a terrain tile PNG
 */
function getTerrainPngPath(tileId: string, resolution: number): string {
  return path.join(TERRAIN_DIR, tileId, `${resolution}.png`);
}

/**
 * Save a terrain tile to disk
 */
export async function saveTerrainTileToDisk(tile: Tile): Promise<void> {
  ensureTerrainDir();

  const tileDir = path.join(TERRAIN_DIR, tile.id);
  if (!fs.existsSync(tileDir)) {
    fs.mkdirSync(tileDir, { recursive: true });
  }

  let totalFiles = 0;
  let totalSize = 0;

  // Save each resolution
  for (const resolution of RESOLUTIONS) {
    const pixels = tile.resolutions?.[String(resolution)] ?? tile.pixels;
    const filePath = getTerrainPngPath(tile.id, resolution);

    await savePixelGridAsPng(pixels, filePath);
    totalFiles++;

    try {
      const stat = await fs.promises.stat(filePath);
      totalSize += stat.size;
    } catch {
      // Ignore stat errors
    }
  }

  // Save animation frames if present
  if (tile.animated && tile.animationFrames) {
    const animDir = path.join(tileDir, 'anim');
    if (!fs.existsSync(animDir)) {
      fs.mkdirSync(animDir, { recursive: true });
    }

    for (let frameIdx = 0; frameIdx < tile.animationFrames.length; frameIdx++) {
      for (const resolution of RESOLUTIONS) {
        const pixels = tile.animationResolutions?.[String(resolution)]?.[frameIdx]
          ?? tile.animationFrames[frameIdx];

        if (pixels) {
          const filePath = path.join(animDir, `frame_${frameIdx}_${resolution}.png`);
          await savePixelGridAsPng(pixels, filePath);
          totalFiles++;
        }
      }
    }
  }

  // Save metadata
  const metadata = {
    id: tile.id,
    name: tile.name,
    walkable: tile.walkable,
    animated: tile.animated || false,
    frameCount: tile.animationFrames?.length || 0,
  };
  fs.writeFileSync(path.join(tileDir, 'meta.json'), JSON.stringify(metadata, null, 2));

  console.log(`[Terrain] Saved ${tile.id}: ${totalFiles} PNGs (${(totalSize / 1024).toFixed(1)}KB)`);
}

/**
 * Load a terrain tile from disk
 * Returns null if not found
 */
export async function loadTerrainTileFromDisk(tileId: string): Promise<Tile | null> {
  const tileDir = path.join(TERRAIN_DIR, tileId);
  const metaPath = path.join(tileDir, 'meta.json');

  // Check if tile exists
  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    // Load metadata
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

    // Load base resolution
    const basePath = getTerrainPngPath(tileId, BASE_SIZE);
    const basePixels = await loadPngAsPixelGrid(basePath);

    if (!basePixels) {
      console.warn(`[Terrain] Missing base resolution for ${tileId}`);
      return null;
    }

    // Load all resolutions
    const resolutions: Record<string, PixelGrid> = {};
    for (const resolution of RESOLUTIONS) {
      const filePath = getTerrainPngPath(tileId, resolution);
      const pixels = await loadPngAsPixelGrid(filePath);
      if (pixels) {
        resolutions[String(resolution)] = pixels;
      }
    }

    const tile: Tile = {
      id: metadata.id,
      name: metadata.name,
      pixels: basePixels,
      walkable: metadata.walkable,
      resolutions,
    };

    // Load animation frames if present
    if (metadata.animated && metadata.frameCount > 0) {
      tile.animated = true;
      tile.animationFrames = [];
      tile.animationResolutions = {};

      const animDir = path.join(tileDir, 'anim');

      for (let frameIdx = 0; frameIdx < metadata.frameCount; frameIdx++) {
        // Load base frame
        const framePath = path.join(animDir, `frame_${frameIdx}_${BASE_SIZE}.png`);
        const framePixels = await loadPngAsPixelGrid(framePath);
        if (framePixels) {
          tile.animationFrames.push(framePixels);
        }

        // Load frame resolutions
        for (const resolution of RESOLUTIONS) {
          const resFramePath = path.join(animDir, `frame_${frameIdx}_${resolution}.png`);
          const resFramePixels = await loadPngAsPixelGrid(resFramePath);
          if (resFramePixels) {
            if (!tile.animationResolutions![String(resolution)]) {
              tile.animationResolutions![String(resolution)] = [];
            }
            tile.animationResolutions![String(resolution)]!.push(resFramePixels);
          }
        }
      }
    }

    return tile;
  } catch (error) {
    console.error(`[Terrain] Failed to load ${tileId}:`, error);
    return null;
  }
}

/**
 * Check if a terrain tile exists on disk
 */
export function terrainTileExistsOnDisk(tileId: string): boolean {
  const metaPath = path.join(TERRAIN_DIR, tileId, 'meta.json');
  return fs.existsSync(metaPath);
}

/**
 * Load all available terrain tiles from disk
 * Returns a map of tile ID to Tile
 */
export async function loadAllTerrainTilesFromDisk(): Promise<Map<string, Tile>> {
  const tiles = new Map<string, Tile>();

  ensureTerrainDir();

  // List all directories in terrain folder
  const entries = fs.readdirSync(TERRAIN_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const tile = await loadTerrainTileFromDisk(entry.name);
      if (tile) {
        tiles.set(entry.name, tile);
      }
    }
  }

  console.log(`[Terrain] Loaded ${tiles.size} AI terrain tiles from disk`);
  return tiles;
}

/**
 * Delete a terrain tile from disk
 */
export async function deleteTerrainTileFromDisk(tileId: string): Promise<void> {
  const tileDir = path.join(TERRAIN_DIR, tileId);

  if (fs.existsSync(tileDir)) {
    await fs.promises.rm(tileDir, { recursive: true });
    console.log(`[Terrain] Deleted ${tileId}`);
  }
}

/**
 * Load all terrain tiles from the database
 * Returns a map of tile ID to Tile
 */
export async function loadAllTerrainTilesFromDB(): Promise<Map<string, Tile>> {
  const tiles = new Map<string, Tile>();

  try {
    const dbTiles = await db.select().from(schema.terrainTiles);

    for (const dbTile of dbTiles) {
      try {
        const tile: Tile = {
          id: dbTile.id,
          name: dbTile.name,
          pixels: JSON.parse(dbTile.pixels) as PixelGrid,
          walkable: dbTile.walkable,
          resolutions: dbTile.resolutions ? JSON.parse(dbTile.resolutions) : undefined,
          animated: dbTile.animated || false,
          animationFrames: dbTile.animationFrames ? JSON.parse(dbTile.animationFrames) : undefined,
          animationResolutions: dbTile.animationResolutions ? JSON.parse(dbTile.animationResolutions) : undefined,
        };
        tiles.set(tile.id, tile);
      } catch (parseError) {
        console.error(`[Terrain] Failed to parse tile ${dbTile.id}:`, parseError);
      }
    }

    console.log(`[Terrain] Loaded ${tiles.size} AI terrain tiles from database`);
  } catch (error) {
    console.error('[Terrain] Failed to load tiles from database:', error);
  }

  return tiles;
}
