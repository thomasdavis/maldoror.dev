import type { Duplex } from 'stream';
import type { WorldDataProvider } from '@maldoror/protocol';
import { ViewportRenderer, type ViewportConfig, type TextOverlay, type CameraMode, type CameraRotation } from './viewport-renderer.js';
import type { Direction } from '@maldoror/protocol';
import {
  renderPixelRow,
  renderHalfBlockGrid,
  renderBrailleGrid,
  quantizeGrid,
  renderNormalGridCells,
  renderHalfBlockGridCells,
  renderBrailleGridCells,
  cellsEqual,
  colorsEqual,
  fgColor,
  bgColor,
  type CellGrid,
} from './pixel-renderer.js';
import { BG_PRIMARY, BG_TERTIARY, fg, bg, ACCENT_CYAN, ACCENT_GOLD, TEXT_SECONDARY, BORDER_DIM, RESET } from '../brand.js';

// Re-export for convenience
export type { CameraMode } from './viewport-renderer.js';

const ESC = '\x1b';

// Build version - set dynamically by server from version.json
let BUILD_VERSION = 'vdev';

/**
 * Set the build version to display in stats bar
 * Called by server at startup with version from version.json
 */
export function setBuildVersion(version: string): void {
  BUILD_VERSION = version;
}

/**
 * Get the current build version
 */
export function getBuildVersion(): string {
  return BUILD_VERSION;
}

/**
 * Layout configuration for the game screen
 * Defines reserved space for UI elements around the viewport
 */
export interface LayoutConfig {
  headerRows: number;      // Rows reserved at top (default: 2 for stats bar)
  footerRows: number;      // Rows reserved at bottom (default: 0)
  leftSidebarCols: number; // Cols reserved on left (default: 0)
  rightSidebarCols: number; // Cols reserved on right (default: 0)
}

// Default layout with just the header
const DEFAULT_LAYOUT: LayoutConfig = {
  headerRows: 2,       // Stats bar + separator
  footerRows: 0,       // No footer by default
  leftSidebarCols: 0,  // No left sidebar
  rightSidebarCols: 0, // No right sidebar
};

/**
 * Render mode options
 * - 'normal': 2 chars per pixel width, 1 row per pixel height
 * - 'halfblock': 1 char per pixel width, 2 pixels per row (using ▀)
 * - 'braille': 2 pixels per char width, 4 pixels per row (using Braille dots) - HIGHEST RES
 */
export type RenderMode = 'normal' | 'halfblock' | 'braille';

/**
 * Configuration for PixelGameRenderer
 */
export interface PixelGameRendererConfig {
  stream: Duplex;
  cols: number;
  rows: number;
  username?: string;
  zoomLevel?: number;  // Zoom percentage: 100 = full resolution, 50 = half resolution (sees more world)
  renderMode?: RenderMode;  // Rendering mode (default: 'braille' for max resolution)
  layout?: Partial<LayoutConfig>;  // Optional layout configuration (reserves space for UI elements)
}

/**
 * Adapter to provide world data to the ViewportRenderer
 */
export interface GameWorldAdapter extends WorldDataProvider {}

/**
 * PixelGameRenderer - Renders the pixel-based game world to terminal
 *
 * Uses ViewportRenderer for the actual rendering, handles:
 * - Terminal initialization (alternate screen, cursor hiding)
 * - Frame timing
 * - Stream output
 */
export class PixelGameRenderer {
  private stream: Duplex;
  private cols: number;
  private rows: number;
  private viewportRenderer: ViewportRenderer;
  private tickCount: number = 0;
  private forceRedraw: boolean = true;
  private previousOutput: string[] = [];
  private initialized: boolean = false;
  // Performance: Track previous overlay count to only force redraw when overlays change
  private previousOverlayCount: number = 0;
  private username: string;
  private playerX: number = 0;
  private playerY: number = 0;
  private zoomLevel: number;  // 100 = full resolution, 50 = half (zoomed out), etc.
  private renderMode: RenderMode;
  // Layout configuration (reserves space for UI elements around viewport)
  private layout: LayoutConfig;
  // FPS tracking
  private frameCount: number = 0;
  private fps: number = 0;
  private lastFpsUpdate: number = Date.now();
  private lastRenderTime: number = 0;
  private lastFrameBytes: number = 0;
  // Frame skip tracking - skip rendering when nothing changed
  private previousCameraX: number = -1;
  private previousCameraY: number = -1;
  private framesSkipped: number = 0;
  // Cell-level diffing - store previous frame as cell grid
  private previousCells: CellGrid = [];
  // Stats bar caching (1Hz update to reduce string formatting overhead)
  private statsBarCache: string = '';
  private statsBarLastRender: number = 0;
  private readonly STATS_BAR_TTL_MS = 1000;  // 1Hz update

