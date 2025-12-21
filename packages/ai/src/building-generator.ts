import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import type { PixelGrid, Pixel, BuildingSprite, BuildingTile } from '@maldoror/protocol';
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

/**
 * Building direction type for camera rotation support
 * north = 0° (original), east = 90° CW, south = 180°, west = 270° CW
 */
export type BuildingDirection = 'north' | 'east' | 'south' | 'west';

/**
 * Directional building sprite - 4 orientations for camera rotation
 */
export interface DirectionalBuildingSprite {
  north: BuildingSprite;  // 0° - original
  east: BuildingSprite;   // 90° CW
  south: BuildingSprite;  // 180°
  west: BuildingSprite;   // 270° CW
}

/** All building directions */
export const BUILDING_DIRECTIONS: BuildingDirection[] = ['north', 'east', 'south', 'west'];

const DEBUG_DIR = 'debug-buildings';

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
 * Build the prompt for structure generation (north/front view - no reference)
 * Supports any placeable structure: buildings, farms, gardens, monuments, etc.
 */
function buildBuildingPromptNorth(description: string): string {
  return `Create a detailed TOP-DOWN isometric view of a structure/construction for an RPG game world.

This can be ANY type of structure the player wants to build:
- Buildings (houses, towers, shops, temples)
- Farms and agricultural plots (crop fields, orchards, barns)
- Gardens and landscaping (flower beds, hedges, fountains)
- Infrastructure (bridges, walls, fences, roads)
- Monuments and decorations (statues, obelisks, shrines)
- Natural constructions (tree houses, caves, rock formations)
- Industrial (mills, forges, mines)
- Or anything else creative!

STYLE REQUIREMENTS:
- High quality, detailed digital art illustration
- TOP-DOWN isometric perspective (slight 3/4 view looking down)
- Show the NORTH/FRONT face prominently
- Clean, professional game art style
- Rich colors with proper shading and depth

COMPOSITION REQUIREMENTS:
- The structure should fill the ENTIRE square image
- Must be a 3x3 tile grid structure when divided equally
- Each of the 9 sections should be visually coherent as individual tiles
- The structure should have clear edges that align with the tile grid
- Transparent/empty background only - no ground, grass, or surroundings
- The structure itself should be 100% opaque

DO NOT:
- Create pixel art or blocky style
- Add any background elements, ground plane, shadows on ground, or surroundings
- Add text, UI, borders, or frames
- Make any part semi-transparent (except intentional gaps/openings)

STRUCTURE TO CREATE: ${description}

This is the NORTH-FACING view (front/main viewing angle).`;
}

/**
 * Build the prompt for other directional views (using north as reference)
 */
function buildBuildingPromptDirection(
  _description: string,
  direction: 'east' | 'south' | 'west'
): string {
  const directionInstructions = {
    east: `CAMERA POSITION: You are now standing to the EAST of the structure, looking WEST at it.

WHAT YOU SEE:
- The EAST side is now the prominent front-facing view
- This was the RIGHT side in the reference (north view)
- Rotate the entire structure 90° CLOCKWISE from the reference
- Features that were on the right in the reference are now facing you`,

    south: `CAMERA POSITION: You are now standing to the SOUTH of the structure, looking NORTH at it.

WHAT YOU SEE:
- The SOUTH side (back) is now the prominent front-facing view
- This was the rear in the reference (north view)
- Rotate the entire structure 180° from the reference
- You are looking at the opposite side from the reference`,

    west: `CAMERA POSITION: You are now standing to the WEST of the structure, looking EAST at it.

WHAT YOU SEE:
- The WEST side is now the prominent front-facing view
- This was the LEFT side in the reference (north view)
- Rotate the entire structure 270° CLOCKWISE (or 90° COUNTER-CLOCKWISE) from the reference
- Features that were on the left in the reference are now facing you`,
  };

  return `Recreate the EXACT same structure from the reference image, but viewed from the ${direction.toUpperCase()}.

${directionInstructions[direction]}

CRITICAL REQUIREMENTS:
- This MUST be the IDENTICAL structure from the reference - same design, colors, materials, features
- TOP-DOWN isometric perspective (slight 3/4 view looking down)
- Structure fills the ENTIRE square image
- 3x3 tile grid structure when divided equally
- Transparent background ONLY - no ground, grass, shadows, or surroundings
- Structure must be 100% opaque

DO NOT:
- Create a different structure
- Change the design style, colors, or features
- Add or remove any elements
- Add any background elements
- Add features that weren't visible on that side in the reference
- Duplicate features that only exist on one side

IMPORTANT: Features should ONLY appear on the sides where they existed in the reference. Maintain consistency across all views.`;
}

