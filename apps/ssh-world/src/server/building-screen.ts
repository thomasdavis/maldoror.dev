import type { Duplex } from 'stream';
import { renderHalfBlockGrid, BG_PRIMARY } from '@maldoror/render';
import { generateBuildingSprite, type ProviderConfig, type DirectionalBuildingSprite } from '@maldoror/ai';
import { BaseModalScreen } from './base-modal-screen.js';

const GENERATION_TIMEOUT = 1200000; // 20 minutes

export interface BuildingScreenResult {
  action: 'confirm' | 'cancel';
  sprite?: DirectionalBuildingSprite;
  prompt?: string;
}

interface BuildingScreenConfig {
  stream: Duplex;
  providerConfig: ProviderConfig;
  username?: string;
  playerX: number;
  playerY: number;
}

/**
 * Modal screen for building placement
 */
export class BuildingScreen extends BaseModalScreen {
  private prompt: string = '';
  private sprite: DirectionalBuildingSprite | null = null;
  private providerConfig: ProviderConfig;
  private username: string;
  private playerX: number;
  private playerY: number;

  constructor(config: BuildingScreenConfig) {
    super(config.stream);
    this.providerConfig = config.providerConfig;
    this.username = config.username ?? 'unknown';
    this.playerX = config.playerX;
    this.playerY = config.playerY;
    this.progressTotal = 3;
  }

  private dataListener: ((data: Buffer) => void) | null = null;
  private resolvePromise: ((result: BuildingScreenResult) => void) | null = null;