  constructor(config: PixelGameRendererConfig) {
    this.stream = config.stream;
    this.cols = config.cols;
    this.rows = config.rows;
    this.username = config.username ?? 'Unknown';
    this.renderMode = config.renderMode ?? 'halfblock';  // Default to halfblock for good balance
    this.zoomLevel = config.zoomLevel ?? 100;  // Default to 100% zoom (most zoomed in)
    this.layout = { ...DEFAULT_LAYOUT, ...config.layout };  // Merge with defaults

    // Calculate viewport size based on terminal size minus layout reservations
    const { availableCols, availableRows } = this.getViewportArea();
    const currentTileSize = this.getCurrentTileSize();
    const { widthTiles, heightTiles } = this.calculateViewportTiles(availableCols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(availableCols, availableRows);

    const viewportConfig: ViewportConfig = {
      widthTiles: Math.max(1, widthTiles),
      heightTiles: Math.max(1, heightTiles),
      pixelWidth,  // Actual pixel dimensions to fill entire screen
      pixelHeight,
      tileRenderSize: currentTileSize,
    };

    this.viewportRenderer = new ViewportRenderer(viewportConfig);
  }

  /**
   * Get the available viewport area after subtracting layout reservations
   */
  private getViewportArea(): { availableCols: number; availableRows: number } {
    const availableCols = this.cols - this.layout.leftSidebarCols - this.layout.rightSidebarCols;
    const availableRows = this.rows - this.layout.headerRows - this.layout.footerRows;
    return {
      availableCols: Math.max(1, availableCols),
      availableRows: Math.max(1, availableRows),
    };
  }

  /**
   * Get the starting position for the viewport (accounting for header and left sidebar)
   * Note: Used when rendering sidebar/footer layouts
   */
  getViewportOrigin(): { startCol: number; startRow: number } {
    return {
      startCol: this.layout.leftSidebarCols + 1,  // 1-based terminal columns
      startRow: this.layout.headerRows + 1,        // 1-based terminal rows
    };
  }

  /**
   * Get the current tile SCREEN render size based on zoom level
   * This determines how big tiles appear on screen (in pixels)
   * At 0% zoom: small tiles (see lots of world) = 4px per tile
   * At 100% zoom: large tiles that fill viewport height (see full character detail)
   *
   * Uses exponential scaling so each zoom step feels perceptually even
   */
  private getCurrentTileSize(): number {
    const MIN_TILE_SIZE = 4;   // At 0% zoom, tiles are 4 pixels on screen

    // Calculate max tile size to fill viewport height (so character is fully visible at 100%)
    const { availableRows } = this.getViewportArea();
    let maxTileSize: number;
    switch (this.renderMode) {
      case 'braille':
        maxTileSize = availableRows * 4;  // 4 pixels per row in braille
        break;
      case 'halfblock':
        maxTileSize = availableRows * 2;  // 2 pixels per row in halfblock
        break;
      case 'normal':
      default:
        maxTileSize = availableRows;      // 1 pixel per row in normal
        break;
    }

    // Exponential interpolation for perceptually even zoom steps
    // Each 10% step multiplies tile size by constant factor
    // Formula: min * (max/min)^(zoom/100)
    const ratio = maxTileSize / MIN_TILE_SIZE;
    const exponent = this.zoomLevel / 100;
    return Math.round(MIN_TILE_SIZE * Math.pow(ratio, exponent));
  }

  /**
   * Calculate actual pixel dimensions available for rendering based on render mode
   */
  private calculatePixelDimensions(cols: number, availableRows: number): { pixelWidth: number; pixelHeight: number } {
    switch (this.renderMode) {
      case 'braille':
        // Braille: 1 char = 2 pixels wide, 1 row = 4 pixels tall
        return { pixelWidth: cols * 2, pixelHeight: availableRows * 4 };
      case 'halfblock':
        // Half-block: 1 char = 1 pixel wide, 1 row = 2 pixels tall
        return { pixelWidth: cols, pixelHeight: availableRows * 2 };
      case 'normal':
      default:
        // Normal: 2 chars = 1 pixel wide, 1 row = 1 pixel tall
        return { pixelWidth: Math.floor(cols / 2), pixelHeight: availableRows };
    }
  }

  /**
   * Calculate viewport size in tiles based on render mode and current tile size
   * At higher zoom levels, tiles are bigger so fewer fit on screen
   */
  private calculateViewportTiles(cols: number, availableRows: number): { widthTiles: number; heightTiles: number } {
    const tileSize = this.getCurrentTileSize();
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(cols, availableRows);

    return {
      widthTiles: Math.floor(pixelWidth / tileSize),
      heightTiles: Math.floor(pixelHeight / tileSize),
    };
  }

  /**
   * Initialize terminal (alternate screen, hide cursor)
   * IMPORTANT: Always uses brand dark background - no system theme override
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Brand dark background - ALWAYS enforced
    const brandBg = bg(BG_PRIMARY);

    const init = [
      `${ESC}[?1049h`,      // Enter alternate screen
      `${ESC}[?25l`,         // Hide cursor
      `${ESC}[?7l`,          // Disable line wrap
      brandBg,               // Set brand dark background
      `${ESC}[2J`,           // Clear screen (with dark bg)
      `${ESC}[H`,            // Move to home
    ].join('');

    this.stream.write(init);

    // Fill entire screen with brand background to prevent any light bleed
    this.fillScreenBackground();
    this.forceRedraw = true;
  }

  /**
   * Fill entire screen with brand dark background
   * Prevents any system theme from bleeding through
   */
  private fillScreenBackground(): void {
    const brandBg = bg(BG_PRIMARY);
    for (let row = 1; row <= this.rows; row++) {
      this.stream.write(`${ESC}[${row};1H${brandBg}${' '.repeat(this.cols)}`);
    }
  }

  /**
   * Cleanup terminal state
   */
  cleanup(): void {
    if (!this.initialized) return;

    const cleanup = [
      `${ESC}[?1049l`,      // Exit alternate screen
      `${ESC}[?25h`,        // Show cursor
      `${ESC}[?7h`,         // Enable line wrap
      `${ESC}[0m`,          // Reset attributes
    ].join('');

    this.stream.write(cleanup);
    this.initialized = false;
  }

  /**
   * Handle terminal resize
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;

    const { availableCols, availableRows } = this.getViewportArea();
    const { widthTiles, heightTiles } = this.calculateViewportTiles(availableCols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(availableCols, availableRows);

    this.viewportRenderer.resize(
      Math.max(1, widthTiles),
      Math.max(1, heightTiles)
    );
    this.viewportRenderer.setPixelDimensions(pixelWidth, pixelHeight);

    // Re-center camera after resize
    this.viewportRenderer.setCamera(this.playerX, this.playerY);

    this.forceRedraw = true;
    this.previousOutput = [];
    this.invalidateStatsBar();
  }

  /**
   * Set camera position (center on player)
   */
  setCamera(tileX: number, tileY: number): void {
    this.playerX = tileX;
    this.playerY = tileY;
    this.viewportRenderer.setCamera(tileX, tileY);
  }

  /**
   * Set username for stats display
   */
  setUsername(username: string): void {
    this.username = username;
  }

  /**
   * Render a frame
   */
  render(world: WorldDataProvider): void {
    const renderStart = Date.now();
    this.tickCount++;

    // Update FPS tracking
    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }

    // Check if camera (player position) has changed
    const cameraChanged = this.playerX !== this.previousCameraX ||
                          this.playerY !== this.previousCameraY;
    this.previousCameraX = this.playerX;
    this.previousCameraY = this.playerY;

    // Skip expensive rendering if nothing changed
    if (!cameraChanged && !this.forceRedraw && this.previousCells.length > 0) {
      this.framesSkipped++;
      // Just update the stats bar (first line) to show we're still alive
      const statsBar = this.renderStatsBar();
      const output = `${ESC}[1;1H${statsBar}${ESC}[0m`;
      this.lastFrameBytes = Buffer.byteLength(output, 'utf8');
      this.stream.write(output);
      this.lastRenderTime = Date.now() - renderStart;
      return;
    }

    // Reset skipped counter on actual render
    this.framesSkipped = 0;

    // Generate stats bar
    const statsBar = this.renderStatsBar();

    // Render viewport to raw pixel buffer with overlays (already at correct resolution)
    const { buffer, overlays } = this.viewportRenderer.renderToBuffer(world, this.tickCount);

    // Apply color quantization at high zoom levels to reduce ANSI codes
    // At zoom > 50%, use 5-bit color (32 levels per channel)
    // At zoom > 70%, use 4-bit color (16 levels per channel)
    let quantizedBuffer = buffer;
    if (this.zoomLevel > 70) {
      quantizedBuffer = quantizeGrid(buffer, 4);
    } else if (this.zoomLevel > 50) {
      quantizedBuffer = quantizeGrid(buffer, 5);
    }

    // Convert to cell grid for cell-level diffing
    let viewportCells: CellGrid;
    switch (this.renderMode) {
      case 'braille':
        viewportCells = renderBrailleGridCells(quantizedBuffer);
        break;
      case 'halfblock':
        viewportCells = renderHalfBlockGridCells(quantizedBuffer);
        break;
      case 'normal':
      default:
        viewportCells = renderNormalGridCells(quantizedBuffer);
        break;
    }

    // Output using cell-level diffing for minimal bandwidth
    this.outputFrameCellDiff(statsBar, viewportCells, overlays);

    // Track render time for next frame's display
    this.lastRenderTime = Date.now() - renderStart;
  }

