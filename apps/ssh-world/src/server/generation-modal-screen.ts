import type { Duplex } from 'stream';
import { BG_PRIMARY } from '@maldoror/render';
import { BaseModalScreen } from './base-modal-screen.js';

const GENERATION_TIMEOUT = 1200000; // 20 minutes

/**
 * RGB color tuple
 */
export type RGB = [number, number, number];

/**
 * Configuration for the generation modal
 */
export interface GenerationModalConfig {
  title: string;
  boxWidth: number;
  boxHeight: number;
  startX: number;
  startY: number;
  borderColor: RGB;
  titleColor: RGB;
  inputPromptText: string;
  examples: string[];
  maxInputLength: number;
  progressTotal: number;
  generatingMessage: string;
}

/**
 * Result from a generation modal
 */
export interface GenerationResult<T> {
  action: 'confirm' | 'cancel';
  result?: T;
  prompt?: string;
}

/**
 * Generation function result (from AI generation)
 */
export interface GenerationOutput<T> {
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * Progress callback signature
 */
export type ProgressCallback = (step: string, current: number, total: number) => void;

/**
 * Abstract base class for generation modals (avatar, building, NPC)
 * Handles common patterns: input, progress, preview, error states
 */
export abstract class GenerationModalScreen<T> extends BaseModalScreen {
  protected prompt: string = '';
  protected generatedResult: T | null = null;
  private dataListener: ((data: Buffer) => void) | null = null;
  private resolvePromise: ((result: GenerationResult<T>) => void) | null = null;

  constructor(stream: Duplex) {
    super(stream);
  }

  /**
   * Get the configuration for this modal
   */
  protected abstract getConfig(): GenerationModalConfig;

  /**
   * Run the generation with the given prompt
   */
  protected abstract generate(prompt: string, onProgress: ProgressCallback): Promise<GenerationOutput<T>>;

  /**
   * Render the preview of the generated result
   */
  protected abstract renderPreview(): void;

  /**
   * Get additional info to show in input state (optional)
   */
  protected getAdditionalInputInfo(): string[] {
    return [];
  }

  /**
   * Get the confirm button text
   */
  protected getConfirmButtonText(): string {
    return 'Confirm';
  }

