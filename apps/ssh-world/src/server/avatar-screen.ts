import type { Duplex } from 'stream';
import type { Sprite } from '@maldoror/protocol';
import { renderHalfBlockGrid, BG_PRIMARY } from '@maldoror/render';
import { generateImageSprite, type ProviderConfig } from '@maldoror/ai';
import { BaseModalScreen } from './base-modal-screen.js';

const GENERATION_TIMEOUT = 120000; // 2 minutes

export interface AvatarScreenResult {
  action: 'confirm' | 'cancel';
  sprite?: Sprite;
  prompt?: string;
}

interface AvatarScreenConfig {
  stream: Duplex;
  currentPrompt?: string;
  providerConfig: ProviderConfig;
  username?: string;
}

/**
 * Modal screen for avatar regeneration
 */
export class AvatarScreen extends BaseModalScreen {
  private prompt: string;
  private sprite: Sprite | null = null;
  private providerConfig: ProviderConfig;
  private username: string;

  constructor(config: AvatarScreenConfig) {
    super(config.stream);
    this.prompt = config.currentPrompt ?? '';
    this.inputBuffer = ''; // Start with empty input - user types fresh prompt
    this.providerConfig = config.providerConfig;
    this.username = config.username ?? 'unknown';
    this.progressTotal = 8;
  }

  async run(): Promise<AvatarScreenResult> {
    this.enterScreen();
    this.render();

    return new Promise((resolve) => {
      const onData = async (data: Buffer) => {
        if (this.destroyed) return;

        // Skip escape sequences (arrow keys, etc) - they start with ESC and have multiple bytes
        if (data[0] === 0x1b && data.length > 1) {
          return;
        }

        // Handle Escape key (single ESC byte)
        if (data[0] === 0x1b && data.length === 1) {
          this.cleanup();
          this.stream.removeListener('data', onData);
          resolve({ action: 'cancel' });
          return;
        }

        // Handle Ctrl+C
        if (data[0] === 0x03) {
          this.cleanup();
          this.stream.removeListener('data', onData);
          resolve({ action: 'cancel' });
          return;
        }

        // Process only the first byte for simple input
        const byte = data[0]!;

        if (this.state === 'input') {
          if (byte === 0x0d || byte === 0x0a) {
            // Enter - start generation
            if (this.inputBuffer.trim().length > 0) {
              this.prompt = this.inputBuffer.trim();
              await this.startGeneration();
            }
          } else if (byte === 0x7f || byte === 0x08) {
            // Backspace
            if (this.inputBuffer.length > 0) {
              this.inputBuffer = this.inputBuffer.slice(0, -1);
              this.renderInputOnly();
            }
          } else if (byte >= 0x20 && byte < 0x7f) {
            // Printable character
            if (this.inputBuffer.length < 200) {
              this.inputBuffer += String.fromCharCode(byte);
              this.renderInputOnly();
            }
          }
        } else if (this.state === 'preview') {
          console.log('[AVATAR] Preview state, received byte:', byte);
          if (byte === 0x0d || byte === 0x0a) {
            // Enter - confirm
            console.log('[AVATAR] Confirming sprite, prompt:', this.prompt);
            this.cleanup();
            this.stream.removeListener('data', onData);
            resolve({
              action: 'confirm',
              sprite: this.sprite!,
              prompt: this.prompt,
            });
            return;
          }
        } else if (this.state === 'error') {
          if (byte === 0x72 || byte === 0x52) {
            // 'r' or 'R' - retry
            this.state = 'input';
            this.errorMessage = '';
            this.render();
          }
        }
      };

      this.stream.on('data', onData);
    });
  }

