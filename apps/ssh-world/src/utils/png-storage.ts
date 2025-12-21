import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import type { PixelGrid, Pixel } from '@maldoror/protocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base directories - Docker volume in production, local in development
const SPRITES_BASE = process.env.SPRITES_DIR ||
  (fs.existsSync('/app/sprites') ? '/app/sprites' : path.join(__dirname, '../../sprites'));
const BUILDINGS_BASE = process.env.BUILDINGS_DIR ||
  (fs.existsSync('/app/buildings') ? '/app/buildings' : path.join(__dirname, '../../buildings'));
const NPCS_BASE = process.env.NPCS_DIR ||
  (fs.existsSync('/app/npcs') ? '/app/npcs' : path.join(__dirname, '../../npcs'));

/**
 * Ensure sprite directory exists for a user
 */
export function ensureSpriteDir(userId: string): string {
  const dir = path.join(SPRITES_BASE, userId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Ensure building directory exists
 */
export function ensureBuildingDir(buildingId: string): string {
  const dir = path.join(BUILDINGS_BASE, buildingId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get sprite PNG file path
 */
export function getSpritePngPath(
  userId: string,
  direction: string,
  frameNum: number,
  resolution: number
): string {
  return path.join(SPRITES_BASE, userId, `frame_${direction}_${frameNum}_${resolution}.png`);
}

/**
 * Get building tile PNG file path
 * @param direction - Building direction (north, east, south, west) for camera rotation support
 */
export function getBuildingPngPath(
  buildingId: string,
  tileX: number,
  tileY: number,
  resolution: number,
  direction: string = 'north'
): string {
  return path.join(BUILDINGS_BASE, buildingId, `tile_${direction}_${tileX}_${tileY}_${resolution}.png`);
}

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
        buffer[idx + 3] = 255; // Fully opaque
      } else {
        // Transparent pixel
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
 * Convert RGBA buffer back to PixelGrid
 */
function rgbaBufferToPixelGrid(data: Buffer, width: number, height: number): PixelGrid {
  const grid: PixelGrid = [];

  for (let y = 0; y < height; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const a = data[idx + 3]!;

      if (a < 128) {
        // Treat as transparent
        row.push(null);
      } else {
        row.push({ r, g, b });
      }
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Save a PixelGrid as a PNG file
 */
export async function savePixelGridAsPng(pixels: PixelGrid, filePath: string): Promise<void> {
  const { buffer, width, height } = pixelGridToRgbaBuffer(pixels);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await sharp(buffer, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png({ compressionLevel: 9 })
    .toFile(filePath);
}

/**
 * Load a PNG file as a PixelGrid
 */
export async function loadPngAsPixelGrid(filePath: string): Promise<PixelGrid> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return rgbaBufferToPixelGrid(data, info.width, info.height);
}

/**
 * Check if a PNG file exists
 */
export function pngExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Delete a PNG file
 */
export async function deletePng(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Delete all PNGs for a sprite (all directions, frames, resolutions)
 */
export async function deleteSpritePngs(userId: string): Promise<void> {
  const dir = path.join(SPRITES_BASE, userId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[PNG] Failed to delete sprite directory for ${userId}:`, error);
    }
  }
}

/**
 * Delete all PNGs for a building
 */
export async function deleteBuildingPngs(buildingId: string): Promise<void> {
  const dir = path.join(BUILDINGS_BASE, buildingId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[PNG] Failed to delete building directory for ${buildingId}:`, error);
    }
  }
}

/**
 * Get total size of all PNGs for a sprite
 */
export async function getSpritePngSize(userId: string): Promise<number> {
  const dir = path.join(SPRITES_BASE, userId);
  try {
    const files = await fs.promises.readdir(dir);
    let totalSize = 0;
    for (const file of files) {
      const stat = await fs.promises.stat(path.join(dir, file));
      totalSize += stat.size;
    }
    return totalSize;
  } catch {
    return 0;
  }
}

/**
 * Get total size of all PNGs for a building
 */
export async function getBuildingPngSize(buildingId: string): Promise<number> {
  const dir = path.join(BUILDINGS_BASE, buildingId);
  try {
    const files = await fs.promises.readdir(dir);
    let totalSize = 0;
    for (const file of files) {
      const stat = await fs.promises.stat(path.join(dir, file));
      totalSize += stat.size;
    }
    return totalSize;
  } catch {
    return 0;
  }
}

// ============== NPC PNG HELPERS ==============

/**
 * Ensure NPC sprite directory exists
 */
export function ensureNPCDir(npcId: string): string {
  const dir = path.join(NPCS_BASE, npcId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get NPC sprite PNG file path
 */
export function getNPCPngPath(
  npcId: string,
  direction: string,
  frameNum: number,
  resolution: number
): string {
  return path.join(NPCS_BASE, npcId, `frame_${direction}_${frameNum}_${resolution}.png`);
}

/**
 * Delete all PNGs for an NPC
 */
export async function deleteNPCPngs(npcId: string): Promise<void> {
  const dir = path.join(NPCS_BASE, npcId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[PNG] Failed to delete NPC directory for ${npcId}:`, error);
    }
  }
}

/**
 * Get total size of all PNGs for an NPC
 */
export async function getNPCPngSize(npcId: string): Promise<number> {
  const dir = path.join(NPCS_BASE, npcId);
  try {
    const files = await fs.promises.readdir(dir);
    let totalSize = 0;
    for (const file of files) {
      const stat = await fs.promises.stat(path.join(dir, file));
      totalSize += stat.size;
    }
    return totalSize;
  } catch {
    return 0;
  }
}
