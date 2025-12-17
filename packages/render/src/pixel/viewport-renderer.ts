import type {
  PixelGrid,
  PlayerVisualState,
  RGB,
  WorldDataProvider
} from '@maldoror/protocol';
import { TILE_SIZE, PIXEL_SPRITE_WIDTH, PIXEL_SPRITE_HEIGHT } from '@maldoror/protocol';
import {
  createEmptyGrid,
  renderPixelRow,
} from './pixel-renderer.js';

/**
 * Viewport configuration
 */
export interface ViewportConfig {
  widthTiles: number;   // Viewport width in tiles
  heightTiles: number;  // Viewport height in tiles
}

// Re-export for convenience
export type { WorldDataProvider } from '@maldoror/protocol';

/**
 * Render the game viewport to ANSI strings
 */
export class ViewportRenderer {
  private config: ViewportConfig;
  private cameraX: number = 0;  // Camera position in tiles
  private cameraY: number = 0;

  constructor(config: ViewportConfig) {
    this.config = config;
  }

  /**
   * Set camera position (centered on player)
   */
  setCamera(tileX: number, tileY: number): void {
    this.cameraX = tileX - Math.floor(this.config.widthTiles / 2);
    this.cameraY = tileY - Math.floor(this.config.heightTiles / 2);
  }

  /**
   * Render the viewport and return array of ANSI strings (one per terminal row)
   */
  render(world: WorldDataProvider, tick: number): string[] {
    const buffer = this.renderToBuffer(world, tick);
    return this.bufferToAnsi(buffer);
  }

  /**
   * Render the viewport to a raw pixel buffer
   */
  renderToBuffer(world: WorldDataProvider, tick: number): PixelGrid {
    // Calculate pixel dimensions
    const pixelWidth = this.config.widthTiles * TILE_SIZE;
    const pixelHeight = this.config.heightTiles * TILE_SIZE;

    // Create the pixel buffer
    const buffer = createEmptyGrid(pixelWidth, pixelHeight);

    // 1. Render tiles
    this.renderTiles(buffer, world, tick);

    // 2. Render players (sorted by Y for proper overlap)
    this.renderPlayers(buffer, world, tick);

    return buffer;
  }