  /**
   * Run the modal and return the result
   */
  async run(): Promise<GenerationResult<T>> {
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
        const config = this.getConfig();

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
            if (this.inputBuffer.length < config.maxInputLength) {
              this.inputBuffer += String.fromCharCode(byte);
              this.renderInputOnly();
            }
          }
        } else if (this.state === 'preview') {
          if (byte === 0x0d || byte === 0x0a) {
            // Enter - confirm
            this.finish({
              action: 'confirm',
              result: this.generatedResult!,
              prompt: this.prompt,
            });
            return;
          }
        }
      };

      this.stream.on('data', this.dataListener);
    });
  }

  /**
   * Clean finish - remove only our listener and resolve
   */
  protected finish(result: GenerationResult<T>): void {
    if (this.dataListener) {
      this.stream.removeListener('data', this.dataListener);
      this.dataListener = null;
    }
    this.cleanup();
    this.resolvePromise?.(result);
    this.resolvePromise = null;
  }

  /**
   * Start the generation process
   */
  private async startGeneration(): Promise<void> {
    if (this.isGenerating) return;
    this.isGenerating = true;

    const config = this.getConfig();
    const startTime = Date.now();

    this.state = 'generating';
    this.progressTotal = config.progressTotal;
    this.startSpinner();
    this.render();

    try {
      const output = await Promise.race([
        this.generate(this.prompt, (step, current, total) => {
          this.progressStep = step;
          this.progressCurrent = current;
          this.progressTotal = total;
          this.renderGeneratingState();
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Generation timed out after 20 minutes')), GENERATION_TIMEOUT)
        ),
      ]);

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (output.success && output.result) {
        this.generatedResult = output.result;
        this.state = 'preview';
        console.log(`[${config.title}] Generation complete in ${elapsed}s`);
        this.stopSpinner();
        this.isGenerating = false;
        this.render();
      } else {
        const errorMsg = output.error || 'Unknown error occurred';
        console.log(`[${config.title}] Generation failed after ${elapsed}s:`, errorMsg);
        this.stopSpinner();
        this.isGenerating = false;
        this.finish({ action: 'cancel' });
      }
    } catch (error) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`[${config.title}] Generation exception after ${elapsed}s:`, errorMsg);
      this.stopSpinner();
      this.isGenerating = false;
      this.finish({ action: 'cancel' });
    }
  }

  protected renderSpinnerOnly(): void {
    const config = this.getConfig();
    const spinnerX = config.startX + Math.floor(config.boxWidth / 2);
    this.stream.write(
      this.ansi
        .moveTo(spinnerX, config.startY + 12)
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

  private drawModalBox(): void {
    const config = this.getConfig();
    super.drawBox({
      width: config.boxWidth,
      height: config.boxHeight,
      startX: config.startX,
      startY: config.startY,
      title: config.title,
      borderColor: config.borderColor,
      titleColor: config.titleColor,
    });
  }

  private clearModalContent(): void {
    const config = this.getConfig();
    const contentWidth = config.boxWidth - 4;
    for (let y = config.startY + 1; y < config.startY + config.boxHeight - 1; y++) {
      this.stream.write(
        this.ansi
          .moveTo(config.startX + 2, y)
          .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
          .write(' '.repeat(contentWidth))
          .build()
      );
    }
  }

  private renderInputState(): void {
    const config = this.getConfig();
    const x = config.startX + 3;
    const inputWidth = config.boxWidth - 10;

    const displayText = this.inputBuffer.length > inputWidth - 5
      ? this.inputBuffer.slice(-(inputWidth - 5))
      : this.inputBuffer;

    // Instructions
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 3)
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(config.inputPromptText)
        .resetAttributes()
        .build()
    );

    // Input box
    const inputBoxWidth = inputWidth;
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 5)
        .setForeground({ type: 'rgb', value: [80, 80, 100] })
        .write('┌' + '─'.repeat(inputBoxWidth) + '┐')
        .moveTo(x, config.startY + 6)
        .write('│')
        .moveTo(x + inputBoxWidth + 1, config.startY + 6)
        .write('│')
        .moveTo(x, config.startY + 7)
        .write('└' + '─'.repeat(inputBoxWidth) + '┘')
        .resetAttributes()
        .build()
    );

    // Input text
    this.stream.write(
      this.ansi
        .moveTo(x + 2, config.startY + 6)
        .write(' '.repeat(inputBoxWidth - 2))
        .moveTo(x + 2, config.startY + 6)
        .setForeground({ type: 'rgb', value: [255, 255, 255] })
        .write(displayText)
        .resetAttributes()
        .build()
    );

    // Examples
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 10)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write('Examples:')
        .build()
    );

    for (let i = 0; i < config.examples.length; i++) {
      this.stream.write(
        this.ansi
          .moveTo(x, config.startY + 11 + i)
          .setForeground({ type: 'rgb', value: [100, 100, 120] })
          .write(`  - ${config.examples[i]}`)
          .build()
      );
    }

    // Additional info
    const additionalInfo = this.getAdditionalInputInfo();
    const infoStartY = config.startY + 11 + config.examples.length + 1;
    for (let i = 0; i < additionalInfo.length; i++) {
      this.stream.write(
        this.ansi
          .moveTo(x, infoStartY + i)
          .setForeground({ type: 'rgb', value: [150, 150, 100] })
          .write(additionalInfo[i]!)
          .build()
      );
    }

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + config.boxHeight - 3)
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
        .moveTo(cursorX, config.startY + 6)
        .showCursor()
        .build()
    );
  }

  private renderInputOnly(): void {
    const config = this.getConfig();
    const x = config.startX + 3;
    const inputWidth = config.boxWidth - 10;

    const displayText = this.inputBuffer.length > inputWidth - 5
      ? this.inputBuffer.slice(-(inputWidth - 5))
      : this.inputBuffer;
    const padded = displayText.padEnd(inputWidth - 2, ' ');

    this.stream.write(
      `\x1b[${config.startY + 7};${x + 3}H\x1b[48;2;${BG_PRIMARY.r};${BG_PRIMARY.g};${BG_PRIMARY.b}m\x1b[38;2;255;255;255m${padded}\x1b[${config.startY + 7};${x + 3 + displayText.length}H`
    );
  }

  protected renderGeneratingState(): void {
    const config = this.getConfig();
    const x = config.startX + 3;

    const progressText = this.progressCurrent > 0
      ? `Generating [${this.progressCurrent}/${this.progressTotal}]`
      : 'Generating...';

    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 4)
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(progressText + ' '.repeat(30))
        .build()
    );

    if (this.progressStep) {
      this.stream.write(
        this.ansi
          .moveTo(x, config.startY + 6)
          .setForeground({ type: 'rgb', value: [255, 200, 100] })
          .write(this.progressStep + ' '.repeat(40))
          .build()
      );
    }

    // Progress bar
    const barWidth = Math.min(config.boxWidth - 12, 50);
    const filled = Math.floor((this.progressCurrent / this.progressTotal) * barWidth);
    const progressBar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 8)
        .setForeground({ type: 'rgb', value: [100, 180, 100] })
        .write('[')
        .write(progressBar)
        .write(']')
        .resetAttributes()
        .build()
    );

    // Prompt display
    const maxPromptLen = config.boxWidth - 15;
    const truncatedPrompt = this.prompt.length > maxPromptLen
      ? this.prompt.slice(0, maxPromptLen - 3) + '...'
      : this.prompt;

    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 11)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write(`"${truncatedPrompt}"`)
        .build()
    );

    // Spinner
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 13)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write(this.getSpinnerChar())
        .resetAttributes()
        .hideCursor()
        .build()
    );

    // Generating message
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 15)
        .setForeground({ type: 'rgb', value: [100, 100, 120] })
        .write(config.generatingMessage)
        .resetAttributes()
        .build()
    );
  }

  private renderPreviewState(): void {
    const config = this.getConfig();
    const x = config.startX + 3;

    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 2)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('Generated successfully!')
        .resetAttributes()
        .build()
    );

    // Call abstract preview rendering
    this.renderPreview();

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + config.boxHeight - 3)
        .setForeground({ type: 'rgb', value: [100, 200, 100] })
        .write('[Enter]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(` ${this.getConfirmButtonText()}  `)
        .setForeground({ type: 'rgb', value: [200, 100, 100] })
        .write('[Esc]')
        .setForeground({ type: 'rgb', value: [180, 180, 180] })
        .write(' Cancel')
        .resetAttributes()
        .hideCursor()
        .build()
    );
  }

  private renderErrorState(): void {
    const config = this.getConfig();
    const x = config.startX + 3;

    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + 8)
        .setForeground({ type: 'rgb', value: [255, 100, 100] })
        .write('Generation failed')
        .resetAttributes()
        .build()
    );

    const errorLines = this.wrapText(this.errorMessage, config.boxWidth - 10);
    for (let i = 0; i < Math.min(errorLines.length, 3); i++) {
      this.stream.write(
        this.ansi
          .moveTo(x, config.startY + 10 + i)
          .setForeground({ type: 'rgb', value: [180, 100, 100] })
          .write(errorLines[i]!)
          .resetAttributes()
          .build()
      );
    }

    // Controls
    this.stream.write(
      this.ansi
        .moveTo(x, config.startY + config.boxHeight - 3)
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