  private async startGeneration(): Promise<void> {
    // Guard against multiple simultaneous generation attempts
    if (this.isGenerating) return;
    this.isGenerating = true;

    this.state = 'generating';
    this.startSpinner();
    this.render();

    try {
      if (!this.providerConfig.apiKey) {
        throw new Error('API key not configured');
      }
      // Use image-based generation for better quality sprites
      // Wrap with timeout to prevent hung generations from blocking the server
      const result = await Promise.race([
        generateImageSprite({
          description: this.prompt,
          apiKey: this.providerConfig.apiKey,
          username: this.username,
          onProgress: (step, current, total) => {
            this.progressStep = step;
            this.progressCurrent = current;
            this.progressTotal = total;
            this.renderGeneratingState();
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Generation timed out after 2 minutes')), GENERATION_TIMEOUT)
        ),
      ]);

      if (result.success && result.sprite) {
        this.sprite = result.sprite;
        this.state = 'preview';
        console.log('[AVATAR] Generation complete, state set to preview');
      } else {
        this.errorMessage = result.error || 'Unknown error occurred';
        this.state = 'error';
        console.log('[AVATAR] Generation failed, state set to error:', this.errorMessage);
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.state = 'error';
      console.log('[AVATAR] Generation exception, state set to error:', this.errorMessage);
    } finally {
      // Always stop spinner and reset generation flag
      this.stopSpinner();
      this.isGenerating = false;
    }

    console.log('[AVATAR] Calling render() with state:', this.state);
    this.render();
  }

  protected renderSpinnerOnly(): void {
    // Just update the spinner character
    this.stream.write(
      this.ansi
        .moveTo(30, 13)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write(this.getSpinnerChar())
        .resetAttributes()
        .build()
    );
  }

  private render(): void {
    // Clear and redraw with brand dark background
    // IMPORTANT: Enforces Maldoror dark theme - no system override
    this.stream.write(
      this.ansi
        .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
        .clearScreen()
        .moveTo(0, 0)
        .build()
    );
    this.fillBackground();

    // Draw box border
    this.drawModalBox();

    switch (this.state) {
      case 'input':
        this.renderInputState();
        break;
      case 'generating':
        this.renderGeneratingState();
        break;
      case 'preview':
        this.renderPreviewState();
        break;
      case 'error':
        this.renderErrorState();
        break;
    }
  }

  private drawModalBox(): void {
    super.drawBox({
      width: 60,
      height: 22,
      startX: 5,
      startY: 2,
      title: 'REGENERATE AVATAR',
      borderColor: [100, 80, 180],
      titleColor: [180, 100, 255],
    });
  }

  private renderInputState(): void {
    const x = 8;

    // Input text (truncate if too long) - calculate early for cursor positioning
    const displayText = this.inputBuffer.length > 50
      ? this.inputBuffer.slice(-50)
      : this.inputBuffer;

    // Instructions
    this.stream.write(
      this.ansi
        .moveTo(x, 5)
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write('Describe your character\'s appearance:')
        .resetAttributes()
        .build()
    );

    // Input box
    this.stream.write(
      this.ansi
        .moveTo(x, 7)
        .setForeground({ type: 'rgb', value: [80, 80, 100] })
        .write('┌' + '─'.repeat(52) + '┐')
        .moveTo(x, 8)
        .write('│')
        .moveTo(x + 53, 8)
        .write('│')
        .moveTo(x, 9)
        .write('└' + '─'.repeat(52) + '┘')
        .resetAttributes()
        .build()
    );

    // Clear the input area first, then write text
    this.stream.write(
      this.ansi
        .moveTo(x + 2, 8)
        .write(' '.repeat(50)) // Clear the line
        .moveTo(x + 2, 8)
        .setForeground({ type: 'rgb', value: [255, 255, 255] })
        .write(displayText)
        .resetAttributes()
        .build()
    );

    // Help text
    this.stream.write(
      this.ansi
        .moveTo(x, 12)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write('Examples:')
        .moveTo(x, 13)
        .write('  - A gaunt figure with hollow eyes and tattered robes')
        .moveTo(x, 14)
        .write('  - A pale aristocrat with silver hair and dark armor')
        .moveTo(x, 15)
        .write('  - A creature of shadow with many eyes')
        .resetAttributes()
        .build()
    );

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, 20)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('[Enter]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Generate  ')
        .setForeground({ type: 'rgb', value: [200, 100, 100] })
        .write('[Esc]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Cancel')
        .resetAttributes()
        .build()
    );

    // Position cursor at end of input text
    const cursorX = x + 2 + displayText.length;
    this.stream.write(
      this.ansi
        .moveTo(cursorX, 8)
        .showCursor()
        .build()
    );
  }

  /**
   * Update only the input text line - minimal update to prevent flicker
   */
  private renderInputOnly(): void {
    const x = 8;
    const displayText = this.inputBuffer.length > 50
      ? this.inputBuffer.slice(-50)
      : this.inputBuffer;
    const padded = displayText.padEnd(50, ' ');

    // Single write: move to position, set colors, write padded text, position cursor
    // Uses brand dark background
    this.stream.write(
      `\x1b[9;${x + 3}H\x1b[48;2;${BG_PRIMARY.r};${BG_PRIMARY.g};${BG_PRIMARY.b}m\x1b[38;2;255;255;255m${padded}\x1b[9;${x + 3 + displayText.length}H`
    );
  }

  private renderGeneratingState(): void {
    const x = 8;

    // Progress header
    const progressText = this.progressCurrent > 0
      ? `Generating avatar [${this.progressCurrent}/${this.progressTotal}]`
      : 'Generating your avatar...';

    this.stream.write(
      this.ansi
        .moveTo(x, 6)
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(progressText + ' '.repeat(30))
        .build()
    );

    // Current step
    if (this.progressStep) {
      this.stream.write(
        this.ansi
          .moveTo(x, 8)
          .setForeground({ type: 'rgb', value: [255, 200, 100] })
          .write(this.progressStep + ' '.repeat(40))
          .build()
      );
    }

    // Progress bar
    const barWidth = 40;
    const filled = Math.floor((this.progressCurrent / this.progressTotal) * barWidth);
    const progressBar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    this.stream.write(
      this.ansi
        .moveTo(x, 10)
        .setForeground({ type: 'rgb', value: [100, 180, 100] })
        .write('[')
        .write(progressBar)
        .write(']')
        .resetAttributes()
        .build()
    );

    // Prompt display
    const truncatedPrompt = this.prompt.length > 45
      ? this.prompt.slice(0, 42) + '...'
      : this.prompt;

    this.stream.write(
      this.ansi
        .moveTo(x, 13)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write(`"${truncatedPrompt}"`)
        .build()
    );

    // Spinner
    this.stream.write(
      this.ansi
        .moveTo(x, 15)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write(this.getSpinnerChar())
        .resetAttributes()
        .hideCursor()
        .build()
    );

    this.stream.write(
      this.ansi
        .moveTo(x, 17)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write('Generating 8 frames (4 directions x 2 poses)...')
        .resetAttributes()
        .build()
    );
  }

  private renderPreviewState(): void {
    const x = 8;

    this.stream.write(
      this.ansi
        .moveTo(x, 4)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('Avatar generated!')
        .resetAttributes()
        .build()
    );

    // Render sprite preview
    if (this.sprite) {
      this.renderSpritePreview(x, 6);
    }

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, 20)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('[Enter]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Confirm  ')
        .setForeground({ type: 'rgb', value: [200, 100, 100] })
        .write('[Esc]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Cancel')
        .resetAttributes()
        .hideCursor()
        .build()
    );
  }

  private renderSpritePreview(startX: number, startY: number): void {
    if (!this.sprite) return;

    // Render all 4 directions side by side
    const directions: Array<'down' | 'left' | 'right' | 'up'> = ['down', 'left', 'right', 'up'];
    const labels = ['Front', 'Left', 'Right', 'Back'];

    for (let d = 0; d < directions.length; d++) {
      const dir = directions[d]!;
      const frame = this.sprite.frames[dir][0]; // Standing frame
      const xOffset = startX + d * 20;

      // Label
      this.stream.write(
        this.ansi
          .moveTo(xOffset + 2, startY)
          .setForeground({ type: 'rgb', value: [150, 150, 150] })
          .write(labels[d]!)
          .resetAttributes()
          .build()
      );

      // Render sprite using half-block (12 terminal rows for 24 pixel rows)
      const lines = renderHalfBlockGrid(frame);
      for (let i = 0; i < lines.length; i++) {
        this.stream.write(
          this.ansi
            .moveTo(xOffset, startY + 1 + i)
            .build()
        );
        this.stream.write(lines[i]!);
      }
    }
  }

  private renderErrorState(): void {
    const x = 8;

    this.stream.write(
      this.ansi
        .moveTo(x, 10)
        .setForeground({ type: 'rgb', value: [255, 100, 100] })
        .write('Generation failed')
        .resetAttributes()
        .build()
    );

    // Error message (truncate if too long)
    const errorLines = this.wrapText(this.errorMessage, 50);
    for (let i = 0; i < Math.min(errorLines.length, 3); i++) {
      this.stream.write(
        this.ansi
          .moveTo(x, 12 + i)
          .setForeground({ type: 'rgb', value: [180, 100, 100] })
          .write(errorLines[i]!)
          .resetAttributes()
          .build()
      );
    }

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, 20)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write('[R]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Retry  ')
        .setForeground({ type: 'rgb', value: [200, 100, 100] })
        .write('[Esc]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Cancel')
        .resetAttributes()
        .hideCursor()
        .build()
    );
  }

}