export interface BuildingGenerationOptions {
  description: string;
  apiKey: string;
  model?: 'dall-e-3' | 'dall-e-2' | 'gpt-image-1';
  quality?: 'low' | 'medium' | 'high' | 'auto';
  username?: string;
  onProgress?: (step: string, current: number, total: number) => void;
}

export interface BuildingGenerationResult {
  success: boolean;
  sprite?: DirectionalBuildingSprite;
  error?: string;
  debugDir?: string;
}

/**
 * Generate a single high-fidelity building image
 * Optionally uses a reference image for style consistency (via images.edit)
 */
async function generateBuildingImage(
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

  // Log response for debugging (excluding base64 data)
  const debugResult = {
    ...result,
    data: result.data?.map(item => ({
      ...item,
      b64_json: item.b64_json ? `[${item.b64_json.length} chars]` : undefined,
    })),
  };
  console.log('[BUILDING GEN RESPONSE]', JSON.stringify(debugResult, null, 2));

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('No image base64 data returned');
  }

  return Buffer.from(b64, 'base64');
}

/**
 * Extract a tile from a larger image buffer
 * @param imageBuffer - Full 1024x1024 building image
 * @param tileX - Tile column (0-2)
 * @param tileY - Tile row (0-2)
 * @returns Buffer of the extracted tile (341x341 approx)
 */
async function extractTile(
  imageBuffer: Buffer,
  tileX: number,
  tileY: number
): Promise<Buffer> {
  const tileSize = Math.floor(1024 / 3); // ~341 pixels per tile

  return sharp(imageBuffer)
    .extract({
      left: tileX * tileSize,
      top: tileY * tileSize,
      width: tileSize,
      height: tileSize,
    })
    .toBuffer();
}

/**
 * Pixelate a tile image to a specific size
 */
