import type { Duplex } from 'stream';
import { ANSIBuilder } from '../ansi/builder.js';
import { ScreenBuffer } from '../buffer/screen-buffer.js';
import { cellsEqual } from '../buffer/cell.js';
import { Panel, type GameState } from '../panels/panel.js';
import { ViewportPanel } from '../panels/viewport-panel.js';
import { ChatPanel } from '../panels/chat-panel.js';
import { StatsPanel } from '../panels/stats-panel.js';
import { LayoutManager } from '../layout/layout-manager.js';

/**
 * Main TUI renderer - composites panels and outputs to stream
 */
export class TUIRenderer {
  private screenBuffer: ScreenBuffer;
  private previousBuffer: ScreenBuffer;
  private panels: Map<string, Panel> = new Map();
  private layoutManager: LayoutManager;
  private ansi: ANSIBuilder;
  private stream: Duplex | null = null;
  private activePanels: Set<string> = new Set(['viewport', 'chat', 'stats']);
  private forceFullRedraw: boolean = true;
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.screenBuffer = new ScreenBuffer(cols, rows);
    this.previousBuffer = new ScreenBuffer(cols, rows);
    this.layoutManager = new LayoutManager();
    this.ansi = new ANSIBuilder();

    this.initializePanels();
  }

  private initializePanels(): void {
    const layout = this.layoutManager.calculateLayout(
      this.cols,
      this.rows,
      this.activePanels
    );

    const viewportBounds = layout.get('viewport')!;
    const chatBounds = layout.get('chat')!;
    const statsBounds = layout.get('stats')!;

    this.panels.set('viewport', new ViewportPanel(viewportBounds));
    this.panels.set('chat', new ChatPanel(chatBounds));
    this.panels.set('stats', new StatsPanel(statsBounds));
  }

  /**
   * Attach output stream
   */
  attachStream(stream: Duplex): void {
    this.stream = stream;
  }

  /**
   * Initialize terminal (enter alternate screen, hide cursor, etc.)
   */
  initialize(): void {
    if (!this.stream) return;

    const init = this.ansi
      .enterAlternateScreen()
      .hideCursor()
      .disableLineWrap()
      .clearScreen()
      .build();

    this.stream.write(init);
    this.forceFullRedraw = true;
  }

  /**
   * Cleanup terminal (exit alternate screen, show cursor)
   */
  cleanup(): void {
    if (!this.stream) return;

    const cleanup = this.ansi
      .exitAlternateScreen()
      .showCursor()
      .enableLineWrap()
      .resetAttributes()
      .build();

    this.stream.write(cleanup);
  }

  /**
   * Handle terminal resize
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.screenBuffer = new ScreenBuffer(cols, rows);
    this.previousBuffer = new ScreenBuffer(cols, rows);

    // Recalculate layout
    const adjusted = this.layoutManager.adjustForTerminalSize(
      cols,
      rows,
      this.activePanels
    );
    this.activePanels = adjusted;

    const layout = this.layoutManager.calculateLayout(cols, rows, this.activePanels);

    // Resize all panels
    for (const [panelId, bounds] of layout) {
      const panel = this.panels.get(panelId);
      if (panel) {
        panel.resize(bounds);
      }
    }

    this.forceFullRedraw = true;
  }

  /**
   * Toggle panel visibility
   */
  togglePanel(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (panel) {
      panel.setVisible(!panel.isVisible());
      this.forceFullRedraw = true;
    }
  }

  /**
   * Render a frame
   */
  render(state: GameState): void {
    // 1. Render each panel to its local buffer
    for (const panel of this.getSortedPanels()) {
      if (panel.isVisible()) {
        panel.render(state);
      }
    }

    // 2. Composite panels onto screen buffer
    this.composite();

    // 3. Generate diff and output
    this.flush();
  }

  /**
   * Composite all panel buffers onto screen buffer
   */
  private composite(): void {
    // Clear screen buffer
    this.screenBuffer.clear();

    // Composite panels in z-order (lowest first)
    for (const panel of this.getSortedPanels()) {
      if (!panel.isVisible()) continue;

      const bounds = panel.bounds;
      const panelBuffer = panel.getBuffer();

      // Copy panel buffer to screen buffer at panel position
      this.screenBuffer.blit(panelBuffer, bounds.x, bounds.y);
    }
  }

  /**
   * Flush changes to stream
   */
  private flush(): void {
    if (!this.stream) return;

    let output: string;

    if (this.forceFullRedraw) {
      output = this.renderFullScreen();
      this.forceFullRedraw = false;
    } else {
      output = this.renderDiff();
    }

    if (output) {
      this.stream.write(output);
    }

    // Copy current buffer to previous
    this.swapBuffers();
  }

  /**
   * Render entire screen (used for initial render or after resize)
   */
  private renderFullScreen(): string {
    this.ansi.clear();

    for (let y = 0; y < this.rows; y++) {
      this.ansi.moveTo(0, y);

      for (let x = 0; x < this.cols; x++) {
        const cell = this.screenBuffer.getCell(x, y);
        if (cell) {
          this.ansi.writeCell(cell);
        }
      }
    }

    this.ansi.resetAttributes();
    return this.ansi.build();
  }

  /**
   * Render only changed cells
   */
  private renderDiff(): string {
    this.ansi.clear();

    let lastX = -2;
    let lastY = -1;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const current = this.screenBuffer.getCell(x, y);
        const previous = this.previousBuffer.getCell(x, y);

        if (current && previous && !cellsEqual(current, previous)) {
          // Move cursor if not contiguous
          if (lastY !== y || lastX !== x - 1) {
            this.ansi.moveTo(x, y);
          }

          this.ansi.writeCell(current);
          lastX = x;
          lastY = y;
        }
      }
    }

    this.ansi.resetAttributes();
    return this.ansi.build();
  }

  /**
   * Copy current buffer to previous buffer
   */
  private swapBuffers(): void {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const cell = this.screenBuffer.getCell(x, y);
        if (cell) {
          this.previousBuffer.setCell(x, y, { ...cell });
        }
      }
    }
    this.screenBuffer.clearDirty();
  }

  /**
   * Get panels sorted by z-index (ascending)
   */
  private getSortedPanels(): Panel[] {
    return Array.from(this.panels.values())
      .filter(p => this.activePanels.has(p.id))
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  /**
   * Get chat panel
   */
  getChatPanel(): ChatPanel {
    return this.panels.get('chat') as ChatPanel;
  }

  /**
   * Get viewport panel
   */
  getViewportPanel(): ViewportPanel {
    return this.panels.get('viewport') as ViewportPanel;
  }

  /**
   * Get stats panel
   */
  getStatsPanel(): StatsPanel {
    return this.panels.get('stats') as StatsPanel;
  }

  /**
   * Force full redraw on next render
   */
  invalidate(): void {
    this.forceFullRedraw = true;
  }

  /**
   * Get current dimensions
   */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
}
