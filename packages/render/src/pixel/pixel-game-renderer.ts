import type { Duplex } from 'stream';
import type { WorldDataProvider } from '@maldoror/protocol';
import { TILE_SIZE } from '@maldoror/protocol';
import { ViewportRenderer, type ViewportConfig, type TextOverlay } from './viewport-renderer.js';
import { downsampleGrid, renderPixelRow, renderHalfBlockGrid, renderBrailleGrid } from './pixel-renderer.js';

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
  scale?: number;  // Downscale factor: 1 = normal, 1.5 = 50% more world visible
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
  private username: string;
  private playerX: number = 0;
  private playerY: number = 0;
  private scale: number;
  private renderMode: RenderMode;

  constructor(config: PixelGameRendererConfig) {
    this.stream = config.stream;
    this.cols = config.cols;
    this.rows = config.rows;
    this.username = config.username ?? 'Unknown';
    this.renderMode = config.renderMode ?? 'halfblock';  // Default to halfblock for good balance
    this.scale = config.scale ?? 1.2;  // Default to 1.2x zoom out (press +/- to adjust)

    // Calculate viewport size in tiles based on terminal size
    // With scale > 1, we render MORE tiles then downsample to fit
    const availableRows = config.rows - STATS_BAR_HEIGHT;

    const { widthTiles, heightTiles } = this.calculateViewportTiles(config.cols, availableRows);

    const viewportConfig: ViewportConfig = {
      widthTiles: Math.max(3, widthTiles),
      heightTiles: Math.max(3, heightTiles),
    };

    this.viewportRenderer = new ViewportRenderer(viewportConfig);
  }

  /**
   * Calculate viewport size in tiles based on render mode
   */
  private calculateViewportTiles(cols: number, availableRows: number): { widthTiles: number; heightTiles: number } {
    let pixelWidth: number;
    let pixelHeight: number;

    switch (this.renderMode) {
      case 'braille':
        // Braille: 1 char = 2 pixels wide, 1 row = 4 pixels tall
        // This is the highest resolution mode
        pixelWidth = cols * 2 * this.scale;
        pixelHeight = availableRows * 4 * this.scale;
        break;
      case 'halfblock':
        // Half-block: 1 char = 1 pixel wide, 1 row = 2 pixels tall
        pixelWidth = cols * this.scale;
        pixelHeight = availableRows * 2 * this.scale;
        break;
      case 'normal':
      default:
        // Normal: 2 chars = 1 pixel wide, 1 row = 1 pixel tall
        pixelWidth = (cols / 2) * this.scale;
        pixelHeight = availableRows * this.scale;
        break;
    }

    return {
      widthTiles: Math.floor(pixelWidth / TILE_SIZE),
      heightTiles: Math.floor(pixelHeight / TILE_SIZE),
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

    this.viewportRenderer.resize(
      Math.max(3, widthTiles),
      Math.max(3, heightTiles)
    );

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

    // Render viewport to raw pixel buffer with overlays
    const { buffer: fullBuffer, overlays } = this.viewportRenderer.renderToBuffer(world, this.tickCount);

    // Downsample if scale > 1
    const scaledBuffer = this.scale > 1 ? downsampleGrid(fullBuffer, this.scale) : fullBuffer;

    // Scale overlay positions to match downsampled buffer
    const scaledOverlays = overlays.map(o => ({
      ...o,
      pixelX: Math.floor(o.pixelX / this.scale),
      pixelY: Math.floor(o.pixelY / this.scale),
    }));

    // Convert to ANSI lines based on render mode
    let viewportLines: string[];
    switch (this.renderMode) {
      case 'braille':
        // Braille mode: 8 subpixels per character (2×4 dots) - HIGHEST RES
        viewportLines = renderBrailleGrid(scaledBuffer);
        break;
      case 'halfblock':
        // Half-block mode: 2 pixels per row, 1 char per pixel
        viewportLines = renderHalfBlockGrid(scaledBuffer);
        break;
      case 'normal':
      default:
        // Normal mode: 1 pixel per row, 2 chars per pixel
        viewportLines = scaledBuffer.map(row => renderPixelRow(row));
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
    this.outputFrame(lines, scaledOverlays);
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
    // Calculate the visible width of the viewport in terminal chars
    let viewportCharWidth: number;

    switch (this.renderMode) {
      case 'braille': {
        // Braille: 1 char = 2 pixels, so output width = pixels / 2
        const pixelWidth = this.cols * 2 * this.scale;
        const widthTiles = Math.floor(pixelWidth / TILE_SIZE);
        const outputPixelWidth = Math.floor(widthTiles * TILE_SIZE / this.scale);
        viewportCharWidth = Math.floor(outputPixelWidth / 2);
        break;
      }
      case 'halfblock': {
        // Half-block: 1 char = 1 pixel
        const pixelWidth = this.cols * this.scale;
        const widthTiles = Math.floor(pixelWidth / TILE_SIZE);
        viewportCharWidth = Math.floor(widthTiles * TILE_SIZE / this.scale);
        break;
      }
      case 'normal':
      default: {
        // Normal: 2 chars = 1 pixel
        const pixelWidth = (this.cols / 2) * this.scale;
        const widthTiles = Math.floor(pixelWidth / TILE_SIZE);
        viewportCharWidth = Math.floor(widthTiles * TILE_SIZE / this.scale) * 2;
        break;
      }
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
   * Render the stats bar showing username, coordinates, zoom, and render mode
   */
  private renderStatsBar(): string {
    const coordStr = `(${this.playerX}, ${this.playerY})`;
    const zoomStr = `${Math.round(100 / this.scale)}%`;
    const modeStr = this.renderMode.charAt(0).toUpperCase();  // B, H, or N

    const leftText = ` ${this.username}`;
    const centerText = `${modeStr}:${zoomStr}`;
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

    // Force full redraw when overlays are present (they need clean backgrounds)
    const hasOverlays = overlays.length > 0;

    if (this.forceRedraw || this.previousOutput.length !== lines.length || hasOverlays) {
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
    const dims = this.viewportRenderer.getTerminalDimensions();
    return {
      widthTiles: Math.floor(dims.width / (TILE_SIZE * 2)),
      heightTiles: dims.height / TILE_SIZE,
    };
  }

  /**
   * Get current scale factor
   */
  getScale(): number {
    return this.scale;
  }

  /**
   * Set scale factor and recalculate viewport
   */
  setScale(scale: number): void {
    this.scale = Math.max(0.5, Math.min(3, scale));  // Clamp between 0.5x and 3x

    const availableRows = this.rows - STATS_BAR_HEIGHT;
    const { widthTiles, heightTiles } = this.calculateViewportTiles(this.cols, availableRows);

    this.viewportRenderer.resize(
      Math.max(3, widthTiles),
      Math.max(3, heightTiles)
    );

    // Update camera for new viewport dimensions
    this.viewportRenderer.setCamera(this.playerX, this.playerY);

    this.invalidate();
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

    const availableRows = this.rows - STATS_BAR_HEIGHT;
    const { widthTiles, heightTiles } = this.calculateViewportTiles(this.cols, availableRows);

    this.viewportRenderer.resize(
      Math.max(3, widthTiles),
      Math.max(3, heightTiles)
    );

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
   * Zoom in (decrease scale = more zoomed in)
   */
  zoomIn(): void {
    this.setScale(this.scale - 0.2);
  }

  /**
   * Zoom out (increase scale = more zoomed out)
   */
  zoomOut(): void {
    this.setScale(this.scale + 0.2);
  }
}
