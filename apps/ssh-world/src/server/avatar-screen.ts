import type { Duplex } from 'stream';
import type { Sprite } from '@maldoror/protocol';
import { renderHalfBlockGrid } from '@maldoror/render';
import { generateImageSprite, type ProviderConfig } from '@maldoror/ai';
import {
  GenerationModalScreen,
  type GenerationModalConfig,
  type GenerationOutput,
  type ProgressCallback,
  type GenerationResult,
} from './generation-modal-screen.js';
import { resourceMonitor } from '../utils/resource-monitor.js';

export type AvatarScreenResult = GenerationResult<Sprite>;

interface AvatarScreenConfig {
  stream: Duplex;
  currentPrompt?: string;
  providerConfig: ProviderConfig;
  username?: string;
}

/**
 * Modal screen for avatar regeneration
 * Uses AI to generate character sprites with 4 directions x 2 poses
 */
export class AvatarScreen extends GenerationModalScreen<Sprite> {
  private providerConfig: ProviderConfig;
  private username: string;

  constructor(config: AvatarScreenConfig) {
    super(config.stream);
    this.inputBuffer = ''; // Start with empty input
    this.providerConfig = config.providerConfig;
    this.username = config.username ?? 'unknown';
  }

  protected getConfig(): GenerationModalConfig {
    return {
      title: 'REGENERATE AVATAR',
      boxWidth: 60,
      boxHeight: 22,
      startX: 5,
      startY: 2,
      borderColor: [100, 80, 180],
      titleColor: [180, 100, 255],
      inputPromptText: "Describe your character's appearance:",
      examples: [
        'A gaunt figure with hollow eyes and tattered robes',
        'A pale aristocrat with silver hair and dark armor',
        'A creature of shadow with many eyes',
      ],
      maxInputLength: 200,
      progressTotal: 8,
      generatingMessage: 'Generating 8 frames (4 directions x 2 poses)...',
    };
  }

  protected async generate(prompt: string, onProgress: ProgressCallback): Promise<GenerationOutput<Sprite>> {
    if (!this.providerConfig.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    resourceMonitor.startOperation('AVATAR_GENERATE');
    try {
      const result = await generateImageSprite({
        description: prompt,
        apiKey: this.providerConfig.apiKey,
        username: this.username,
        onProgress,
      });

      if (result.success && result.sprite) {
        return { success: true, result: result.sprite };
      } else {
        return { success: false, error: result.error };
      }
    } finally {
      resourceMonitor.endOperation('AVATAR_GENERATE');
    }
  }

  protected renderPreview(): void {
    if (!this.generatedResult) return;

    const config = this.getConfig();
    const startX = config.startX + 3;
    const startY = config.startY + 4;

    // Render all 4 directions side by side
    const directions: Array<'down' | 'left' | 'right' | 'up'> = ['down', 'left', 'right', 'up'];
    const labels = ['Front', 'Left', 'Right', 'Back'];

    for (let d = 0; d < directions.length; d++) {
      const dir = directions[d]!;
      const frame = this.generatedResult.frames[dir][0]; // Standing frame
      const xOffset = startX + d * 14;

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

  protected getConfirmButtonText(): string {
    return 'Confirm';
  }
}