  /**
   * Convert pixel position to terminal position based on render mode
   */
  private pixelToTerminal(pixelX: number, pixelY: number): { row: number; col: number } {
    let row: number;
    let col: number;

    switch (this.renderMode) {
      case 'braille':
        // Braille: 4 pixels per row, 2 pixels per char
        row = Math.floor(pixelY / 4);
        col = Math.floor(pixelX / 2);
        break;
      case 'halfblock':
        // Half-block: 2 pixels per row, 1 pixel per char
        row = Math.floor(pixelY / 2);
        col = pixelX;
        break;
      case 'normal':
      default:
        // Normal: 1 pixel per row, 2 chars per pixel
        row = pixelY;
        col = pixelX * 2;
        break;
    }

    return { row, col };
  }

  /**
   * Pad a line to fill the screen width
   */
  private padLine(line: string): string {
    // The line already has ANSI codes. We need to add padding spaces
    // to reach the full column width
    const tileSize = this.getCurrentTileSize();
    const availableRows = this.rows - this.layout.headerRows;
    const { widthTiles } = this.calculateViewportTiles(this.cols, availableRows);

    // Calculate viewport pixel width and convert to terminal chars
    const viewportPixelWidth = widthTiles * tileSize;
    let viewportCharWidth: number;

    switch (this.renderMode) {
      case 'braille':
        // Braille: 1 char = 2 pixels
        viewportCharWidth = Math.floor(viewportPixelWidth / 2);
        break;
      case 'halfblock':
        // Half-block: 1 char = 1 pixel
        viewportCharWidth = viewportPixelWidth;
        break;
      case 'normal':
      default:
        // Normal: 2 chars = 1 pixel
        viewportCharWidth = viewportPixelWidth * 2;
        break;
    }

    const paddingNeeded = this.cols - viewportCharWidth;

    if (paddingNeeded > 0) {
      return line + bg(BG_PRIMARY) + ' '.repeat(paddingNeeded) + RESET;
    }
    return line;
  }

