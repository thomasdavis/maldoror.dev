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

/**
 * Braille character base (U+2800) for ultra-high-resolution rendering
 * Each Braille char is 2×4 dots = 8 subpixels per character
 * Dot positions and their bit values:
 *   1 (0x01)  4 (0x08)
 *   2 (0x02)  5 (0x10)
 *   3 (0x04)  6 (0x20)
 *   7 (0x40)  8 (0x80)
 */
const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [
  [0x01, 0x08],  // Row 0: dots 1, 4
  [0x02, 0x10],  // Row 1: dots 2, 5
  [0x04, 0x20],  // Row 2: dots 3, 6
  [0x40, 0x80],  // Row 3: dots 7, 8
];

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

// ============================================
// Cell-Level Diffing Types
// ============================================

/**
 * A terminal cell for cell-level diffing
 * Stores structured data instead of ANSI strings
 */
export interface TerminalCell {
  char: string;           // ' ', '  ', '▀', or braille char
  fgColor: RGB | null;    // Foreground color (for halfblock/braille)
  bgColor: RGB | null;    // Background color
}

/**
 * Grid of terminal cells for diffing
 */
export type CellGrid = TerminalCell[][];

/**
 * A 2D grid of brightness values for cell-level lighting
 * Each value represents brightness for a single terminal cell (0.7-1.2 typical)
 */
export type BrightnessGrid = number[][];

/**
 * Check if two colors are equal
 */
export function colorsEqual(a: RGB | null, b: RGB | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/**
 * Check if two terminal cells are equal
 */
export function cellsEqual(a: TerminalCell, b: TerminalCell | undefined): boolean {
  if (!b) return false;
  return a.char === b.char &&
         colorsEqual(a.fgColor, b.fgColor) &&
         colorsEqual(a.bgColor, b.bgColor);
}

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
 * Calculate brightness of a pixel (0-255)
 */
function pixelBrightness(pixel: Pixel): number {
  if (!pixel) return 0;
  // Perceptual luminance formula
  return Math.round(0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b);
}

/**
 * Average multiple pixels into one color
 */
function averagePixels(pixels: Pixel[]): RGB {
  const valid = pixels.filter((p): p is RGB => p !== null);
  if (valid.length === 0) return { r: 20, g: 20, b: 25 };

  const sum = valid.reduce(
    (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
    { r: 0, g: 0, b: 0 }
  );

  return {
    r: Math.round(sum.r / valid.length),
    g: Math.round(sum.g / valid.length),
    b: Math.round(sum.b / valid.length),
  };
}

/**
 * Apply brightness multiplier to an RGB color
 * Clamps result to [0, 255] range
 */
function applyBrightness(color: RGB, brightness: number): RGB {
  return {
    r: Math.min(255, Math.max(0, Math.round(color.r * brightness))),
    g: Math.min(255, Math.max(0, Math.round(color.g * brightness))),
    b: Math.min(255, Math.max(0, Math.round(color.b * brightness))),
  };
}

/**
 * Render a 2x4 pixel block as a single Braille character
 * Returns the character and the foreground/background colors to use
 * @param block - 4 rows × 2 cols of pixels
 * @param cellBrightness - Optional brightness multiplier (0.7-1.2 typical, default 1.0)
 */
function renderBrailleChar(
  block: Pixel[][],  // 4 rows × 2 cols
  cellBrightness: number = 1.0
): { char: string; fg: RGB; bg: RGB } {
  // Collect all pixels and their brightness
  const allPixels: { pixel: Pixel; brightness: number; row: number; col: number }[] = [];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      const pixel = block[row]?.[col] ?? null;
      allPixels.push({
        pixel,
        brightness: pixelBrightness(pixel),
        row,
        col,
      });
    }
  }

  // Find median brightness to threshold
  const brightnesses = allPixels.map(p => p.brightness).sort((a, b) => a - b);
  const medianBrightness = brightnesses[4] ?? 128;  // Middle of 8 values

  // Split into foreground (bright) and background (dark) pixels
  const fgPixels: Pixel[] = [];
  const bgPixels: Pixel[] = [];
  let brailleCode = 0;

  for (const p of allPixels) {
    if (p.brightness >= medianBrightness && p.pixel !== null) {
      fgPixels.push(p.pixel);
      // Set the corresponding Braille dot
      brailleCode |= BRAILLE_DOTS[p.row]![p.col]!;
    } else {
      bgPixels.push(p.pixel);
    }
  }

  // Calculate average colors for fg and bg
  let fg = averagePixels(fgPixels);
  let bg = averagePixels(bgPixels);

  // Apply cell-level brightness if not default
  if (cellBrightness !== 1.0) {
    fg = applyBrightness(fg, cellBrightness);
    bg = applyBrightness(bg, cellBrightness);
  }

  // Generate Braille character
  const char = String.fromCharCode(BRAILLE_BASE + brailleCode);

  return { char, fg, bg };
}

