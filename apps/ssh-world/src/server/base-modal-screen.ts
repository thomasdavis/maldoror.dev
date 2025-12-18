import type { Duplex } from 'stream';
import { ANSIBuilder, BG_PRIMARY } from '@maldoror/render';

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const SPINNER_INTERVAL = 200;

export type ScreenState = 'input' | 'generating' | 'preview' | 'error';

export interface BoxConfig {
  width: number;
  height: number;
  startX: number;
  startY: number;
  title: string;
  borderColor: [number, number, number];
  titleColor: [number, number, number];
}

/**
 * Base class for modal screens (avatar generation, building placement, etc.)
 * Provides shared UI utilities for rendering boxes, spinners, text wrapping, etc.
 */
export abstract class BaseModalScreen {
  protected stream: Duplex;
  protected ansi: ANSIBuilder;
  protected state: ScreenState = 'input';
  protected destroyed: boolean = false;
  protected spinnerFrame: number = 0;
  protected spinnerInterval: NodeJS.Timeout | null = null;
  protected inputBuffer: string = '';
  protected errorMessage: string = '';
  protected progressStep: string = '';
  protected progressCurrent: number = 0;
  protected progressTotal: number = 0;
  protected isGenerating: boolean = false;

  constructor(stream: Duplex) {
    this.stream = stream;
    this.ansi = new ANSIBuilder();
  }

  /**
   * Fill the background with brand dark color
   * IMPORTANT: Enforces Maldoror dark theme - no system override possible
   */
  protected fillBackground(): void {
    this.stream.write(
      this.ansi
        .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
        .build()
    );
    for (let y = 0; y < 30; y++) {
      this.stream.write(
        this.ansi
          .moveTo(0, y)
          .write(' '.repeat(100))
          .build()
      );
    }
  }

  /**
   * Draw a box with a title
   */
  protected drawBox(config: BoxConfig): void {
    const { width, height, startX, startY, title, borderColor, titleColor } = config;

    // Top border
    this.stream.write(
      this.ansi
        .moveTo(startX, startY)
        .setForeground({ type: 'rgb', value: borderColor })
        .write('╔' + '═'.repeat(width - 2) + '╗')
        .build()
    );

    // Sides
    for (let y = 1; y < height - 1; y++) {
      this.stream.write(
        this.ansi
          .moveTo(startX, startY + y)
          .write('║')
          .moveTo(startX + width - 1, startY + y)
          .write('║')
          .build()
      );
    }

    // Bottom border
    this.stream.write(
      this.ansi
        .moveTo(startX, startY + height - 1)
        .write('╚' + '═'.repeat(width - 2) + '╝')
        .resetAttributes()
        .build()
    );

    // Title
    const paddedTitle = ` ${title} `;
    const titleX = startX + Math.floor((width - paddedTitle.length) / 2);
    this.stream.write(
      this.ansi
        .moveTo(titleX, startY)
        .setForeground({ type: 'rgb', value: titleColor })
        .write(paddedTitle)
        .resetAttributes()
        .build()
    );
  }

  /**
   * Start the spinner animation
   */
  protected startSpinner(): void {
    this.spinnerFrame = 0;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (this.state === 'generating') {
        this.renderSpinnerOnly();
      }
    }, SPINNER_INTERVAL);
  }

  /**
   * Stop the spinner animation
   */
  protected stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  /**
   * Get the current spinner character
   */
  protected getSpinnerChar(): string {
    return SPINNER_FRAMES[this.spinnerFrame]!;
  }

  /**
   * Wrap text to fit within a maximum width
   */
  protected wrapText(text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines;
  }

  /**
   * Render just the spinner character (for animation updates)
   * Override in subclass to specify position
   */
  protected abstract renderSpinnerOnly(): void;

  /**
   * Clean up resources when closing the screen
   * NOTE: Does NOT remove stream listeners - subclass must do that to avoid
   * removing game session's listener
   */
  protected cleanup(): void {
    this.destroyed = true;
    this.stopSpinner();
    // Don't removeAllListeners('data') here - it would remove game session's listener!
    // Each subclass should remove only its own listener before calling cleanup()
    this.stream.write(
      this.ansi
        .exitAlternateScreen()
        .showCursor()
        .resetAttributes()
        .build()
    );
  }

  /**
   * Enter the modal screen (alternate buffer, hide cursor, dark background)
   * IMPORTANT: Enforces Maldoror dark theme - no system override possible
   */
  protected enterScreen(): void {
    this.stream.write(
      this.ansi
        .enterAlternateScreen()
        .hideCursor()
        .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
        .clearScreen()
        .build()
    );
    this.fillBackground();
  }
}
