import type { RGB, Pixel, PixelGrid } from '@maldoror/protocol';

/**
 * ANSI escape codes for pixel rendering
 */
const ESC = '\x1b';
const RESET = `${ESC}[0m`;

/**
 * Half-block character for high-resolution rendering
 * ▀ = upper half block - foreground color on top, background color on bottom
 */
const HALF_BLOCK_TOP = '▀';
// const HALF_BLOCK_BOTTOM = '▄';  // Available if needed for alternative rendering

/**
 * Generate ANSI background color code for RGB
 */
export function bgColor(color: RGB): string {
  return `${ESC}[48;2;${color.r};${color.g};${color.b}m`;
}

/**
 * Generate ANSI foreground color code for RGB
 */
export function fgColor(color: RGB): string {
  return `${ESC}[38;2;${color.r};${color.g};${color.b}m`;
}

/**
 * A single "pixel" in terminal = 2 spaces with background color
 * This creates a roughly square appearance since terminal chars are ~2:1 height:width
 */
const PIXEL_CHARS = '  ';

/**
 * Render a single pixel as a 2-character colored block
 */
export function renderPixel(pixel: Pixel): string {
  if (pixel === null) {
    return RESET + PIXEL_CHARS;
  }
  return bgColor(pixel) + PIXEL_CHARS;
}

/**
 * Render a row of pixels as a string (2 chars per pixel)
 */
export function renderPixelRow(pixels: Pixel[]): string {
  let output = '';
  let lastColor: RGB | null = null;

  for (const pixel of pixels) {
    if (pixel === null) {
      if (lastColor !== null) {
        output += RESET;
        lastColor = null;
      }
      output += PIXEL_CHARS;
    } else {
      // Optimization: only emit color code if different from last
      if (lastColor === null ||
          lastColor.r !== pixel.r ||
          lastColor.g !== pixel.g ||
          lastColor.b !== pixel.b) {
        output += bgColor(pixel);
        lastColor = pixel;
      }
      output += PIXEL_CHARS;
    }
  }

  output += RESET;
  return output;
}

/**
 * Default background color for transparent pixels in half-block mode
 */
const DEFAULT_BG: RGB = { r: 20, g: 20, b: 25 };

/**
 * Render two pixel rows as one terminal row using half-block characters
 * Each character shows 2 vertical pixels (1 char width = 1 pixel width)
 * Top pixel in foreground, bottom pixel in background
 */
export function renderHalfBlockRow(topRow: Pixel[], bottomRow: Pixel[]): string {
  let output = '';
  let lastFg: RGB | null = null;
  let lastBg: RGB | null = null;

  const len = Math.max(topRow.length, bottomRow.length);

  for (let i = 0; i < len; i++) {
    const topPixel = topRow[i] ?? null;
    const bottomPixel = bottomRow[i] ?? null;

    // Use default background for null pixels
    const fg = topPixel ?? DEFAULT_BG;
    const bg = bottomPixel ?? DEFAULT_BG;

    // Set foreground color (top pixel) if changed
    if (lastFg === null || lastFg.r !== fg.r || lastFg.g !== fg.g || lastFg.b !== fg.b) {
      output += fgColor(fg);
      lastFg = fg;
    }

    // Set background color (bottom pixel) if changed
    if (lastBg === null || lastBg.r !== bg.r || lastBg.g !== bg.g || lastBg.b !== bg.b) {
      output += bgColor(bg);
      lastBg = bg;
    }

    output += HALF_BLOCK_TOP;
  }

  output += RESET;
  return output;
}

/**
 * Render a pixel grid using half-block characters (high resolution mode)
 * Returns array of terminal rows, each representing 2 pixel rows
 */
export function renderHalfBlockGrid(grid: PixelGrid): string[] {
  const result: string[] = [];

  for (let y = 0; y < grid.length; y += 2) {
    const topRow = grid[y] ?? [];
    const bottomRow = grid[y + 1] ?? [];
    result.push(renderHalfBlockRow(topRow, bottomRow));
  }

  return result;
}