  /**
   * Create a full-width padding line with brand background
   */
  private createPaddingLine(): string {
    return bg(BG_PRIMARY) + ' '.repeat(this.cols) + RESET;
  }

  /**
   * Render the stats bar with 1Hz caching to reduce string formatting overhead
   * Returns cached value if less than 1000ms has passed
   */
  private renderStatsBar(): string {
    const now = Date.now();
    if (now - this.statsBarLastRender < this.STATS_BAR_TTL_MS && this.statsBarCache) {
      return this.statsBarCache;
    }
    this.statsBarLastRender = now;
    this.statsBarCache = this.buildStatsBar();
    return this.statsBarCache;
  }

  /**
   * Invalidate stats bar cache (call on resize, zoom change, mode change)
   */
  invalidateStatsBar(): void {
    this.statsBarLastRender = 0;
  }

  /**
   * Build the stats bar showing username, coordinates, zoom, render mode, camera mode, rotation, and debug info
   * Returns 2 lines: main header bar + separator line
   * Uses brand colors - always dark
   */
  private buildStatsBar(): string {
    const tileSize = this.getCurrentTileSize();
    const { availableCols, availableRows } = this.getViewportArea();
    const { widthTiles, heightTiles } = this.calculateViewportTiles(availableCols, availableRows);

    // Brand colors - always dark, high contrast
    const bgHeader = bg(BG_TERTIARY);
    const bgSep = `${ESC}[48;2;35;30;45m`;     // Slightly lighter separator
    const fgName = fg(ACCENT_CYAN);
    const fgLabel = fg(TEXT_SECONDARY);
    const fgValue = fg(ACCENT_GOLD);
    const fgCoord = `${ESC}[38;2;160;180;200m`; // Blue-gray for coordinates
    const fgSep = fg(BORDER_DIM);
    const reset = RESET;

    // Build header content with generous padding
    const fgVersion = `${ESC}[38;2;100;100;120m`; // Dim gray for version
    const leftSection = `  ${fgName}${this.username} ${fgVersion}${BUILD_VERSION}${fgLabel}`;

    // Mode info
    const modeStr = this.renderMode === 'braille' ? 'BRAILLE' :
                    this.renderMode === 'halfblock' ? 'HALF' : 'NORMAL';
    const cameraMode = this.viewportRenderer.getCameraMode();
    const cameraRotation = this.viewportRenderer.getCameraRotation();
    const camStr = cameraMode === 'free' ? '  FREE CAM' : '';
    const rotStr = cameraRotation !== 0 ? `  ROT ${cameraRotation}°` : '';

    // Performance info
    const bytesStr = this.lastFrameBytes >= 1024
      ? `${(this.lastFrameBytes / 1024).toFixed(0)}KB`
      : `${this.lastFrameBytes}B`;
    const skipStr = this.framesSkipped > 0 ? `  skip:${this.framesSkipped}` : '';

    // Center content with clear sections
    const centerSection = `${fgLabel}Mode: ${fgValue}${modeStr}${fgLabel}  Zoom: ${fgValue}${this.zoomLevel}%${fgValue}${rotStr}${camStr}`;

    // Right content
    const rightSection = `${fgLabel}Pos: ${fgCoord}(${this.playerX}, ${this.playerY})  `;

    // Debug info (only shown if there's space)
    const debugStr = `${fgLabel}${this.fps}fps ${this.lastRenderTime}ms ${bytesStr}${skipStr}  ${tileSize}px ${widthTiles}×${heightTiles}`;

    // Calculate spacing
    const leftLen = this.stripAnsi(leftSection).length;
    const centerLen = this.stripAnsi(centerSection).length;
    const rightLen = this.stripAnsi(rightSection).length;
    const debugLen = this.stripAnsi(debugStr).length;

    // Try to fit debug info, otherwise skip it
    const availableCenter = this.cols - leftLen - rightLen;
    const showDebug = availableCenter >= centerLen + debugLen + 4;

    const actualCenter = showDebug ? `${centerSection}  ${debugStr}` : centerSection;
    const actualCenterLen = showDebug ? centerLen + debugLen + 2 : centerLen;

    const leftPad = Math.max(2, Math.floor((this.cols - actualCenterLen) / 2) - leftLen);
    const rightPad = Math.max(2, this.cols - leftLen - leftPad - actualCenterLen - rightLen);

    // Line 1: Main header bar
    const line1 = `${bgHeader}${leftSection}${' '.repeat(leftPad)}${actualCenter}${' '.repeat(rightPad)}${rightSection}${reset}`;

    // Line 2: Subtle separator line
    const sepChar = '─';
    const line2 = `${bgSep}${fgSep}${sepChar.repeat(this.cols)}${reset}`;

    return `${line1}\n${ESC}[2;1H${line2}`;
  }

