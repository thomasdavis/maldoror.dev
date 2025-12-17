import { Panel, type GameState, type PanelConfig } from './panel.js';
import { rgb } from '../ansi/colors.js';

/**
 * Main game viewport panel - renders the world and entities
 */
export class ViewportPanel extends Panel {
  private cameraX: number = 0;
  private cameraY: number = 0;

  constructor(bounds: PanelConfig['bounds']) {
    super({
      id: 'viewport',
      bounds,
      zIndex: 0, // Background layer
    });
  }

  render(state: GameState): void {
    // Center camera on player
    this.cameraX = state.player.x - Math.floor(this.bounds.width / 2);
    this.cameraY = state.player.y - Math.floor(this.bounds.height / 2);

    // Render tiles
    for (let screenY = 0; screenY < this.bounds.height; screenY++) {
      for (let screenX = 0; screenX < this.bounds.width; screenX++) {
        const worldX = this.cameraX + screenX;
        const worldY = this.cameraY + screenY;

        const tile = state.world.getTile(worldX, worldY);
        if (tile) {
          this.buffer.setCell(screenX, screenY, {
            char: tile.char,
            fg: tile.fg ? rgb(tile.fg) : { type: 'default' },
            bg: tile.bg ? rgb(tile.bg) : { type: 'default' },
          });
        } else {
          // Out of bounds - render void
          this.buffer.setCell(screenX, screenY, {
            char: ' ',
            bg: { type: 'rgb', value: [10, 10, 15] },
          });
        }
      }
    }

    // Render other players
    for (const player of state.visiblePlayers) {
      const screenPos = this.worldToScreen(player.x, player.y);
      if (this.isOnScreen(screenPos.x, screenPos.y)) {
        // Simple player marker for MVP (will use sprites later)
        this.buffer.setCell(screenPos.x, screenPos.y, {
          char: '@',
          fg: { type: 'rgb', value: [100, 200, 255] },
        });
      }
    }

    // Render local player
    const playerScreenX = state.player.x - this.cameraX;
    const playerScreenY = state.player.y - this.cameraY;
    if (this.isOnScreen(playerScreenX, playerScreenY)) {
      this.buffer.setCell(playerScreenX, playerScreenY, {
        char: '@',
        fg: { type: 'rgb', value: [255, 215, 0] }, // Gold
        attrs: {
          bold: true,
          dim: false,
          italic: false,
          underline: false,
          blink: false,
          inverse: false,
          strikethrough: false,
        },
      });
    }

    this.needsRedraw = false;
  }

  /**
   * Convert world coordinates to screen coordinates
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: worldX - this.cameraX,
      y: worldY - this.cameraY,
    };
  }

  /**
   * Convert screen coordinates to world coordinates
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: this.cameraX + screenX,
      y: this.cameraY + screenY,
    };
  }

  /**
   * Check if screen coordinates are within viewport
   */
  private isOnScreen(screenX: number, screenY: number): boolean {
    return (
      screenX >= 0 &&
      screenX < this.bounds.width &&
      screenY >= 0 &&
      screenY < this.bounds.height
    );
  }

  /**
   * Get current camera position
   */
  getCamera(): { x: number; y: number } {
    return { x: this.cameraX, y: this.cameraY };
  }
}