  async run(): Promise<BuildingScreenResult> {
    this.enterScreen();
    this.render();

    return new Promise((resolve) => {
      this.resolvePromise = resolve;

      this.dataListener = async (data: Buffer) => {
        if (this.destroyed) return;

        // Skip escape sequences (arrow keys, etc)
        if (data[0] === 0x1b && data.length > 1) {
          return;
        }

        // Handle Escape key (single ESC byte)
        if (data[0] === 0x1b && data.length === 1) {
          this.finish({ action: 'cancel' });
          return;
        }

        // Handle Ctrl+C
        if (data[0] === 0x03) {
          this.finish({ action: 'cancel' });
          return;
        }

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
          if (byte === 0x0d || byte === 0x0a) {
            // Enter - confirm
            console.log('[BUILDING] Confirming building, prompt:', this.prompt);
            this.finish({
              action: 'confirm',
              sprite: this.sprite!,
              prompt: this.prompt,
            });
            return;
          }
        }
        // No retry on error - ESC/Ctrl+C already handled above for cancel
      };

      this.stream.on('data', this.dataListener);
    });
  }

  /**
   * Clean finish - remove only our listener and resolve
   */
  private finish(result: BuildingScreenResult): void {
    if (this.dataListener) {
      this.stream.removeListener('data', this.dataListener);
      this.dataListener = null;
    }
    this.cleanup();
    this.resolvePromise?.(result);
    this.resolvePromise = null;
  }

  private async startGeneration(): Promise<void> {
    if (this.isGenerating) return;
    this.isGenerating = true;

    console.log('[BUILDING] Starting generation for prompt:', this.prompt);
    const startTime = Date.now();

    this.state = 'generating';
    this.startSpinner();
    this.render();

    try {
      if (!this.providerConfig.apiKey) {
        throw new Error('API key not configured');
      }

      // Wrap with timeout to prevent hung generations from blocking the server
      const result = await Promise.race([
        generateBuildingSprite({
          description: this.prompt,
          apiKey: this.providerConfig.apiKey,
          username: this.username,
          onProgress: (step, current, total) => {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[BUILDING] Progress [${elapsed}s]: ${step} (${current}/${total})`);
            this.progressStep = step;
            this.progressCurrent = current;
            this.progressTotal = total;
            this.renderGeneratingState();
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Generation timed out after 20 minutes')), GENERATION_TIMEOUT)
        ),
      ]);

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (result.success && result.sprite) {
        this.sprite = result.sprite;
        this.state = 'preview';
        console.log(`[BUILDING] Generation complete in ${elapsed}s, state set to preview`);
        this.stopSpinner();
        this.isGenerating = false;
        this.render();
      } else {
        const errorMsg = result.error || 'Unknown error occurred';
        console.log(`[BUILDING] Generation failed after ${elapsed}s:`, errorMsg);
        this.stopSpinner();
        this.isGenerating = false;
        // Auto-cancel on error - return to game
        this.finish({ action: 'cancel' });
      }
    } catch (error) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`[BUILDING] Generation exception after ${elapsed}s:`, errorMsg);
      this.stopSpinner();
      this.isGenerating = false;
      // Auto-cancel on error - return to game
      this.finish({ action: 'cancel' });
    }
  }

  protected renderSpinnerOnly(): void {
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
    this.stream.write(
      this.ansi
        .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
        .clearScreen()
        .moveTo(0, 0)
        .build()
    );
    this.fillBackground();
    this.drawModalBox();

    // Clear the modal content area to prevent ghost content from previous states
    this.clearModalContent();

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

  /**
   * Clear the modal content area (inside the box borders)
   * This prevents ghost content from previous states
   */
  private clearModalContent(): void {
    const startX = 4;
    const contentWidth = 68;
    // Clear rows 2-23 (inside the modal box)
    for (let y = 2; y < 24; y++) {
      this.stream.write(
        this.ansi
          .moveTo(startX, y)
          .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
          .write(' '.repeat(contentWidth))
          .build()
      );
    }
  }

  private drawModalBox(): void {
    super.drawBox({
      width: 70,
      height: 24,
      startX: 3,
      startY: 1,
      title: 'BUILD STRUCTURE',
      borderColor: [100, 150, 80],
      titleColor: [150, 200, 100],
    });
  }

  private renderInputState(): void {
    const x = 6;

    const displayText = this.inputBuffer.length > 55
      ? this.inputBuffer.slice(-55)
      : this.inputBuffer;

    // Instructions
    this.stream.write(
      this.ansi
        .moveTo(x, 4)
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write('Describe the building or structure you want to create:')
        .resetAttributes()
        .build()
    );

    // Input box
    this.stream.write(
      this.ansi
        .moveTo(x, 6)
        .setForeground({ type: 'rgb', value: [80, 100, 80] })
        .write('┌' + '─'.repeat(60) + '┐')
        .moveTo(x, 7)
        .write('│')
        .moveTo(x + 61, 7)
        .write('│')
        .moveTo(x, 8)
        .write('└' + '─'.repeat(60) + '┘')
        .resetAttributes()
        .build()
    );

    // Input text
    this.stream.write(
      this.ansi
        .moveTo(x + 2, 7)
        .write(' '.repeat(58))
        .moveTo(x + 2, 7)
        .setForeground({ type: 'rgb', value: [255, 255, 255] })
        .write(displayText)
        .resetAttributes()
        .build()
    );

    // Help text
    this.stream.write(
      this.ansi
        .moveTo(x, 11)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write('Examples:')
        .moveTo(x, 12)
        .write('  - A medieval stone tower with a pointed roof')
        .moveTo(x, 13)
        .write('  - A small wooden cabin with a chimney')
        .moveTo(x, 14)
        .write('  - An ancient temple with pillars and stairs')
        .moveTo(x, 15)
        .write('  - A futuristic metal structure with glowing panels')
        .resetAttributes()
        .build()
    );

    // Placement info
    const anchorX = this.playerX;
    const anchorY = this.playerY - 1;
    this.stream.write(
      this.ansi
        .moveTo(x, 18)
        .setForeground({ type: 'rgb', value: [150, 150, 100] })
        .write(`Building will be placed at (${anchorX - 1} to ${anchorX + 1}, ${anchorY - 2} to ${anchorY})`)
        .moveTo(x, 19)
        .write('Size: 3×3 tiles, directly above your character')
        .resetAttributes()
        .build()
    );

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, 22)
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

    // Position cursor
    const cursorX = x + 2 + displayText.length;
    this.stream.write(
      this.ansi
        .moveTo(cursorX, 7)
        .showCursor()
        .build()
    );
  }

  private renderInputOnly(): void {
    const x = 6;
    const displayText = this.inputBuffer.length > 55
      ? this.inputBuffer.slice(-55)
      : this.inputBuffer;
    const padded = displayText.padEnd(58, ' ');

    this.stream.write(
      `\x1b[8;${x + 3}H\x1b[48;2;${BG_PRIMARY.r};${BG_PRIMARY.g};${BG_PRIMARY.b}m\x1b[38;2;255;255;255m${padded}\x1b[8;${x + 3 + displayText.length}H`
    );
  }

  private renderGeneratingState(): void {
    const x = 6;

    const progressText = this.progressCurrent > 0
      ? `Generating building [${this.progressCurrent}/${this.progressTotal}]`
      : 'Generating your building...';

    this.stream.write(
      this.ansi
        .moveTo(x, 5)
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(progressText + ' '.repeat(30))
        .build()
    );

    if (this.progressStep) {
      this.stream.write(
        this.ansi
          .moveTo(x, 7)
          .setForeground({ type: 'rgb', value: [255, 200, 100] })
          .write(this.progressStep + ' '.repeat(40))
          .build()
      );
    }

    // Progress bar
    const barWidth = 50;
    const filled = Math.floor((this.progressCurrent / this.progressTotal) * barWidth);
    const progressBar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    this.stream.write(
      this.ansi
        .moveTo(x, 9)
        .setForeground({ type: 'rgb', value: [100, 180, 100] })
        .write('[')
        .write(progressBar)
        .write(']')
        .resetAttributes()
        .build()
    );

    // Prompt display
    const truncatedPrompt = this.prompt.length > 55
      ? this.prompt.slice(0, 52) + '...'
      : this.prompt;

    this.stream.write(
      this.ansi
        .moveTo(x, 12)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write(`"${truncatedPrompt}"`)
        .build()
    );

    // Spinner
    this.stream.write(
      this.ansi
        .moveTo(x, 14)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write(this.getSpinnerChar())
        .resetAttributes()
        .hideCursor()
        .build()
    );

    this.stream.write(
      this.ansi
        .moveTo(x, 16)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write('Generating 3×3 tile building...')
        .resetAttributes()
        .build()
    );
  }

  private renderPreviewState(): void {
    const x = 6;

    this.stream.write(
      this.ansi
        .moveTo(x, 3)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('Building generated!')
        .resetAttributes()
        .build()
    );

    // Render building preview
    if (this.sprite) {
      this.renderBuildingPreview(x + 10, 5);
    }

    // Placement info
    const anchorX = this.playerX;
    const anchorY = this.playerY - 1;
    this.stream.write(
      this.ansi
        .moveTo(x, 19)
        .setForeground({ type: 'rgb', value: [150, 150, 100] })
        .write(`Will be placed at (${anchorX}, ${anchorY}) - above your character`)
        .resetAttributes()
        .build()
    );

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, 22)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('[Enter]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Place Building  ')
        .setForeground({ type: 'rgb', value: [200, 100, 100] })
        .write('[Esc]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Cancel')
        .resetAttributes()
        .hideCursor()
        .build()
    );
  }

  private renderBuildingPreview(startX: number, startY: number): void {
    if (!this.sprite) return;

    // Use 'north' direction for preview (camera at 0° rotation)
    const northSprite = this.sprite.north;

    // Render 3×3 grid of tiles
    // Use a smaller resolution for preview (26 or 51)
    const previewRes = '51';

    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        const tile = northSprite.tiles[ty]?.[tx];
        if (!tile) continue;

        // Use the pre-computed resolution or fall back to base
        const pixels = tile.resolutions[previewRes] || tile.pixels;

        // Each tile renders to a 13×13 character block (half-block = 2 rows per char)
        const lines = renderHalfBlockGrid(pixels);
        const offsetX = startX + tx * 14;
        const offsetY = startY + ty * Math.ceil(lines.length);

        for (let i = 0; i < lines.length; i++) {
          this.stream.write(
            this.ansi
              .moveTo(offsetX, offsetY + i)
              .build()
          );
          this.stream.write(lines[i]!);
        }
      }
    }
  }

  private renderErrorState(): void {
    const x = 6;

    this.stream.write(
      this.ansi
        .moveTo(x, 9)
        .setForeground({ type: 'rgb', value: [255, 100, 100] })
        .write('Generation failed')
        .resetAttributes()
        .build()
    );

    const errorLines = this.wrapText(this.errorMessage, 55);
    for (let i = 0; i < Math.min(errorLines.length, 3); i++) {
      this.stream.write(
        this.ansi
          .moveTo(x, 11 + i)
          .setForeground({ type: 'rgb', value: [180, 100, 100] })
          .write(errorLines[i]!)
          .resetAttributes()
          .build()
      );
    }

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, 22)
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