  /**
   * Strip ANSI codes from string for length calculation
   */
  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Output frame using cell-level diffing for minimal bandwidth
   * Only emits ANSI codes for cells that changed since last frame
   * OPTIMIZED: Uses array chunks and reference swap instead of deep copy
   */
  private outputFrameCellDiff(
    statsBar: string,
    viewportCells: CellGrid,
    overlays: TextOverlay[] = []
  ): void {
    const chunks: string[] = [];

    // Performance: Only force full redraw when overlay count changes or dimensions change
    const overlayCountChanged = overlays.length !== this.previousOverlayCount;
    this.previousOverlayCount = overlays.length;

    const needsFullRedraw = this.forceRedraw ||
      this.previousCells.length !== viewportCells.length ||
      overlayCountChanged;

    // Always write stats bar (it changes every frame with FPS/bytes counter)
    chunks.push(`${ESC}[1;1H${statsBar}${ESC}[0m`);

    if (needsFullRedraw) {
      // Full redraw - write all cells
      chunks.push(this.renderAllCells(viewportCells));
      this.forceRedraw = false;
    } else {
      // Cell-level diff - only write changed cells
      chunks.push(this.renderChangedCells(viewportCells));
    }

    // Render text overlays (usernames above players)
    for (const overlay of overlays) {
      const { row, col } = this.pixelToTerminal(overlay.pixelX, overlay.pixelY);
      const terminalRow = row + this.layout.headerRows + 1;

      if (terminalRow < 1 || terminalRow > this.rows) continue;

      const textLen = overlay.text.length + 2;
      const startCol = Math.max(1, col - Math.floor(textLen / 2) + 1);

      const overlayBg = `${ESC}[48;2;${overlay.bgColor.r};${overlay.bgColor.g};${overlay.bgColor.b}m`;
      const overlayFg = `${ESC}[38;2;${overlay.fgColor.r};${overlay.fgColor.g};${overlay.fgColor.b}m`;

      chunks.push(`${ESC}[${terminalRow};${startCol}H${overlayBg}${overlayFg} ${overlay.text} ${ESC}[0m`);
    }

    const output = chunks.join('');
    if (output) {
      this.lastFrameBytes = Buffer.byteLength(output, 'utf8');
      this.stream.write(output);
    }

    // OPTIMIZED: Swap reference instead of deep copy
    // The viewportCells is freshly created each frame, so we can take ownership
    this.previousCells = viewportCells;
  }