/**
 * Render a complete pixel grid as multiple lines
 */
export function renderPixelGrid(grid: PixelGrid): string[] {
  return grid.map(row => renderPixelRow(row));
}

/**
 * Render a pixel grid to a single string with newlines
 */
export function renderPixelGridString(grid: PixelGrid): string {
  return renderPixelGrid(grid).join('\n');
}

/**
 * Composite one pixel grid on top of another (for sprites on tiles)
 * Transparent pixels (null) show through to the background
 */
export function compositeGrids(
  background: PixelGrid,
  foreground: PixelGrid,
  offsetX: number = 0,
  offsetY: number = 0
): PixelGrid {
  const result: PixelGrid = background.map(row => [...row]);

  for (let y = 0; y < foreground.length; y++) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= result.length) continue;

    const fgRow = foreground[y];
    if (!fgRow) continue;

    for (let x = 0; x < fgRow.length; x++) {
      const targetX = x + offsetX;
      if (targetX < 0 || targetX >= (result[targetY]?.length ?? 0)) continue;

      const fgPixel = fgRow[x];
      if (fgPixel !== null && fgPixel !== undefined) {
        result[targetY]![targetX] = fgPixel;
      }
    }
  }

  return result;
}

/**
 * Create an empty pixel grid of given dimensions
 */
export function createEmptyGrid(width: number, height: number): PixelGrid {
  const grid: PixelGrid = [];
  for (let y = 0; y < height; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < width; x++) {
      row.push(null);
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Create a solid color grid
 */
export function createSolidGrid(width: number, height: number, color: RGB): PixelGrid {
  const grid: PixelGrid = [];
  for (let y = 0; y < height; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < width; x++) {
      row.push({ ...color });
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Extract a sub-region from a pixel grid
 */
export function extractRegion(
  grid: PixelGrid,
  x: number,
  y: number,
  width: number,
  height: number
): PixelGrid {
  const result: PixelGrid = [];
  for (let dy = 0; dy < height; dy++) {
    const sourceY = y + dy;
    const row: Pixel[] = [];
    for (let dx = 0; dx < width; dx++) {
      const sourceX = x + dx;
      if (sourceY >= 0 && sourceY < grid.length &&
          sourceX >= 0 && sourceX < (grid[sourceY]?.length ?? 0)) {
        row.push(grid[sourceY]![sourceX] ?? null);
      } else {
        row.push(null);
      }
    }
    result.push(row);
  }
  return result;
}

/**
 * Scale a pixel grid by an integer factor (upscale)
 */
export function scaleGrid(grid: PixelGrid, factor: number): PixelGrid {
  const result: PixelGrid = [];
  for (const row of grid) {
    const scaledRow: Pixel[] = [];
    for (const pixel of row) {
      for (let i = 0; i < factor; i++) {
        scaledRow.push(pixel);
      }
    }
    for (let i = 0; i < factor; i++) {
      result.push([...scaledRow]);
    }
  }
  return result;
}

/**
 * Downsample a pixel grid by a factor (zoom out)
 * Uses nearest-neighbor sampling for crisp pixel art
 * Supports non-integer scale factors
 */
export function downsampleGrid(grid: PixelGrid, factor: number): PixelGrid {
  if (factor <= 1) return grid;

  const srcHeight = grid.length;
  const srcWidth = grid[0]?.length ?? 0;
  const dstHeight = Math.floor(srcHeight / factor);
  const dstWidth = Math.floor(srcWidth / factor);

  const result: PixelGrid = [];

  for (let dy = 0; dy < dstHeight; dy++) {
    const row: Pixel[] = [];
    for (let dx = 0; dx < dstWidth; dx++) {
      // Nearest-neighbor: sample from the corresponding source position
      const srcY = Math.floor(dy * factor);
      const srcX = Math.floor(dx * factor);

      if (srcY < srcHeight && srcX < srcWidth) {
        const pixel = grid[srcY]?.[srcX];
        row.push(pixel ?? null);
      } else {
        row.push(null);
      }
    }
    result.push(row);
  }

  return result;
}
