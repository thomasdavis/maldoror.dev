import type { Duplex } from 'stream';
import type { Sprite } from '@maldoror/protocol';
import { ANSIBuilder, renderHalfBlockGrid } from '@maldoror/render';
import { generateImageSprite, type ProviderConfig } from '@maldoror/ai';

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const SPINNER_INTERVAL = 200;

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

type ScreenState = 'input' | 'generating' | 'preview' | 'error';

/**
 * Modal screen for avatar regeneration
 */
export class AvatarScreen {
  private stream: Duplex;
  private ansi: ANSIBuilder;
  private state: ScreenState = 'input';
  private prompt: string;
  private sprite: Sprite | null = null;
  private errorMessage: string = '';
  private spinnerFrame: number = 0;
  private spinnerInterval: NodeJS.Timeout | null = null;
  private providerConfig: ProviderConfig;
  private inputBuffer: string = '';
  private destroyed: boolean = false;
  private username: string;
  private progressStep: string = '';
  private progressCurrent: number = 0;
  private progressTotal: number = 8;

  constructor(config: AvatarScreenConfig) {
    this.stream = config.stream;
    this.ansi = new ANSIBuilder();
    this.prompt = config.currentPrompt ?? '';
    this.inputBuffer = this.prompt;
    this.providerConfig = config.providerConfig;
    this.username = config.username ?? 'unknown';
  }

  async run(): Promise<AvatarScreenResult> {
    // Enter alternate screen and setup with dark background
    this.stream.write(
      this.ansi
        .enterAlternateScreen()
        .hideCursor()
        .setBackground({ type: 'rgb', value: [20, 20, 25] })
        .clearScreen()
        .build()
    );

    // Fill entire screen with background color
    this.fillBackground();

    this.render();

    return new Promise((resolve) => {
      const onData = async (data: Buffer) => {
        if (this.destroyed) return;

        for (const byte of data) {
          // Handle Escape key
          if (byte === 0x1b && data.length === 1) {
            this.cleanup();
            this.stream.removeListener('data', onData);
            resolve({ action: 'cancel' });
            return;
          }

          // Handle Ctrl+C
          if (byte === 0x03) {
            this.cleanup();
            this.stream.removeListener('data', onData);
            resolve({ action: 'cancel' });
            return;
          }

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
                this.render();
              }
            } else if (byte >= 0x20 && byte < 0x7f) {
              // Printable character
              if (this.inputBuffer.length < 200) {
                this.inputBuffer += String.fromCharCode(byte);
                this.render();
              }
            }
          } else if (this.state === 'preview') {
            if (byte === 0x0d || byte === 0x0a) {
              // Enter - confirm
              this.cleanup();
              this.stream.removeListener('data', onData);
              resolve({
                action: 'confirm',
                sprite: this.sprite!,
                prompt: this.prompt,
              });
              return;
            } else if (byte === 0x72 || byte === 0x52) {
              // 'r' or 'R' - regenerate
              this.state = 'input';
              this.sprite = null;
              this.render();
            }
          } else if (this.state === 'error') {
            if (byte === 0x72 || byte === 0x52) {
              // 'r' or 'R' - retry
              this.state = 'input';
              this.errorMessage = '';
              this.render();
            }
          }
        }
      };

      this.stream.on('data', onData);
    });
  }

  private async startGeneration(): Promise<void> {
    this.state = 'generating';
    this.startSpinner();
    this.render();

    try {
      if (!this.providerConfig.apiKey) {
        throw new Error('API key not configured');
      }
      // Use image-based generation for better quality sprites
      const result = await generateImageSprite({
        description: this.prompt,
        apiKey: this.providerConfig.apiKey,
        username: this.username,
        onProgress: (step, current, total) => {
          this.progressStep = step;
          this.progressCurrent = current;
          this.progressTotal = total;
          this.renderGeneratingState();
        },
      });

      this.stopSpinner();

      if (result.success && result.sprite) {
        this.sprite = result.sprite;
        this.state = 'preview';
      } else {
        this.errorMessage = result.error || 'Unknown error occurred';
        this.state = 'error';
      }
    } catch (error) {
      this.stopSpinner();
      this.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.state = 'error';
    }

    this.render();
  }

  private startSpinner(): void {
    this.spinnerFrame = 0;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (this.state === 'generating') {
        this.renderSpinnerOnly();
      }
    }, SPINNER_INTERVAL);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  private renderSpinnerOnly(): void {
    // Just update the spinner character
    this.stream.write(
      this.ansi
        .moveTo(30, 13)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write(SPINNER_FRAMES[this.spinnerFrame]!)
        .resetAttributes()
        .build()
    );
  }

  private fillBackground(): void {
    // Write background color to ensure it covers the entire terminal
    this.stream.write(
      this.ansi
        .setBackground({ type: 'rgb', value: [20, 20, 25] })
        .build()
    );
    // Fill visible area with spaces to ensure background color is set
    for (let y = 0; y < 30; y++) {
      this.stream.write(
        this.ansi
          .moveTo(0, y)
          .write(' '.repeat(100))
          .build()
      );
    }
  }

  private render(): void {
    // Clear and redraw with dark background
    this.stream.write(
      this.ansi
        .setBackground({ type: 'rgb', value: [20, 20, 25] })
        .clearScreen()
        .moveTo(0, 0)
        .build()
    );
    this.fillBackground();

    // Draw box border
    this.drawBox();

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

  private drawBox(): void {
    const boxWidth = 60;
    const boxHeight = 22;
    const startX = 5;
    const startY = 2;

    // Top border
    this.stream.write(
      this.ansi
        .moveTo(startX, startY)
        .setForeground({ type: 'rgb', value: [100, 80, 180] })
        .write('╔' + '═'.repeat(boxWidth - 2) + '╗')
        .build()
    );

    // Sides
    for (let y = 1; y < boxHeight - 1; y++) {
      this.stream.write(
        this.ansi
          .moveTo(startX, startY + y)
          .write('║')
          .moveTo(startX + boxWidth - 1, startY + y)
          .write('║')
          .build()
      );
    }

    // Bottom border
    this.stream.write(
      this.ansi
        .moveTo(startX, startY + boxHeight - 1)
        .write('╚' + '═'.repeat(boxWidth - 2) + '╝')
        .resetAttributes()
        .build()
    );

    // Title
    const title = ' REGENERATE AVATAR ';
    const titleX = startX + Math.floor((boxWidth - title.length) / 2);
    this.stream.write(
      this.ansi
        .moveTo(titleX, startY)
        .setForeground({ type: 'rgb', value: [180, 100, 255] })
        .write(title)
        .resetAttributes()
        .build()
    );
  }

  private renderInputState(): void {
    const x = 8;

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

    // Input text (truncate if too long)
    const displayText = this.inputBuffer.length > 50
      ? this.inputBuffer.slice(-50)
      : this.inputBuffer;

    // Clear the input area first, then write text
    this.stream.write(
      this.ansi
        .moveTo(x + 2, 8)
        .write(' '.repeat(50)) // Clear the line
        .moveTo(x + 2, 8)
        .setForeground({ type: 'rgb', value: [255, 255, 255] })
        .write(displayText)
        .showCursor()
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
        .write(SPINNER_FRAMES[this.spinnerFrame]!)
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
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write('[R]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Regenerate  ')
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

  private wrapText(text: string, maxWidth: number): string[] {
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

  private cleanup(): void {
    this.destroyed = true;
    this.stopSpinner();

    // Exit alternate screen
    this.stream.write(
      this.ansi
        .exitAlternateScreen()
        .showCursor()
        .resetAttributes()
        .build()
    );
  }
}