  /**
   * Render all cells (for full redraw)
   * OPTIMIZED: Uses array.push + join instead of string concatenation
   */
  private renderAllCells(cells: CellGrid): string {
    const chunks: string[] = [];
    let lastFg: { r: number; g: number; b: number } | null = null;
    let lastBg: { r: number; g: number; b: number } | null = null;

    for (let y = 0; y < cells.length; y++) {
      const row = cells[y];
      if (!row) continue;

      // Move to start of viewport row (after stats bar)
      chunks.push(`${ESC}[${y + this.layout.headerRows + 1};1H`);

      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (!cell) continue;

        // Emit foreground color if changed
        if (cell.fgColor && (!lastFg || !colorsEqual(cell.fgColor, lastFg))) {
          chunks.push(fgColor(cell.fgColor));
          lastFg = cell.fgColor;
        }

        // Emit background color if changed
        if (cell.bgColor && (!lastBg || !colorsEqual(cell.bgColor, lastBg))) {
          chunks.push(bgColor(cell.bgColor));
          lastBg = cell.bgColor;
        }

        chunks.push(cell.char);
      }
    }

    chunks.push(`${ESC}[0m`);
    return chunks.join('');
  }

  /**
   * Render only changed cells (for incremental update)
   * OPTIMIZED: Uses array.push + join instead of string concatenation
   */
  private renderChangedCells(cells: CellGrid): string {
    const chunks: string[] = [];
    let lastX = -2;
    let lastY = -1;
    let lastFg: { r: number; g: number; b: number } | null = null;
    let lastBg: { r: number; g: number; b: number } | null = null;

    for (let y = 0; y < cells.length; y++) {
      const row = cells[y];
      const prevRow = this.previousCells[y];
      if (!row) continue;

      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        const prevCell = prevRow?.[x];

        if (!cell || cellsEqual(cell, prevCell)) continue;

        // Move cursor only if not contiguous with last cell
        if (lastY !== y || lastX !== x - 1) {
          // Account for multi-char cells in normal mode
          const termCol = this.renderMode === 'normal' ? x * 2 + 1 : x + 1;
          chunks.push(`${ESC}[${y + this.layout.headerRows + 1};${termCol}H`);
        }

        // Emit foreground color if changed
        if (cell.fgColor && (!lastFg || !colorsEqual(cell.fgColor, lastFg))) {
          chunks.push(fgColor(cell.fgColor));
          lastFg = cell.fgColor;
        }

        // Emit background color if changed
        if (cell.bgColor && (!lastBg || !colorsEqual(cell.bgColor, lastBg))) {
          chunks.push(bgColor(cell.bgColor));
          lastBg = cell.bgColor;
        }

        chunks.push(cell.char);
        lastX = x;
        lastY = y;
      }
    }

    if (chunks.length > 0) {
      chunks.push(`${ESC}[0m`);
    }
    return chunks.join('');
  }

  /**
   * Get current tick count
   */
  getTick(): number {
    return this.tickCount;
  }

  /**
   * Force full redraw on next render
   */
  invalidate(): void {
    this.forceRedraw = true;
    this.previousOutput = [];
    this.previousCells = [];
    this.invalidateStatsBar();
  }

  /**
   * Get terminal dimensions
   */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /**
   * Get viewport dimensions in tiles
   */
  getViewportTiles(): { widthTiles: number; heightTiles: number } {
    const availableRows = this.rows - this.layout.headerRows;
    return this.calculateViewportTiles(this.cols, availableRows);
  }

  /**
   * Get current zoom level (percentage)
   */
  getZoomLevel(): number {
    return this.zoomLevel;
  }

  /**
   * Set zoom level and recalculate viewport
   * @param level Zoom percentage (0-100). 0 = base view (sprite = 1 tile), 100 = max zoom (256px tiles)
   */
  setZoomLevel(level: number): void {
    // Clamp between 0% and 100% in 10% increments
    this.zoomLevel = Math.round(Math.max(0, Math.min(100, level)) / 10) * 10;

    // Update viewport renderer's tile size for the new zoom level
    const currentTileSize = this.getCurrentTileSize();
    this.viewportRenderer.setTileRenderSize(currentTileSize);

    const availableRows = this.rows - this.layout.headerRows;
    const { widthTiles, heightTiles } = this.calculateViewportTiles(this.cols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(this.cols, availableRows);

    this.viewportRenderer.resize(
      Math.max(1, widthTiles),
      Math.max(1, heightTiles)
    );
    this.viewportRenderer.setPixelDimensions(pixelWidth, pixelHeight);

    // Update camera for new viewport dimensions
    this.viewportRenderer.setCamera(this.playerX, this.playerY);

    this.invalidate();  // This also calls invalidateStatsBar()
  }

  /**
   * Get current scale factor (for backwards compatibility)
   * @deprecated Use getZoomLevel() instead
   */
  getScale(): number {
    // Return 1 at 100% zoom (256px), 10 at 0% zoom (26px)
    return 10 - (this.zoomLevel / 100) * 9;
  }

  /**
   * Set scale factor (for backwards compatibility)
   * @deprecated Use setZoomLevel() instead
   */
  setScale(scale: number): void {
    // Convert scale to zoom level: scale 1 = 100%, scale 10 = 0%
    const zoomLevel = ((10 - scale) / 9) * 100;
    this.setZoomLevel(zoomLevel);
  }

  /**
   * Get current render mode
   */
  getRenderMode(): RenderMode {
    return this.renderMode;
  }

  /**
   * Set render mode and recalculate viewport
   */
  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;

    // Update tile size for new render mode
    const currentTileSize = this.getCurrentTileSize();
    this.viewportRenderer.setTileRenderSize(currentTileSize);

    const availableRows = this.rows - this.layout.headerRows;
    const { widthTiles, heightTiles } = this.calculateViewportTiles(this.cols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(this.cols, availableRows);

    this.viewportRenderer.resize(
      Math.max(1, widthTiles),
      Math.max(1, heightTiles)
    );
    this.viewportRenderer.setPixelDimensions(pixelWidth, pixelHeight);

    // Update camera for new viewport dimensions
    this.viewportRenderer.setCamera(this.playerX, this.playerY);

    this.invalidate();
  }

  /**
   * Cycle through render modes
   */
  cycleRenderMode(): void {
    const modes: RenderMode[] = ['braille', 'halfblock', 'normal'];
    const currentIndex = modes.indexOf(this.renderMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.setRenderMode(modes[nextIndex]!);
  }

  /**
   * Zoom in by 10% (increase zoom level = more zoomed in, less world visible)
   */
  zoomIn(): void {
    this.setZoomLevel(this.zoomLevel + 10);
  }

  /**
   * Zoom out by 10% (decrease zoom level = more zoomed out, more world visible)
   */
  zoomOut(): void {
    this.setZoomLevel(this.zoomLevel - 10);
  }

  /**
   * Render a frame and return the output string without writing
   * Use this for batching multiple outputs together
   */
  renderToString(world: WorldDataProvider): string {
    this.tickCount++;

    // Generate stats bar
    const statsBar = this.renderStatsBar();

    // Render viewport to raw pixel buffer with overlays (already at correct resolution)
    const { buffer, overlays } = this.viewportRenderer.renderToBuffer(world, this.tickCount);

    // Apply color quantization at high zoom levels to reduce ANSI codes
    let quantizedBuffer = buffer;
    if (this.zoomLevel > 70) {
      quantizedBuffer = quantizeGrid(buffer, 4);
    } else if (this.zoomLevel > 50) {
      quantizedBuffer = quantizeGrid(buffer, 5);
    }

    // Convert to ANSI lines based on render mode
    let viewportLines: string[];
    switch (this.renderMode) {
      case 'braille':
        viewportLines = renderBrailleGrid(quantizedBuffer);
        break;
      case 'halfblock':
        viewportLines = renderHalfBlockGrid(quantizedBuffer);
        break;
      case 'normal':
      default:
        viewportLines = quantizedBuffer.map(row => renderPixelRow(row));
        break;
    }

    // Pad viewport lines to fill screen width
    const paddedLines = viewportLines.map(line => this.padLine(line));

    // Add padding rows if needed to fill the screen
    const availableRows = this.rows - this.layout.headerRows;
    while (paddedLines.length < availableRows) {
      paddedLines.push(this.createPaddingLine());
    }

    // Combine stats bar + viewport
    const lines = [statsBar, ...paddedLines];

    // Generate output string
    return this.generateFrameOutput(lines, overlays);
  }

  /**
   * Generate frame output string without writing to stream
   */
  private generateFrameOutput(lines: string[], overlays: TextOverlay[] = []): string {
    let output = '';
    const bgColorAnsi = bg(BG_PRIMARY);

    // Performance: Only force full redraw when overlay count changes, not every frame with overlays
    const overlayCountChanged = overlays.length !== this.previousOverlayCount;
    this.previousOverlayCount = overlays.length;

    if (this.forceRedraw || this.previousOutput.length !== lines.length || overlayCountChanged) {
      // Full redraw - write every line from the top
      output += `${ESC}[H`;  // Move to home
      for (let y = 0; y < lines.length; y++) {
        output += `${ESC}[${y + 1};1H`;  // Move to line y+1
        output += lines[y] + `${ESC}[0m${bgColorAnsi}`;
      }
      // Clear any remaining lines below
      output += `${ESC}[J`;  // Clear from cursor to end of screen
      this.forceRedraw = false;
    } else {
      // Incremental update - only redraw changed lines
      for (let y = 0; y < lines.length; y++) {
        if (lines[y] !== this.previousOutput[y]) {
          output += `${ESC}[${y + 1};1H`;  // Move to line y+1
          output += lines[y] + `${ESC}[0m`;
        }
      }
    }

    // Render text overlays (usernames above players)
    for (const overlay of overlays) {
      const { row, col } = this.pixelToTerminal(overlay.pixelX, overlay.pixelY);

      // Account for stats bar (+1) and 1-based terminal rows (+1)
      const terminalRow = row + this.layout.headerRows + 1;

      // Skip if out of bounds
      if (terminalRow < 1 || terminalRow > this.rows) continue;

      // Center the text
      const textLen = overlay.text.length + 2;  // +2 for padding spaces
      const startCol = Math.max(1, col - Math.floor(textLen / 2) + 1);

      // Build the overlay text with ANSI colors
      const bg = `${ESC}[48;2;${overlay.bgColor.r};${overlay.bgColor.g};${overlay.bgColor.b}m`;
      const fg = `${ESC}[38;2;${overlay.fgColor.r};${overlay.fgColor.g};${overlay.fgColor.b}m`;
      const reset = `${ESC}[0m`;

      output += `${ESC}[${terminalRow};${startCol}H${bg}${fg} ${overlay.text} ${reset}`;
    }

    this.previousOutput = [...lines];
    return output;
  }

  /**
   * Write output directly to stream (for standalone use)
   */
  writeOutput(output: string): void {
    if (output) {
      this.stream.write(output);
    }
  }

  // ========================================
  // Camera Control Methods
  // ========================================

  /**
   * Get current camera mode ('follow' or 'free')
   */
  getCameraMode(): CameraMode {
    return this.viewportRenderer.getCameraMode();
  }

  /**
   * Set camera mode
   */
  setCameraMode(mode: CameraMode): void {
    this.viewportRenderer.setCameraMode(mode);
  }

  /**
   * Toggle between 'follow' and 'free' camera modes
   * Returns the new mode
   */
  toggleCameraMode(): CameraMode {
    return this.viewportRenderer.toggleCameraMode();
  }

  /**
   * Pan the camera by pixel offset (for free camera mode)
   * In follow mode, this has no effect until mode is changed
   */
  panCamera(deltaX: number, deltaY: number): void {
    this.viewportRenderer.panCamera(deltaX, deltaY);
  }

  /**
   * Pan the camera by tile offset (more convenient for keyboard controls)
   * Pans by the current tile render size
   */
  panCameraByTiles(deltaTilesX: number, deltaTilesY: number): void {
    this.viewportRenderer.panCameraByTiles(deltaTilesX, deltaTilesY);
  }

  /**
   * Get current camera rotation (0, 90, 180, or 270 degrees)
   */
  getCameraRotation(): CameraRotation {
    return this.viewportRenderer.getCameraRotation();
  }

  /**
   * Rotate camera clockwise by 90 degrees
   * Returns the new rotation
   */
  rotateCameraClockwise(): CameraRotation {
    return this.viewportRenderer.rotateCameraClockwise();
  }

  /**
   * Rotate camera counter-clockwise by 90 degrees
   * Returns the new rotation
   */
  rotateCameraCounterClockwise(): CameraRotation {
    return this.viewportRenderer.rotateCameraCounterClockwise();
  }

  /**
   * Get the world direction for a screen direction based on camera rotation
   * Used for screen-relative movement controls
   */
  getWorldDirection(screenDirection: Direction): Direction {
    return this.viewportRenderer.getWorldDirection(screenDirection);
  }

  /**
   * Snap camera back to follow target (player position)
   * Useful after panning in free mode
   */
  snapCameraToPlayer(): void {
    this.viewportRenderer.snapToTarget();
  }

  /**
   * Get camera center in world pixels
   */
  getCameraCenter(): { x: number; y: number } {
    return this.viewportRenderer.getCameraCenter();
  }

  /**
   * Get camera center in tile coordinates
   */
  getCameraTilePosition(): { x: number; y: number } {
    return this.viewportRenderer.getCameraTilePosition();
  }

  // ========================================
  // Layout Configuration Methods
  // ========================================

  /**
   * Get current layout configuration
   */
  getLayout(): LayoutConfig {
    return { ...this.layout };
  }

  /**
   * Update layout configuration
   * Use this to reserve space for UI elements (chat, sidebar, footer)
   */
  setLayout(newLayout: Partial<LayoutConfig>): void {
    this.layout = { ...this.layout, ...newLayout };

    // Recalculate viewport
    const { availableCols, availableRows } = this.getViewportArea();
    const { widthTiles, heightTiles } = this.calculateViewportTiles(availableCols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(availableCols, availableRows);

    this.viewportRenderer.setTileRenderSize(this.getCurrentTileSize());
    this.viewportRenderer.resize(
      Math.max(1, widthTiles),
      Math.max(1, heightTiles)
    );
    this.viewportRenderer.setPixelDimensions(pixelWidth, pixelHeight);
    this.viewportRenderer.setCamera(this.playerX, this.playerY);

    this.invalidate();
  }
}