/**
 * Render a pixel grid using Braille characters (ultra-high resolution)
 * Each character represents 2×4 pixels = 8 subpixels
 * Returns array of terminal rows, each representing 4 pixel rows
 */
export function renderBrailleGrid(grid: PixelGrid): string[] {
  const result: string[] = [];
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  // Process 4 rows at a time (Braille is 2×4)
  for (let y = 0; y < height; y += 4) {
    let line = '';
    let lastFg: RGB | null = null;
    let lastBg: RGB | null = null;

    // Process 2 columns at a time
    for (let x = 0; x < width; x += 2) {
      // Extract 2×4 block
      const block: Pixel[][] = [];
      for (let dy = 0; dy < 4; dy++) {
        const row: Pixel[] = [];
        for (let dx = 0; dx < 2; dx++) {
          row.push(grid[y + dy]?.[x + dx] ?? null);
        }
        block.push(row);
      }

      const { char, fg, bg } = renderBrailleChar(block);

      // Emit color codes if changed
      if (!lastFg || lastFg.r !== fg.r || lastFg.g !== fg.g || lastFg.b !== fg.b) {
        line += fgColor(fg);
        lastFg = fg;
      }
      if (!lastBg || lastBg.r !== bg.r || lastBg.g !== bg.g || lastBg.b !== bg.b) {
        line += bgColor(bg);
        lastBg = bg;
      }

      line += char;
    }

    line += RESET;
    result.push(line);
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
 * Quantize a color to reduce bit depth
 * bits=4 means 16 levels per channel instead of 256
 * This improves ANSI color code deduplication
 */
export function quantizeColor(color: RGB, bits: number): RGB {
  if (bits >= 8) return color;
  const shift = 8 - bits;
  const mask = (0xFF << shift) & 0xFF;
  return {
    r: color.r & mask,
    g: color.g & mask,
    b: color.b & mask,
  };
}

/**
 * Bayer 4x4 ordered dithering matrix
 * Normalized to [-0.5, 0.5] range for threshold modification
 */
const BAYER_4X4: number[][] = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
].map(row => row.map(v => (v / 16) - 0.5));

/**
 * Quantize a color with ordered dithering
 * Uses Bayer 4x4 matrix to add structured noise before quantization
 * This reduces visible banding in gradients
 */
export function quantizeColorDithered(color: RGB, bits: number, x: number, y: number): RGB {
  if (bits >= 8) return color;

  const dither = BAYER_4X4[y & 3]![x & 3]! * (256 >> bits);
  const shift = 8 - bits;
  const mask = (0xFF << shift) & 0xFF;

  return {
    r: Math.max(0, Math.min(255, Math.round(color.r + dither))) & mask,
    g: Math.max(0, Math.min(255, Math.round(color.g + dither))) & mask,
    b: Math.max(0, Math.min(255, Math.round(color.b + dither))) & mask,
  };
}

/**
 * Quantize all colors in a pixel grid
 * Reduces unique colors for better ANSI deduplication
 */
export function quantizeGrid(grid: PixelGrid, bits: number): PixelGrid {
  if (bits >= 8) return grid;
  return grid.map(row =>
    row.map(pixel => pixel === null ? null : quantizeColor(pixel, bits))
  );
}

/**
 * Quantize all colors in a pixel grid with ordered dithering
 * Uses Bayer matrix to reduce banding in gradients
 */
export function quantizeGridDithered(grid: PixelGrid, bits: number): PixelGrid {
  if (bits >= 8) return grid;
  return grid.map((row, y) =>
    row.map((pixel, x) => pixel === null ? null : quantizeColorDithered(pixel, bits, x, y))
  );
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

// ============================================
// Cell Grid Render Functions (for cell-level diffing)
// ============================================

/**
 * Render a pixel grid to a cell grid using normal mode (2 chars per pixel)
 * Each pixel becomes a cell with 2 spaces and a background color
 */
export function renderNormalGridCells(grid: PixelGrid): CellGrid {
  const result: CellGrid = [];

  for (const row of grid) {
    const cellRow: TerminalCell[] = [];
    for (const pixel of row) {
      cellRow.push({
        char: PIXEL_CHARS,
        fgColor: null,
        bgColor: pixel ?? DEFAULT_BG,
      });
    }
    result.push(cellRow);
  }

  return result;
}

/**
 * Render a pixel grid to a cell grid using half-block mode
 * Each cell represents 2 vertical pixels (1 char width)
 * @param grid - The pixel grid to render
 * @param brightnessGrid - Optional grid of brightness values per cell (indexed by cell x,y)
 */
export function renderHalfBlockGridCells(grid: PixelGrid, brightnessGrid?: BrightnessGrid): CellGrid {
  const result: CellGrid = [];

  let cellY = 0;
  for (let y = 0; y < grid.length; y += 2) {
    const topRow = grid[y] ?? [];
    const bottomRow = grid[y + 1] ?? [];
    const cellRow: TerminalCell[] = [];

    const len = Math.max(topRow.length, bottomRow.length);
    for (let i = 0; i < len; i++) {
      const topPixel = topRow[i] ?? null;
      const bottomPixel = bottomRow[i] ?? null;

      // Get cell brightness from grid if provided
      const cellBrightness = brightnessGrid?.[cellY]?.[i] ?? 1.0;

      let fgColor = topPixel ?? DEFAULT_BG;
      let bgColor = bottomPixel ?? DEFAULT_BG;

      // Apply brightness if not default
      if (cellBrightness !== 1.0) {
        fgColor = applyBrightness(fgColor, cellBrightness);
        bgColor = applyBrightness(bgColor, cellBrightness);
      }

      cellRow.push({
        char: HALF_BLOCK_TOP,
        fgColor,
        bgColor,
      });
    }
    result.push(cellRow);
    cellY++;
  }

  return result;
}

/**
 * Render a pixel grid to a cell grid using braille mode
 * Each cell represents 2×4 pixels (8 subpixels per character)
 * @param grid - The pixel grid to render
 * @param brightnessGrid - Optional grid of brightness values per cell (indexed by cell x,y)
 */
export function renderBrailleGridCells(grid: PixelGrid, brightnessGrid?: BrightnessGrid): CellGrid {
  const result: CellGrid = [];
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  let cellY = 0;
  // Process 4 rows at a time (Braille is 2×4)
  for (let y = 0; y < height; y += 4) {
    const cellRow: TerminalCell[] = [];

    let cellX = 0;
    // Process 2 columns at a time
    for (let x = 0; x < width; x += 2) {
      // Extract 2×4 block
      const block: Pixel[][] = [];
      for (let dy = 0; dy < 4; dy++) {
        const row: Pixel[] = [];
        for (let dx = 0; dx < 2; dx++) {
          row.push(grid[y + dy]?.[x + dx] ?? null);
        }
        block.push(row);
      }

      // Get cell brightness from grid if provided
      const cellBrightness = brightnessGrid?.[cellY]?.[cellX] ?? 1.0;

      const { char, fg, bg } = renderBrailleChar(block, cellBrightness);
      cellRow.push({
        char,
        fgColor: fg,
        bgColor: bg,
      });
      cellX++;
    }

    result.push(cellRow);
    cellY++;
  }

  return result;
}

// ============================================
// CRLE (Chromatic Run-Length Encoding) Renderer
// ============================================

/**
 * Color key for grouping cells by color
 */
function colorKey(fg: RGB | null, bg: RGB | null): string {
  const fgStr = fg ? `${fg.r},${fg.g},${fg.b}` : 'null';
  const bgStr = bg ? `${bg.r},${bg.g},${bg.b}` : 'null';
  return `${fgStr}|${bgStr}`;
}

/**
 * Cell position for CRLE rendering
 */
interface CRLECell {
  x: number;
  y: number;
  char: string;
}

/**
 * Color group for CRLE rendering
 */
interface CRLEColorGroup {
  fgColor: RGB | null;
  bgColor: RGB | null;
  cells: CRLECell[];
}

/**
 * CRLE render result with stats
 */
export interface CRLERenderResult {
  output: string;
  colorGroups: number;
  bytesWithoutCRLE: number;
  bytesWithCRLE: number;
}

/**
 * Render changed cells using CRLE (Chromatic Run-Length Encoding)
 *
 * Instead of rendering left-to-right with frequent color changes,
 * group cells by color and render all cells of each color together.
 * This reduces ANSI escape code overhead significantly.
 *
 * @param cells - Current frame's cell grid
 * @param previousCells - Previous frame's cell grid for diffing
 * @param headerRows - Number of header rows to offset terminal positions
 * @param renderMode - 'normal' uses 2-char cells, others use 1-char
 * @returns CRLE render result with output string and stats
 */
export function renderCRLE(
  cells: CellGrid,
  previousCells: CellGrid,
  headerRows: number,
  renderMode: 'normal' | 'halfblock' | 'braille' = 'halfblock'
): CRLERenderResult {
  // Group changed cells by color
  const colorGroups = new Map<string, CRLEColorGroup>();
  let totalChangedCells = 0;

  for (let y = 0; y < cells.length; y++) {
    const row = cells[y];
    const prevRow = previousCells[y];
    if (!row) continue;

    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      const prevCell = prevRow?.[x];

      // Skip unchanged cells
      if (!cell || cellsEqual(cell, prevCell)) continue;

      totalChangedCells++;
      const key = colorKey(cell.fgColor, cell.bgColor);

      let group = colorGroups.get(key);
      if (!group) {
        group = {
          fgColor: cell.fgColor,
          bgColor: cell.bgColor,
          cells: [],
        };
        colorGroups.set(key, group);
      }

      group.cells.push({ x, y, char: cell.char });
    }
  }

  // If nothing changed, return empty
  if (colorGroups.size === 0) {
    return {
      output: '',
      colorGroups: 0,
      bytesWithoutCRLE: 0,
      bytesWithCRLE: 0,
    };
  }

  // Build CRLE output: set color once, then emit all positions for that color
  const chunks: string[] = [];

  // Sort groups by cell count (render larger groups first for better perceived performance)
  const sortedGroups = Array.from(colorGroups.values()).sort(
    (a, b) => b.cells.length - a.cells.length
  );

  for (const group of sortedGroups) {
    // Set colors once for this group
    if (group.fgColor) {
      chunks.push(fgColor(group.fgColor));
    }
    if (group.bgColor) {
      chunks.push(bgColor(group.bgColor));
    }

    // Sort cells by position for optimal cursor movement
    // Prioritize cells that can use relative movement
    group.cells.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });

    let lastX = -2;
    let lastY = -1;

    for (const cell of group.cells) {
      // Calculate terminal position
      const termCol = renderMode === 'normal' ? cell.x * 2 + 1 : cell.x + 1;
      const termRow = cell.y + headerRows + 1;

      // Use relative movement if possible (cursor right), otherwise absolute
      if (lastY === cell.y && lastX === cell.x - 1) {
        // Contiguous - no cursor movement needed
      } else if (lastY === cell.y && cell.x > lastX && cell.x - lastX <= 3) {
        // Same row, small gap - use cursor forward (shorter than absolute)
        const spaces = renderMode === 'normal' ? (cell.x - lastX - 1) * 2 : cell.x - lastX - 1;
        if (spaces > 0) {
          chunks.push(`${ESC}[${spaces}C`);
        }
      } else {
        // Jump to absolute position
        chunks.push(`${ESC}[${termRow};${termCol}H`);
      }

      chunks.push(cell.char);
      lastX = cell.x;
      lastY = cell.y;
    }
  }

  chunks.push(`${ESC}[0m`);  // Reset at end

  const output = chunks.join('');

  // Calculate comparison bytes (what traditional rendering would use)
  // Traditional: for each cell, potentially emit fg + bg + position + char
  // Estimate ~25 bytes per cell with color changes
  const bytesWithoutCRLE = totalChangedCells * 25;
  const bytesWithCRLE = Buffer.byteLength(output, 'utf8');

  return {
    output,
    colorGroups: colorGroups.size,
    bytesWithoutCRLE,
    bytesWithCRLE,
  };
}
