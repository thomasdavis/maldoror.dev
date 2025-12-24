import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import type { Sprite, PixelGrid, Pixel } from '@maldoror/protocol';
import { BASE_SIZE, RESOLUTIONS } from '@maldoror/protocol';

// Configure Sharp for better memory management in high-concurrency environments
sharp.cache(false);     // Disable file cache to free memory immediately
sharp.concurrency(1);   // Single thread to prevent memory spikes
sharp.simd(false);      // Disable SIMD to reduce memory per operation

/**
 * Trigger garbage collection if available (requires --expose-gc)
 */
function tryGC(): void {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

const DEBUG_DIR = 'debug-sprites';

/**
 * Convert raw RGBA buffer to PixelGrid
 */
function imageToPixelGrid(
  data: Buffer,
  width: number,
  height: number,
  alphaThreshold = 32
): PixelGrid {
  const grid: PixelGrid = [];

  for (let y = 0; y < height; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const a = data[idx + 3]!;

      if (a < alphaThreshold) {
        row.push(null); // transparent
      } else {
        row.push({ r, g, b });
      }
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Build the prompt for HIGH-FIDELITY sprite generation
 * NOT pixel art - we want detailed, smooth artwork that we'll pixelate ourselves
 * Works for any subject: humans, animals, monsters, creatures, objects, etc.
 */
function buildImagePrompt(description: string): string {
  return `Create a detailed illustration for a TOP-DOWN RPG game (like classic Zelda, Pokemon, or Final Fantasy).

SUBJECT: ${description}

STYLE REQUIREMENTS:
- High quality, detailed digital art illustration
- Smooth gradients and shading - NOT pixel art
- Rich colors with proper lighting and depth
- Clean, professional game art style
- Top-down perspective with slight 3/4 view (camera looking down at subject)
- No ground, platform, or background objects - just the subject itself

COMPOSITION REQUIREMENTS:
- The ENTIRE subject must be visible - NO cropping
- Full body visible in frame (head to feet/paws/base)
- Subject should fill most of the image but with small margin to prevent cropping
- The subject must be 100% OPAQUE and SOLID
- Only the background should be transparent
- Center the subject in the image

DO NOT:
- Create pixel art or blocky/pixelated style
- Crop any part of the subject (head, tail, limbs, etc.)
- Make the subject semi-transparent
- Add any background elements, text, UI, or borders
- Add any effects or particles around the subject
- Use side-view or profile perspective (this is top-down view)`;
}

/**
 * Convert PixelGrid back to PNG buffer
 */
async function pixelGridToPng(grid: PixelGrid, width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = grid[y]?.[x];
      const idx = (y * width + x) * 4;
      if (pixel === null || pixel === undefined) {
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0; // transparent
      } else {
        data[idx] = pixel.r;
        data[idx + 1] = pixel.g;
        data[idx + 2] = pixel.b;
        data[idx + 3] = 255;
      }
    }
  }

  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

export interface ImageSpriteGenerationOptions {
  description: string;
  apiKey: string;
  model?: 'dall-e-3' | 'dall-e-2' | 'gpt-image-1' | 'gpt-image-1-mini';
  quality?: 'low' | 'medium' | 'high' | 'auto';
  username?: string;
  onProgress?: (step: string, current: number, total: number) => void;
}

export interface ImageSpriteGenerationResult {
  success: boolean;
  sprite?: Sprite;
  error?: string;
  debugDir?: string;
}

/**
 * Generate a single high-fidelity image with optional reference
 */
async function generateSingleImage(
  openai: OpenAI,
  model: string,
  prompt: string,
  quality: 'low' | 'medium' | 'high' | 'auto',
  referencePngBuffer?: Buffer
): Promise<Buffer> {
  const common = {
    model,
    prompt,
    size: '1024x1024' as const,
    quality,
    background: 'transparent' as const,
  };

  const result = referencePngBuffer
    ? await openai.images.edit({
        ...common,
        image: await toFile(referencePngBuffer, 'ref.png', { type: 'image/png' }),
      })
    : await openai.images.generate(common);

  // Log full response for debugging (excluding base64 data which is huge)
  const debugResult = {
    ...result,
    data: result.data?.map(item => ({
      ...item,
      b64_json: item.b64_json ? `[${item.b64_json.length} chars]` : undefined,
    })),
  };
  console.log('[IMAGE GEN RESPONSE]', JSON.stringify(debugResult, null, 2));

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('No image base64 data returned');
  }

  return Buffer.from(b64, 'base64');
}

/**
 * Pixelate a high-fidelity image to a specific size
 * Uses nearest-neighbor resampling for clean pixel art look
 */
async function pixelateImageToSize(imageBuffer: Buffer, size: number): Promise<PixelGrid> {
  // First, trim transparent edges to get just the character
  const trimmed = await sharp(imageBuffer)
    .trim({ threshold: 10 })
    .toBuffer();

  // Resize to target size with nearest-neighbor for clean pixels
  const raw = await sharp(trimmed)
    .resize(size, size, {
      fit: 'contain',           // Maintain aspect ratio, fit within bounds
      kernel: 'nearest',        // Nearest neighbor for pixelated look
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // Transparent padding
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return imageToPixelGrid(raw.data, raw.info.width, raw.info.height);
}

/**
 * Pixelate an image to all resolution sizes
 */
async function pixelateImageAllResolutions(imageBuffer: Buffer): Promise<Record<string, PixelGrid>> {
  const results: Record<string, PixelGrid> = {};
  for (const size of RESOLUTIONS) {
    results[String(size)] = await pixelateImageToSize(imageBuffer, size);
  }
  return results;
}

/**
 * Flip a PixelGrid horizontally (mirror left-right)
 * Used to create right-facing sprites from left-facing ones
 */
function flipPixelGridHorizontally(grid: PixelGrid): PixelGrid {
  return grid.map(row => [...row].reverse());
}

/**
 * Flip all resolutions horizontally
 */
function flipAllResolutions(resolutions: Record<string, PixelGrid>): Record<string, PixelGrid> {
  const result: Record<string, PixelGrid> = {};
  for (const [size, grid] of Object.entries(resolutions)) {
    result[size] = flipPixelGridHorizontally(grid);
  }
  return result;
}

/**
 * Generate a sprite using OpenAI's image generation
 *
 * Process:
 * 1. Generate HIGH-FIDELITY images (not pixel art)
 * 2. Save originals to disk
 * 3. Pixelate to 256x256 ourselves
 */
export async function generateImageSprite(
  options: ImageSpriteGenerationOptions
): Promise<ImageSpriteGenerationResult> {
  const { description, apiKey, model = 'gpt-image-1-mini', quality = 'high', username = 'unknown', onProgress } = options;

  const openai = new OpenAI({ apiKey });

  // Create debug directory for this generation
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeUsername = username.replace(/[^a-zA-Z0-9]/g, '_');
  const debugDir = path.join(DEBUG_DIR, `${timestamp}_${safeUsername}`);

  const progress = (step: string, current: number, total: number) => {
    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
    console.log(`[SPRITE ${current}/${total}] ${step} (heap: ${heapMB}MB)`);
    onProgress?.(step, current, total);
  };

  try {
    // Create debug directory
    fs.mkdirSync(debugDir, { recursive: true });

    const basePrompt = buildImagePrompt(description);

    // Save prompt for debugging
    fs.writeFileSync(path.join(debugDir, 'prompt.txt'), basePrompt);

    // Reference prompt for consistency
    const refNote = `\nIMPORTANT: Match the EXACT same subject from the reference image. Same colors, markings, features, and style. Keep smooth detailed art style, NOT pixel art. Ensure ENTIRE subject is visible, no cropping.`;

    // Store original images
    const originals: Map<string, Buffer> = new Map();

    // Step 1: Generate down/front standing FIRST (sync - needed as reference for others)
    progress('Generating down view (standing)', 1, 8);
    const downStandingPrompt = `${basePrompt}\nTop-down RPG view: Subject facing DOWN (toward the camera/bottom of screen). Standing/idle pose. We see the top of their head and front of body.`;
    const downStandingOriginal = await generateSingleImage(openai, model, downStandingPrompt, quality);
    originals.set('1_down_standing', downStandingOriginal);
    fs.writeFileSync(path.join(debugDir, '1_down_standing_original.png'), downStandingOriginal);

    // Steps 2-6: Generate remaining 5 images IN PARALLEL (using down standing as reference)
    // NOTE: Right-facing sprites are created by flipping left-facing ones for guaranteed symmetry
    progress('Generating remaining views (parallel)', 2, 6);

    const upStandingPrompt = `${basePrompt}\nTop-down RPG view: Subject facing UP (away from camera/top of screen). Standing/idle pose. We see the back of their head and back of body.${refNote}`;
    const leftStandingPrompt = `${basePrompt}\nTop-down RPG view: Subject facing LEFT (left side of screen). Standing/idle pose. We see the left side profile.${refNote}`;
    const downWalkingPrompt = `${basePrompt}\nTop-down RPG view: Subject facing DOWN, in a moving/walking pose.${refNote}`;
    const upWalkingPrompt = `${basePrompt}\nTop-down RPG view: Subject facing UP (showing back), in a moving/walking pose.${refNote}`;
    const leftWalkingPrompt = `${basePrompt}\nTop-down RPG view: Subject facing LEFT, in a moving/walking pose.${refNote}`;

    const [
      upStandingOriginal,
      leftStandingOriginal,
      downWalkingOriginal,
      upWalkingOriginal,
      leftWalkingOriginal,
    ] = await Promise.all([
      generateSingleImage(openai, model, upStandingPrompt, quality, downStandingOriginal),
      generateSingleImage(openai, model, leftStandingPrompt, quality, downStandingOriginal),
      generateSingleImage(openai, model, downWalkingPrompt, quality, downStandingOriginal),
      generateSingleImage(openai, model, upWalkingPrompt, quality, downStandingOriginal),
      generateSingleImage(openai, model, leftWalkingPrompt, quality, downStandingOriginal),
    ]);

    // Save parallel-generated originals
    originals.set('2_up_standing', upStandingOriginal);
    originals.set('3_left_standing', leftStandingOriginal);
    originals.set('4_down_walking', downWalkingOriginal);
    originals.set('5_up_walking', upWalkingOriginal);
    originals.set('6_left_walking', leftWalkingOriginal);

    fs.writeFileSync(path.join(debugDir, '2_up_standing_original.png'), upStandingOriginal);
    fs.writeFileSync(path.join(debugDir, '3_left_standing_original.png'), leftStandingOriginal);
    fs.writeFileSync(path.join(debugDir, '4_down_walking_original.png'), downWalkingOriginal);
    fs.writeFileSync(path.join(debugDir, '5_up_walking_original.png'), upWalkingOriginal);
    fs.writeFileSync(path.join(debugDir, '6_left_walking_original.png'), leftWalkingOriginal);

    // Trigger GC after saving large images
    tryGC();

    // Now pixelate all images at all resolutions - do sequentially to reduce memory
    progress('Pixelating images at all resolutions', 6, 6);

    // Process sequentially to keep memory lower
    const downStandingRes = await pixelateImageAllResolutions(downStandingOriginal);
    const upStandingRes = await pixelateImageAllResolutions(upStandingOriginal);
    const leftStandingRes = await pixelateImageAllResolutions(leftStandingOriginal);
    tryGC();
    const downWalkingRes = await pixelateImageAllResolutions(downWalkingOriginal);
    const upWalkingRes = await pixelateImageAllResolutions(upWalkingOriginal);
    const leftWalkingRes = await pixelateImageAllResolutions(leftWalkingOriginal);
    tryGC();

    // Create right-facing sprites by horizontally flipping left-facing ones
    // This guarantees perfect left/right symmetry and eliminates AI inconsistency
    const rightStandingRes = flipAllResolutions(leftStandingRes);
    const rightWalkingRes = flipAllResolutions(leftWalkingRes);

    // Save pixelated versions for debugging (just the base size)
    const baseSize = String(BASE_SIZE);
    for (const [name, original] of originals) {
      const pixelated = await pixelateImageToSize(original, BASE_SIZE);
      const pixelatedPng = await pixelGridToPng(pixelated, BASE_SIZE, BASE_SIZE);
      fs.writeFileSync(path.join(debugDir, `${name}_pixelated_${BASE_SIZE}.png`), pixelatedPng);
    }

    // Build sprite with base frames and all resolutions
    const sprite: Sprite = {
      width: BASE_SIZE,
      height: BASE_SIZE,
      frames: {
        down: [downStandingRes[baseSize]!, downWalkingRes[baseSize]!, downStandingRes[baseSize]!, downWalkingRes[baseSize]!],
        up: [upStandingRes[baseSize]!, upWalkingRes[baseSize]!, upStandingRes[baseSize]!, upWalkingRes[baseSize]!],
        left: [leftStandingRes[baseSize]!, leftWalkingRes[baseSize]!, leftStandingRes[baseSize]!, leftWalkingRes[baseSize]!],
        right: [rightStandingRes[baseSize]!, rightWalkingRes[baseSize]!, rightStandingRes[baseSize]!, rightWalkingRes[baseSize]!],
      },
      resolutions: {},
    };

    // Add all pre-computed resolutions
    for (const size of RESOLUTIONS) {
      const sizeKey = String(size);
      sprite.resolutions![sizeKey] = {
        down: [downStandingRes[sizeKey]!, downWalkingRes[sizeKey]!, downStandingRes[sizeKey]!, downWalkingRes[sizeKey]!],
        up: [upStandingRes[sizeKey]!, upWalkingRes[sizeKey]!, upStandingRes[sizeKey]!, upWalkingRes[sizeKey]!],
        left: [leftStandingRes[sizeKey]!, leftWalkingRes[sizeKey]!, leftStandingRes[sizeKey]!, leftWalkingRes[sizeKey]!],
        right: [rightStandingRes[sizeKey]!, rightWalkingRes[sizeKey]!, rightStandingRes[sizeKey]!, rightWalkingRes[sizeKey]!],
      };
    }

    // Save sprite JSON
    fs.writeFileSync(path.join(debugDir, 'sprite.json'), JSON.stringify(sprite, null, 2));

    // Clear references to allow GC to reclaim memory
    originals.clear();
    tryGC();

    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
    console.log(`Sprite generated successfully. Debug files: ${debugDir} (final heap: ${heapMB}MB)`);
    return { success: true, sprite, debugDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Image sprite generation failed:', message);
    return { success: false, error: message, debugDir };
  }
}

/**
 * Quantize colors in a pixel grid to a limited palette
 */
export function quantizePixelGrid(
  grid: PixelGrid,
  maxColors: number = 16
): PixelGrid {
  const colors: Array<{ r: number; g: number; b: number }> = [];
  for (const row of grid) {
    for (const pixel of row) {
      if (pixel !== null) {
        colors.push(pixel);
      }
    }
  }

  if (colors.length === 0) return grid;

  const step = Math.ceil(256 / Math.cbrt(maxColors));

  return grid.map(row =>
    row.map(pixel => {
      if (pixel === null) return null;
      return {
        r: Math.round(pixel.r / step) * step,
        g: Math.round(pixel.g / step) * step,
        b: Math.round(pixel.b / step) * step,
      };
    })
  );
}
