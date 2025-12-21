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

/**
 * NPC creation result with sprite and metadata
 */
export interface NPCCreationData {
  sprite: Sprite;
  name: string;
  prompt: string;
}

export type NPCScreenResult = GenerationResult<NPCCreationData>;

interface NPCScreenConfig {
  stream: Duplex;
  providerConfig: ProviderConfig;
  username?: string;
  playerX: number;
  playerY: number;
}

/**
 * Modal screen for NPC creation
 * Uses AI to generate NPC character sprites
 */
export class NPCScreen extends GenerationModalScreen<NPCCreationData> {
  private providerConfig: ProviderConfig;
  private username: string;
  private playerX: number;
  private playerY: number;

  constructor(config: NPCScreenConfig) {
    super(config.stream);
    this.providerConfig = config.providerConfig;
    this.username = config.username ?? 'unknown';
    this.playerX = config.playerX;
    this.playerY = config.playerY;
  }

  protected getConfig(): GenerationModalConfig {
    return {
      title: 'CREATE NPC',
      boxWidth: 65,
      boxHeight: 22,
      startX: 4,
      startY: 2,
      borderColor: [150, 100, 80],
      titleColor: [255, 180, 100],
      inputPromptText: 'Describe the NPC character you want to create:',
      examples: [
        'A wise old sage with a long white beard',
        'A mischievous fairy with glowing wings',
        'A friendly orange tabby cat',
        'A shadowy merchant in dark robes',
      ],
      maxInputLength: 200,
      progressTotal: 8,
      generatingMessage: 'Generating NPC sprite (4 directions x 2 poses)...',
    };
  }

  protected getAdditionalInputInfo(): string[] {
    return [
      `NPC will spawn at (${this.playerX}, ${this.playerY})`,
      'The NPC will roam within a 30×30 tile area',
    ];
  }

  protected async generate(prompt: string, onProgress: ProgressCallback): Promise<GenerationOutput<NPCCreationData>> {
    if (!this.providerConfig.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    resourceMonitor.startOperation('NPC_GENERATE');
    try {
      const result = await generateImageSprite({
        description: prompt,
        apiKey: this.providerConfig.apiKey,
        username: this.username,
        onProgress,
      });

      if (result.success && result.sprite) {
        // Extract a short name from the prompt (first 3-4 words, capitalized)
        const words = prompt.split(' ').slice(0, 4);
        const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

        return {
          success: true,
          result: {
            sprite: result.sprite,
            name: name.slice(0, 32), // Max 32 chars for name
            prompt,
          },
        };
      } else {
        return { success: false, error: result.error };
      }
    } finally {
      resourceMonitor.endOperation('NPC_GENERATE');
    }
  }

  protected renderPreview(): void {
    if (!this.generatedResult || !this.generatedResult.sprite) return;

    const config = this.getConfig();
    const startX = config.startX + 3;
    const startY = config.startY + 4;

    // Show NPC name
    this.stream.write(
      this.ansi
        .moveTo(startX, startY)
        .setForeground({ type: 'rgb', value: [255, 200, 100] })
        .write(`Name: ${this.generatedResult.name}`)
        .resetAttributes()
        .build()
    );

    // Render all 4 directions side by side
    const directions: Array<'down' | 'left' | 'right' | 'up'> = ['down', 'left', 'right', 'up'];
    const labels = ['Front', 'Left', 'Right', 'Back'];
    const sprite = this.generatedResult.sprite;

    for (let d = 0; d < directions.length; d++) {
      const dir = directions[d]!;
      const frame = sprite.frames[dir][0]; // Standing frame
      const xOffset = startX + d * 14;

      // Label
      this.stream.write(
        this.ansi
          .moveTo(xOffset + 2, startY + 2)
          .setForeground({ type: 'rgb', value: [150, 150, 150] })
          .write(labels[d]!)
          .resetAttributes()
          .build()
      );

      // Render sprite using half-block
      const lines = renderHalfBlockGrid(frame);
      for (let i = 0; i < lines.length; i++) {
        this.stream.write(
          this.ansi
            .moveTo(xOffset, startY + 3 + i)
            .build()
        );
        this.stream.write(lines[i]!);
      }
    }

    // Spawn info
    this.stream.write(
      this.ansi
        .moveTo(startX, config.startY + 17)
        .setForeground({ type: 'rgb', value: [150, 150, 100] })
        .write(`Will spawn at (${this.playerX}, ${this.playerY}) and roam nearby`)
        .resetAttributes()
        .build()
    );
  }

  protected getConfirmButtonText(): string {
    return 'Create NPC';
  }
}
