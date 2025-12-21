import type { Rect } from '@maldoror/protocol';
import { ScreenBuffer } from '../buffer/screen-buffer.js';

/**
 * Panel configuration
 */
export interface PanelConfig {
  id: string;
  bounds: Rect;
  zIndex: number;
  visible?: boolean;
}

/**
 * Game state passed to panels for rendering
 */
export interface GameState {
  player: {
    userId: string;
    username: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
  };
  visiblePlayers: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
    spriteJson?: unknown;
  }>;
  chatMessages: Array<{
    senderId: string;
    senderName: string;
    text: string;
    timestamp: number;
  }>;
  world: {
    getTile: (x: number, y: number) => { char: string; fg?: string; bg?: string } | null;
  };
  tick: number;
  serverVersion?: string;
}

/**
 * Abstract base class for UI panels
 */
export abstract class Panel {
  public readonly id: string;
  public bounds: Rect;
  public zIndex: number;
  protected buffer: ScreenBuffer;
  protected visible: boolean = true;
  protected needsRedraw: boolean = true;

  constructor(config: PanelConfig) {
    this.id = config.id;
    this.bounds = config.bounds;
    this.zIndex = config.zIndex;
    this.visible = config.visible ?? true;
    this.buffer = new ScreenBuffer(config.bounds.width, config.bounds.height);
  }

  /**
   * Render the panel's contents to its internal buffer
   */
  abstract render(state: GameState): void;

  /**
   * Resize the panel
   */
  resize(bounds: Rect): void {
    this.bounds = bounds;
    this.buffer = new ScreenBuffer(bounds.width, bounds.height);
    this.needsRedraw = true;
  }

  /**
   * Set visibility
   */
  setVisible(visible: boolean): void {
    if (this.visible !== visible) {
      this.visible = visible;
      this.needsRedraw = true;
    }
  }

  /**
   * Check if visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Mark as needing redraw
   */
  markDirty(): void {
    this.needsRedraw = true;
  }

  /**
   * Get the internal buffer
   */
  getBuffer(): ScreenBuffer {
    return this.buffer;
  }

  /**
   * Convert local panel coordinates to screen coordinates
   */
  toScreenCoord(localX: number, localY: number): { x: number; y: number } {
    return {
      x: this.bounds.x + localX,
      y: this.bounds.y + localY,
    };
  }

  /**
   * Check if screen coordinate is within this panel
   */
  containsScreenCoord(screenX: number, screenY: number): boolean {
    return (
      screenX >= this.bounds.x &&
      screenX < this.bounds.x + this.bounds.width &&
      screenY >= this.bounds.y &&
      screenY < this.bounds.y + this.bounds.height
    );
  }

  /**
   * Draw a box border around the panel
   */
  protected drawBorder(title?: string): void {
    const { width, height } = this.bounds;

    // Corners
    this.buffer.setCell(0, 0, { char: '┌' });
    this.buffer.setCell(width - 1, 0, { char: '┐' });
    this.buffer.setCell(0, height - 1, { char: '└' });
    this.buffer.setCell(width - 1, height - 1, { char: '┘' });

    // Horizontal borders
    for (let x = 1; x < width - 1; x++) {
      this.buffer.setCell(x, 0, { char: '─' });
      this.buffer.setCell(x, height - 1, { char: '─' });
    }

    // Vertical borders
    for (let y = 1; y < height - 1; y++) {
      this.buffer.setCell(0, y, { char: '│' });
      this.buffer.setCell(width - 1, y, { char: '│' });
    }

    // Title (if provided)
    if (title && title.length < width - 4) {
      const titleStart = Math.floor((width - title.length - 2) / 2);
      this.buffer.setCell(titleStart, 0, { char: '┤' });
      this.buffer.writeText(titleStart + 1, 0, title);
      this.buffer.setCell(titleStart + title.length + 1, 0, { char: '├' });
    }
  }
}
