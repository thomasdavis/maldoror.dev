import type { Duplex } from 'stream';
import type { WorldDataProvider } from '@maldoror/protocol';
import { TILE_SIZE } from '@maldoror/protocol';
import { ViewportRenderer, type ViewportConfig } from './viewport-renderer.js';
import { downsampleGrid, renderPixelRow, renderHalfBlockGrid } from './pixel-renderer.js';

const ESC = '\x1b';

// Stats bar height in rows
const STATS_BAR_HEIGHT = 1;

/**
 * Configuration for PixelGameRenderer
 */
export interface PixelGameRendererConfig {
  stream: Duplex;
  cols: number;
  rows: number;
  username?: string;
  scale?: number;  // Downscale factor: 1 = normal, 2 = 2x2 pixels become 1 terminal pixel
  highRes?: boolean;  // Use half-block characters for 4x resolution
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
  private highRes: boolean;

  constructor(config: PixelGameRendererConfig) {
    this.stream = config.stream;
    this.cols = config.cols;
    this.rows = config.rows;
    this.username = config.username ?? 'Unknown';
    this.highRes = config.highRes ?? true;  // Default to high-res mode
    this.scale = config.scale ?? 1.5;  // Default to 1.5x zoom out for better overview

    // Calculate viewport size in tiles based on terminal size
    // With scale > 1, we render MORE tiles then downsample to fit
    // In highRes mode:
    //   - 1 char = 1 pixel width (after downsampling)
    //   - 1 row = 2 pixel heights (using half-block characters, after downsampling)
    const availableRows = config.rows - STATS_BAR_HEIGHT;

    let widthTiles: number;
    let heightTiles: number;

    if (this.highRes) {
      // High-res: 1 char = 1 pixel output, 1 row = 2 pixels output
      // We render (cols * scale) pixels wide, (availableRows * 2 * scale) pixels tall
      // Then downsample by scale to fit the screen
      const pixelWidth = config.cols * this.scale;
      const pixelHeight = availableRows * 2 * this.scale;
      widthTiles = Math.floor(pixelWidth / TILE_SIZE);
      heightTiles = Math.floor(pixelHeight / TILE_SIZE);
    } else {
      // Normal: 2 chars = 1 pixel, 1 row = 1 pixel
      const pixelWidth = (config.cols / 2) * this.scale;
      const pixelHeight = availableRows * this.scale;
      widthTiles = Math.floor(pixelWidth / TILE_SIZE);
      heightTiles = Math.floor(pixelHeight / TILE_SIZE);
    }

    const viewportConfig: ViewportConfig = {
      widthTiles: Math.max(3, widthTiles),
      heightTiles: Math.max(3, heightTiles),
    };

    this.viewportRenderer = new ViewportRenderer(viewportConfig);
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
    let widthTiles: number;
    let heightTiles: number;

    if (this.highRes) {
      // High-res: render more pixels, then downsample
      const pixelWidth = cols * this.scale;
      const pixelHeight = availableRows * 2 * this.scale;
      widthTiles = Math.floor(pixelWidth / TILE_SIZE);
      heightTiles = Math.floor(pixelHeight / TILE_SIZE);
    } else {
      // Normal: render more pixels, then downsample
      const pixelWidth = (cols / 2) * this.scale;
      const pixelHeight = availableRows * this.scale;
      widthTiles = Math.floor(pixelWidth / TILE_SIZE);
      heightTiles = Math.floor(pixelHeight / TILE_SIZE);
    }

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

    // Render viewport to raw pixel buffer
    const fullBuffer = this.viewportRenderer.renderToBuffer(world, this.tickCount);

    // Downsample if scale > 1
    const scaledBuffer = this.scale > 1 ? downsampleGrid(fullBuffer, this.scale) : fullBuffer;

    // Convert to ANSI lines
    let viewportLines: string[];
    if (this.highRes) {
      // High-res mode: use half-block characters (2 pixels per row, 1 char per pixel)
      viewportLines = renderHalfBlockGrid(scaledBuffer);
    } else {
      // Normal mode: 1 pixel per row, 2 chars per pixel
      viewportLines = scaledBuffer.map(row => renderPixelRow(row));
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

    // Output to stream
    this.outputFrame(lines);
  }

  /**
   * Pad a line to fill the screen width
   */
  private padLine(line: string): string {
    // The line already has ANSI codes. We need to add padding spaces
    // to reach the full column width
    // Calculate the visible width of the viewport in terminal chars
    let viewportCharWidth: number;

    if (this.highRes) {
      // High-res: render (cols * scale) pixels, downsample to cols chars
      // After downsampling, we get floor(widthTiles * TILE_SIZE / scale) chars
      const pixelWidth = this.cols * this.scale;
      const widthTiles = Math.floor(pixelWidth / TILE_SIZE);
      viewportCharWidth = Math.floor(widthTiles * TILE_SIZE / this.scale);
    } else {
      // Normal: 2 chars per pixel output
      const pixelWidth = (this.cols / 2) * this.scale;
      const widthTiles = Math.floor(pixelWidth / TILE_SIZE);
      viewportCharWidth = Math.floor(widthTiles * TILE_SIZE / this.scale) * 2;
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
   * Render the stats bar showing username and coordinates
   */
  private renderStatsBar(): string {
    const coordStr = `(${this.playerX}, ${this.playerY})`;
    const leftText = ` ${this.username}`;
    const rightText = `${coordStr} `;

    // Calculate padding
    const totalWidth = this.cols;
    const contentWidth = leftText.length + rightText.length;
    const padding = Math.max(0, totalWidth - contentWidth);

    // Create stats bar with dark background
    // Using ANSI: white text on dark gray background
    const bg = `${ESC}[48;2;30;30;40m`;  // Dark blue-gray background
    const fgName = `${ESC}[38;2;100;200;255m`;  // Cyan for username
    const fgCoord = `${ESC}[38;2;180;180;180m`;  // Gray for coordinates
    const reset = `${ESC}[0m`;

    return `${bg}${fgName}${leftText}${' '.repeat(padding)}${fgCoord}${rightText}${reset}`;
  }

  /**
   * Output frame to stream with minimal updates
   */
  private outputFrame(lines: string[]): void {
    let output = '';

    // Move to home position
    output += `${ESC}[H`;

    if (this.forceRedraw || this.previousOutput.length !== lines.length) {
      // Full redraw
      output += lines.join(`${ESC}[0m\n`) + `${ESC}[0m`;
      this.forceRedraw = false;
    } else {
      // Incremental update - only redraw changed lines
      for (let y = 0; y < lines.length; y++) {
        if (lines[y] !== this.previousOutput[y]) {
          output += `${ESC}[${y + 1};1H`;  // Move to line y
          output += lines[y] + `${ESC}[0m`;
        }
      }
    }

    this.stream.write(output);
    this.previousOutput = lines;
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
}
