import type { Rect } from '@maldoror/protocol';
import {
  STATS_PANEL_HEIGHT,
  CHAT_PANEL_HEIGHT,
  MIN_VIEWPORT_WIDTH,
  MIN_VIEWPORT_HEIGHT,
} from '@maldoror/protocol';

/**
 * Layout configuration
 */
export interface LayoutConfig {
  statsHeight: number;
  chatHeight: number;
  minViewportWidth: number;
  minViewportHeight: number;
}

/**
 * Manages panel layout calculations
 */
export class LayoutManager {
  private config: LayoutConfig = {
    statsHeight: STATS_PANEL_HEIGHT,
    chatHeight: CHAT_PANEL_HEIGHT,
    minViewportWidth: MIN_VIEWPORT_WIDTH,
    minViewportHeight: MIN_VIEWPORT_HEIGHT,
  };

  constructor(config?: Partial<LayoutConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Calculate panel layouts based on screen size
   */
  calculateLayout(
    screenWidth: number,
    screenHeight: number,
    _activePanels: Set<string>
  ): Map<string, Rect> {
    const layout = new Map<string, Rect>();

    // Stats bar always at top
    layout.set('stats', {
      x: 0,
      y: 0,
      width: screenWidth,
      height: this.config.statsHeight,
    });

    // Adjust chat height for small terminals
    let chatHeight = this.config.chatHeight;
    if (screenHeight < 24) {
      chatHeight = Math.max(4, Math.floor(screenHeight / 4));
    }

    // Chat panel always at bottom
    layout.set('chat', {
      x: 0,
      y: screenHeight - chatHeight,
      width: screenWidth,
      height: chatHeight,
    });

    // Viewport takes remaining space
    const viewportY = this.config.statsHeight;
    const viewportHeight = screenHeight - this.config.statsHeight - chatHeight;

    layout.set('viewport', {
      x: 0,
      y: viewportY,
      width: screenWidth,
      height: viewportHeight,
    });

    return layout;
  }

  /**
   * Adjust active panels based on terminal size
   */
  adjustForTerminalSize(
    screenWidth: number,
    screenHeight: number,
    activePanels: Set<string>
  ): Set<string> {
    const adjusted = new Set(activePanels);

    // Hide optional panels if too small
    if (screenWidth < 60 || screenHeight < 20) {
      adjusted.delete('minimap');
      adjusted.delete('inventory');
    }

    return adjusted;
  }

  /**
   * Get minimum terminal size required
   */
  getMinimumSize(): { width: number; height: number } {
    return {
      width: this.config.minViewportWidth,
      height: this.config.minViewportHeight + this.config.statsHeight + 4, // 4 = minimum chat height
    };
  }
}
