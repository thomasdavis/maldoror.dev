import { Panel, type GameState, type PanelConfig } from './panel.js';

/**
 * Stats panel - displays player info, coordinates, etc.
 */
export class StatsPanel extends Panel {
  constructor(bounds: PanelConfig['bounds']) {
    super({
      id: 'stats',
      bounds,
      zIndex: 3, // UI layer
    });
  }

  render(state: GameState): void {
    // Clear with dark background
    this.buffer.fillRect(
      { x: 0, y: 0, width: this.bounds.width, height: this.bounds.height },
      { char: ' ', bg: { type: 'rgb', value: [20, 20, 30] } }
    );

    // Left side: username
    const username = state.player.username;
    this.renderText(1, 0, username, { type: 'rgb', value: [255, 215, 0] }, true);

    // Center: coordinates
    const coords = `(${state.player.x}, ${state.player.y})`;
    const coordsX = Math.floor((this.bounds.width - coords.length) / 2);
    this.renderText(coordsX, 0, coords, { type: 'rgb', value: [150, 150, 150] });

    // Right side: online indicator
    const onlineText = '● Online';
    const onlineX = this.bounds.width - onlineText.length - 1;
    this.renderText(onlineX, 0, '●', { type: 'rgb', value: [50, 255, 50] });
    this.renderText(onlineX + 2, 0, 'Online', { type: 'rgb', value: [100, 100, 100] });

    this.needsRedraw = false;
  }

  private renderText(
    x: number,
    y: number,
    text: string,
    fg: { type: 'rgb'; value: [number, number, number] } | { type: 'default' },
    bold: boolean = false
  ): void {
    for (let i = 0; i < text.length && x + i < this.bounds.width; i++) {
      const char = text[i];
      if (char !== undefined) {
        this.buffer.setCell(x + i, y, {
          char,
          fg,
          bg: { type: 'rgb', value: [20, 20, 30] },
          attrs: {
            bold,
            dim: false,
            italic: false,
            underline: false,
            blink: false,
            inverse: false,
            strikethrough: false,
          },
        });
      }
    }
  }
}