async function pixelateTileToSize(tileBuffer: Buffer, size: number): Promise<PixelGrid> {
  const raw = await sharp(tileBuffer)
    .resize(size, size, {
      fit: 'fill',
      kernel: 'nearest',
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return imageToPixelGrid(raw.data, raw.info.width, raw.info.height);
}

/**
 * Pixelate a tile to all resolution sizes (parallel)
 */
async function pixelateTileAllResolutions(tileBuffer: Buffer): Promise<Record<string, PixelGrid>> {
  const entries = await Promise.all(
    RESOLUTIONS.map(async (size) => [String(size), await pixelateTileToSize(tileBuffer, size)] as const)
  );
  return Object.fromEntries(entries);
}

/**
 * Process a single building image into a BuildingSprite
 * Splits into 9 tiles and pixelates each to all resolutions (parallel)
 */
async function processImageToSprite(
  imageBuffer: Buffer,
  debugDir: string,
  direction: BuildingDirection
): Promise<BuildingSprite> {
  // Extract all 9 tiles in parallel
  const tilePromises = Array.from({ length: 9 }, async (_, i) => {
    const x = i % 3;
    const y = Math.floor(i / 3);
    const tile = await extractTile(imageBuffer, x, y);
    fs.writeFileSync(path.join(debugDir, `tile_${direction}_${x}_${y}.png`), tile);
    return { x, y, tile };
  });
  const extractedTiles = await Promise.all(tilePromises);

  // Pixelate all tiles in parallel
  const pixelatedPromises = extractedTiles.map(async ({ x, y, tile }) => {
    const resolutions = await pixelateTileAllResolutions(tile);
    const baseSize = String(BASE_SIZE);
    return {
      x, y,
      buildingTile: {
        pixels: resolutions[baseSize]!,
        resolutions,
      } as BuildingTile
    };
  });
  const pixelatedTiles = await Promise.all(pixelatedPromises);

  // Arrange into 3x3 grid
  const tiles: BuildingTile[][] = [[], [], []];
  for (const { x, y, buildingTile } of pixelatedTiles) {
    tiles[y]![x] = buildingTile;
  }

  return {
    width: 3,
    height: 3,
    tiles,
  };
}

/**
 * Generate a building sprite using OpenAI's image generation
 *
 * Process:
 * 1. Generate north view first (no reference) - front of building
 * 2. Generate east, south, west views in parallel using north as reference
 * 3. Split each view into 9 tiles (3x3 grid)
 * 4. Pixelate each tile to all resolutions
 *
 * This approach ensures all 4 views maintain the same style and colors,
 * similar to how avatar generation works.
 */
export async function generateBuildingSprite(
  options: BuildingGenerationOptions
): Promise<BuildingGenerationResult> {
  const { description, apiKey, model = 'gpt-image-1', quality = 'high', username = 'unknown', onProgress } = options;

  const openai = new OpenAI({ apiKey });

  // Create debug directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeUsername = username.replace(/[^a-zA-Z0-9]/g, '_');
  const debugDir = path.join(DEBUG_DIR, `${timestamp}_${safeUsername}`);

  const progress = (step: string, current: number, total: number) => {
    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
    console.log(`[BUILDING ${current}/${total}] ${step} (heap: ${heapMB}MB)`);
    onProgress?.(step, current, total);
  };

  try {
    fs.mkdirSync(debugDir, { recursive: true });

    // Save prompts for debugging
    const northPrompt = buildBuildingPromptNorth(description);
    fs.writeFileSync(path.join(debugDir, 'prompt_north.txt'), northPrompt);

    // Step 1: Generate NORTH view first (no reference - this is the base)
    progress('Generating north view (front)', 1, 5);
    const northImage = await generateBuildingImage(openai, model, northPrompt, quality);
    fs.writeFileSync(path.join(debugDir, 'building_north.png'), northImage);

    // Step 2: Generate east, south, west views IN PARALLEL using north as reference
    progress('Generating other views (using north as reference)', 2, 5);

    const eastPrompt = buildBuildingPromptDirection(description, 'east');
    const southPrompt = buildBuildingPromptDirection(description, 'south');
    const westPrompt = buildBuildingPromptDirection(description, 'west');

    fs.writeFileSync(path.join(debugDir, 'prompt_east.txt'), eastPrompt);
    fs.writeFileSync(path.join(debugDir, 'prompt_south.txt'), southPrompt);
    fs.writeFileSync(path.join(debugDir, 'prompt_west.txt'), westPrompt);

    const [eastImage, southImage, westImage] = await Promise.all([
      generateBuildingImage(openai, model, eastPrompt, quality, northImage),
      generateBuildingImage(openai, model, southPrompt, quality, northImage),
      generateBuildingImage(openai, model, westPrompt, quality, northImage),
    ]);

    // Save generated images for debugging
    fs.writeFileSync(path.join(debugDir, 'building_east.png'), eastImage);
    fs.writeFileSync(path.join(debugDir, 'building_south.png'), southImage);
    fs.writeFileSync(path.join(debugDir, 'building_west.png'), westImage);

    const buildingImages: Record<BuildingDirection, Buffer> = {
      north: northImage,
      east: eastImage,
      south: southImage,
      west: westImage,
    };

    // Step 3: Process all 4 directions into BuildingSprites SEQUENTIALLY to reduce memory
    progress('Processing tiles for all directions', 3, 5);

    // Process one at a time and clear buffers immediately after
    const north = await processImageToSprite(northImage, debugDir, 'north');
    // Clear the buffer reference - let GC reclaim it
    (buildingImages as Record<string, Buffer | null>).north = null;
    tryGC();

    const east = await processImageToSprite(eastImage, debugDir, 'east');
    (buildingImages as Record<string, Buffer | null>).east = null;
    tryGC();

    const south = await processImageToSprite(southImage, debugDir, 'south');
    (buildingImages as Record<string, Buffer | null>).south = null;
    tryGC();

    const west = await processImageToSprite(westImage, debugDir, 'west');
    (buildingImages as Record<string, Buffer | null>).west = null;
    tryGC();

    const directionalSprite: DirectionalBuildingSprite = { north, east, south, west };

    // Step 4: Save summary data for debugging (full sprite JSON is too large)
    progress('Saving sprite data', 4, 5);
    const summary = {
      directions: Object.keys(directionalSprite),
      tilesPerDirection: 9,
      resolutions: RESOLUTIONS,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(debugDir, 'building_sprite_summary.json'), JSON.stringify(summary, null, 2));

    progress('Complete', 5, 5);
    console.log(`Building generated successfully with 4 AI-generated views. Debug files: ${debugDir}`);
    return { success: true, sprite: directionalSprite, debugDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Building generation failed:', message);
    return { success: false, error: message, debugDir };
  }
}

/**
 * Generate missing directions for an existing building
 * Takes a reference image (north view) and generates east/south/west views
 * Used for migrating existing buildings to support camera rotation
 */
export interface GenerateDirectionsOptions {
  referenceImage: Buffer;  // The north/front view as PNG buffer
  description: string;     // Building description for prompts
  apiKey: string;
  model?: 'dall-e-3' | 'dall-e-2' | 'gpt-image-1';
  quality?: 'low' | 'medium' | 'high' | 'auto';
  onProgress?: (step: string, current: number, total: number) => void;
}

export interface GenerateDirectionsResult {
  success: boolean;
  images?: {
    east: Buffer;
    south: Buffer;
    west: Buffer;
  };
  error?: string;
}

/**
 * Generate east/south/west views from an existing north view
 */
export async function generateMissingDirections(
  options: GenerateDirectionsOptions
): Promise<GenerateDirectionsResult> {
  const { referenceImage, description, apiKey, model = 'gpt-image-1', quality = 'high', onProgress } = options;

  const openai = new OpenAI({ apiKey });

  const progress = (step: string, current: number, total: number) => {
    console.log(`[BUILDING MIGRATION ${current}/${total}] ${step}`);
    onProgress?.(step, current, total);
  };

  try {
    // Ensure reference is 1024x1024 for optimal AI input
    const upscaledReference = await sharp(referenceImage)
      .resize(1024, 1024, { fit: 'fill' })
      .png()
      .toBuffer();

    progress('Generating east/south/west views', 1, 2);

    const eastPrompt = buildBuildingPromptDirection(description, 'east');
    const southPrompt = buildBuildingPromptDirection(description, 'south');
    const westPrompt = buildBuildingPromptDirection(description, 'west');

    const [eastImage, southImage, westImage] = await Promise.all([
      generateBuildingImage(openai, model, eastPrompt, quality, upscaledReference),
      generateBuildingImage(openai, model, southPrompt, quality, upscaledReference),
      generateBuildingImage(openai, model, westPrompt, quality, upscaledReference),
    ]);

    progress('Complete', 2, 2);

    return {
      success: true,
      images: {
        east: eastImage,
        south: southImage,
        west: westImage,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Direction generation failed:', message);
    return { success: false, error: message };
  }
}

/**
 * Process a raw image buffer into a BuildingSprite
 * Exposed for migration use
 */
export async function processBuildingImage(
  imageBuffer: Buffer,
  debugDir?: string,
  direction: BuildingDirection = 'north'
): Promise<BuildingSprite> {
  return processImageToSprite(imageBuffer, debugDir || '/tmp', direction);
}