  /**
   * Render tiles to buffer
   */
  private renderTiles(buffer: PixelGrid, world: WorldDataProvider, tick: number): void {
    for (let ty = 0; ty < this.config.heightTiles; ty++) {
      for (let tx = 0; tx < this.config.widthTiles; tx++) {
        const worldTileX = this.cameraX + tx;
        const worldTileY = this.cameraY + ty;
        const tile = world.getTile(worldTileX, worldTileY);

        if (tile) {
          // Get the right frame for animated tiles
          let tilePixels = tile.pixels;
          if (tile.animated && tile.animationFrames) {
            const frameIndex = Math.floor(tick / 15) % tile.animationFrames.length;
            tilePixels = tile.animationFrames[frameIndex] ?? tile.pixels;
          }

          // Copy tile pixels to buffer
          const bufferX = tx * TILE_SIZE;
          const bufferY = ty * TILE_SIZE;

          for (let py = 0; py < TILE_SIZE && py < tilePixels.length; py++) {
            const tileRow = tilePixels[py];
            if (!tileRow) continue;

            for (let px = 0; px < TILE_SIZE && px < tileRow.length; px++) {
              const pixel = tileRow[px];
              if (pixel && buffer[bufferY + py]) {
                buffer[bufferY + py]![bufferX + px] = pixel;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Render players to buffer
   */
  private renderPlayers(buffer: PixelGrid, world: WorldDataProvider, _tick: number): void {
    const players = world.getPlayers();
    const localId = world.getLocalPlayerId();

    // Sort by Y position for proper layering (lower Y drawn first)
    const sortedPlayers = [...players].sort((a, b) => a.y - b.y);

    for (const player of sortedPlayers) {
      const sprite = world.getPlayerSprite(player.userId);
      if (!sprite) {
        // Render placeholder if no sprite
        this.renderPlaceholderPlayer(buffer, player);
        continue;
      }

      // Get the correct sprite frame
      const directionFrames = sprite.frames[player.direction];
      const frame = directionFrames[player.animationFrame];
      if (!frame) continue;

      // Calculate screen position in pixels
      // Player position is in tiles, sprite is centered on tile
      const screenTileX = player.x - this.cameraX;
      const screenTileY = player.y - this.cameraY;

      // Sprite is positioned so feet are at bottom of tile
      const bufferX = screenTileX * TILE_SIZE + Math.floor((TILE_SIZE - PIXEL_SPRITE_WIDTH) / 2);
      const bufferY = screenTileY * TILE_SIZE - (PIXEL_SPRITE_HEIGHT - TILE_SIZE);

      // Composite sprite onto buffer
      for (let py = 0; py < frame.length; py++) {
        const spriteRow = frame[py];
        if (!spriteRow) continue;

        const targetY = bufferY + py;
        if (targetY < 0 || targetY >= buffer.length) continue;

        for (let px = 0; px < spriteRow.length; px++) {
          const pixel = spriteRow[px];
          if (pixel === null || pixel === undefined) continue;  // Transparent or undefined

          const targetX = bufferX + px;
          if (targetX < 0 || targetX >= (buffer[targetY]?.length ?? 0)) continue;

          buffer[targetY]![targetX] = pixel;
        }
      }

      // Draw username above sprite for other players
      if (player.userId !== localId) {
        this.renderUsername(buffer, player.username, bufferX, bufferY - 2);
      }
    }
  }

  /**
   * Render a placeholder for players without sprites
   */
  private renderPlaceholderPlayer(buffer: PixelGrid, player: PlayerVisualState): void {
    const screenTileX = player.x - this.cameraX;
    const screenTileY = player.y - this.cameraY;

    if (screenTileX < 0 || screenTileX >= this.config.widthTiles ||
        screenTileY < 0 || screenTileY >= this.config.heightTiles) {
      return;
    }

    const bufferX = screenTileX * TILE_SIZE + Math.floor(TILE_SIZE / 2) - 4;
    const bufferY = screenTileY * TILE_SIZE + Math.floor(TILE_SIZE / 2) - 4;

    // Simple 8x8 placeholder
    const placeholderColor: RGB = { r: 255, g: 200, b: 50 };
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const targetY = bufferY + py;
        const targetX = bufferX + px;
        if (targetY >= 0 && targetY < buffer.length &&
            targetX >= 0 && targetX < (buffer[targetY]?.length ?? 0)) {
          buffer[targetY]![targetX] = placeholderColor;
        }
      }
    }
  }

  /**
   * Render username text (simplified - just a colored bar)
   */
  private renderUsername(buffer: PixelGrid, _username: string, x: number, y: number): void {
    // For now, just render a simple colored indicator
    const nameColor: RGB = { r: 255, g: 255, b: 255 };
    for (let px = 0; px < 12; px++) {
      const targetX = x + px;
      if (y >= 0 && y < buffer.length &&
          targetX >= 0 && targetX < (buffer[y]?.length ?? 0)) {
        buffer[y]![targetX] = nameColor;
      }
    }
  }

  /**
   * Convert pixel buffer to ANSI strings
   */
  private bufferToAnsi(buffer: PixelGrid): string[] {
    return buffer.map(row => renderPixelRow(row));
  }

  /**
   * Get viewport dimensions in terminal characters
   */
  getTerminalDimensions(): { width: number; height: number } {
    return {
      width: this.config.widthTiles * TILE_SIZE * 2,  // 2 chars per pixel
      height: this.config.heightTiles * TILE_SIZE,     // 1 char per pixel row
    };
  }

  /**
   * Resize viewport
   */
  resize(widthTiles: number, heightTiles: number): void {
    this.config.widthTiles = widthTiles;
    this.config.heightTiles = heightTiles;
  }
}
