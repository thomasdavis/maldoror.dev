import type { Duplex } from 'stream';
import type { WorldDataProvider } from '@maldoror/protocol';
import { ViewportRenderer, type ViewportConfig, type TextOverlay, type CameraMode } from './viewport-renderer.js';
import { renderPixelRow, renderHalfBlockGrid, renderBrailleGrid } from './pixel-renderer.js';

// Re-export for convenience
export type { CameraMode } from './viewport-renderer.js';

const ESC = '\x1b';

// Stats bar height in rows
const STATS_BAR_HEIGHT = 1;

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

  constructor(config: PixelGameRendererConfig) {
    this.stream = config.stream;
    this.cols = config.cols;
    this.rows = config.rows;
    this.username = config.username ?? 'Unknown';
    this.renderMode = config.renderMode ?? 'halfblock';  // Default to halfblock for good balance
    this.zoomLevel = config.zoomLevel ?? 0;  // Default to 0% zoom (base view, sprite = 1 tile)

    // Calculate viewport size based on terminal size
    const availableRows = config.rows - STATS_BAR_HEIGHT;
    const currentTileSize = this.getCurrentTileSize();
    const { widthTiles, heightTiles } = this.calculateViewportTiles(config.cols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(config.cols, availableRows);

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
    const availableRows = this.rows - STATS_BAR_HEIGHT;
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
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Dark background color for the whole screen
    const bgColor = `${ESC}[48;2;20;20;25m`;

    const init = [
      `${ESC}[?1049h`,      // Enter alternate screen
      `${ESC}[?25l`,         // Hide cursor
      `${ESC}[?7l`,          // Disable line wrap
      bgColor,               // Set dark background
      `${ESC}[2J`,           // Clear screen (with dark bg)
      `${ESC}[H`,            // Move to home
    ].join('');

    this.stream.write(init);
    this.forceRedraw = true;
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

    const availableRows = rows - STATS_BAR_HEIGHT;
    const { widthTiles, heightTiles } = this.calculateViewportTiles(cols, availableRows);
    const { pixelWidth, pixelHeight } = this.calculatePixelDimensions(cols, availableRows);

    this.viewportRenderer.resize(
      Math.max(1, widthTiles),
      Math.max(1, heightTiles)
    );
    this.viewportRenderer.setPixelDimensions(pixelWidth, pixelHeight);

    // Re-center camera after resize
    this.viewportRenderer.setCamera(this.playerX, this.playerY);

    this.forceRedraw = true;
    this.previousOutput = [];
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
    this.tickCount++;

    // Generate stats bar
    const statsBar = this.renderStatsBar();

    // Render viewport to raw pixel buffer with overlays (already at correct resolution)
    const { buffer, overlays } = this.viewportRenderer.renderToBuffer(world, this.tickCount);

    // Convert to ANSI lines based on render mode
    let viewportLines: string[];
    switch (this.renderMode) {
      case 'braille':
        // Braille mode: 8 subpixels per character (2×4 dots) - HIGHEST RES
        viewportLines = renderBrailleGrid(buffer);
        break;
      case 'halfblock':
        // Half-block mode: 2 pixels per row, 1 char per pixel
        viewportLines = renderHalfBlockGrid(buffer);
        break;
      case 'normal':
      default:
        // Normal mode: 1 pixel per row, 2 chars per pixel
        viewportLines = buffer.map(row => renderPixelRow(row));
        break;
    }

    // Pad viewport lines to fill screen width
    const paddedLines = viewportLines.map(line => this.padLine(line));

    // Add padding rows if needed to fill the screen
    const availableRows = this.rows - STATS_BAR_HEIGHT;
    while (paddedLines.length < availableRows) {
      paddedLines.push(this.createPaddingLine());
    }

    // Combine stats bar + viewport
    const lines = [statsBar, ...paddedLines];

    // Output to stream with overlays
    this.outputFrame(lines, overlays);
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
    const availableRows = this.rows - STATS_BAR_HEIGHT;
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
      return line + `${ESC}[48;2;20;20;25m` + ' '.repeat(paddingNeeded) + `${ESC}[0m`;
    }
    return line;
  }

  /**
   * Create a full-width padding line
   */
  private createPaddingLine(): string {
    return `${ESC}[48;2;20;20;25m` + ' '.repeat(this.cols) + `${ESC}[0m`;
  }

  /**
   * Render the stats bar showing username, coordinates, zoom, render mode, camera mode, and debug info
   */
  private renderStatsBar(): string {
    const tileSize = this.getCurrentTileSize();
    const availableRows = this.rows - STATS_BAR_HEIGHT;
    const { widthTiles, heightTiles } = this.calculateViewportTiles(this.cols, availableRows);

    const coordStr = `(${this.playerX}, ${this.playerY})`;
    const zoomStr = `${this.zoomLevel}%`;
    const modeStr = this.renderMode.charAt(0).toUpperCase();  // B, H, or N
    const cameraMode = this.viewportRenderer.getCameraMode();
    const camStr = cameraMode === 'free' ? ' [FREE]' : '';
    const debugStr = `${tileSize}px ${widthTiles}x${heightTiles}tiles term:${this.cols}x${this.rows}`;

    const leftText = ` ${this.username}`;
    const centerText = `${modeStr}:${zoomStr}${camStr} [${debugStr}]`;
    const rightText = `${coordStr} `;

    // Calculate padding for center alignment
    const totalWidth = this.cols;
    const leftPadding = Math.max(0, Math.floor((totalWidth - centerText.length) / 2) - leftText.length);
    const rightPadding = Math.max(0, totalWidth - leftText.length - leftPadding - centerText.length - rightText.length);

    // Create stats bar with dark background
    // Using ANSI: white text on dark gray background
    const bg = `${ESC}[48;2;30;30;40m`;  // Dark blue-gray background
    const fgName = `${ESC}[38;2;100;200;255m`;  // Cyan for username
    const fgMode = `${ESC}[38;2;255;200;100m`;  // Gold for mode/zoom
    const fgCoord = `${ESC}[38;2;180;180;180m`;  // Gray for coordinates
    const reset = `${ESC}[0m`;

    return `${bg}${fgName}${leftText}${' '.repeat(leftPadding)}${fgMode}${centerText}${' '.repeat(rightPadding)}${fgCoord}${rightText}${reset}`;
  }

  /**
   * Output frame to stream with minimal updates
   */
  private outputFrame(lines: string[], overlays: TextOverlay[] = []): void {
    let output = '';
    const bgColor = `${ESC}[48;2;20;20;25m`;

    // Performance: Only force full redraw when overlay count changes, not every frame with overlays
    const overlayCountChanged = overlays.length !== this.previousOverlayCount;
    this.previousOverlayCount = overlays.length;

    if (this.forceRedraw || this.previousOutput.length !== lines.length || overlayCountChanged) {
      // Full redraw - write every line from the top
      output += `${ESC}[H`;  // Move to home
      for (let y = 0; y < lines.length; y++) {
        output += `${ESC}[${y + 1};1H`;  // Move to line y+1
        output += lines[y] + `${ESC}[0m${bgColor}`;
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
      const terminalRow = row + STATS_BAR_HEIGHT + 1;

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

    if (output) {
      this.stream.write(output);
    }
    this.previousOutput = [...lines];
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
    const availableRows = this.rows - STATS_BAR_HEIGHT;
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

    const availableRows = this.rows - STATS_BAR_HEIGHT;
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

    const availableRows = this.rows - STATS_BAR_HEIGHT;
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

    // Convert to ANSI lines based on render mode
    let viewportLines: string[];
    switch (this.renderMode) {
      case 'braille':
        viewportLines = renderBrailleGrid(buffer);
        break;
      case 'halfblock':
        viewportLines = renderHalfBlockGrid(buffer);
        break;
      case 'normal':
      default:
        viewportLines = buffer.map(row => renderPixelRow(row));
        break;
    }

    // Pad viewport lines to fill screen width
    const paddedLines = viewportLines.map(line => this.padLine(line));

    // Add padding rows if needed to fill the screen
    const availableRows = this.rows - STATS_BAR_HEIGHT;
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
    const bgColor = `${ESC}[48;2;20;20;25m`;

    // Performance: Only force full redraw when overlay count changes, not every frame with overlays
    const overlayCountChanged = overlays.length !== this.previousOverlayCount;
    this.previousOverlayCount = overlays.length;

    if (this.forceRedraw || this.previousOutput.length !== lines.length || overlayCountChanged) {
      // Full redraw - write every line from the top
      output += `${ESC}[H`;  // Move to home
      for (let y = 0; y < lines.length; y++) {
        output += `${ESC}[${y + 1};1H`;  // Move to line y+1
        output += lines[y] + `${ESC}[0m${bgColor}`;
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
      const terminalRow = row + STATS_BAR_HEIGHT + 1;

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
}
