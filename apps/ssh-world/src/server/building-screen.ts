import type { Duplex } from 'stream';
import { renderHalfBlockGrid } from '@maldoror/render';
import { generateBuildingSprite, type ProviderConfig, type DirectionalBuildingSprite } from '@maldoror/ai';
import {
  GenerationModalScreen,
  type GenerationModalConfig,
  type GenerationOutput,
  type ProgressCallback,
  type GenerationResult,
} from './generation-modal-screen.js';
import { resourceMonitor } from '../utils/resource-monitor.js';

export type BuildingScreenResult = GenerationResult<DirectionalBuildingSprite>;

interface BuildingScreenConfig {
  stream: Duplex;
  providerConfig: ProviderConfig;
  username?: string;
  playerX: number;
  playerY: number;
}

/**
 * Modal screen for building placement
 * Uses AI to generate 3x3 tile building sprites with 4 directional views
 */
export class BuildingScreen extends GenerationModalScreen<DirectionalBuildingSprite> {
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
  }

  protected getConfig(): GenerationModalConfig {
    return {
      title: 'BUILD STRUCTURE',
      boxWidth: 70,
      boxHeight: 24,
      startX: 3,
      startY: 1,
      borderColor: [100, 150, 80],
      titleColor: [150, 200, 100],
      inputPromptText: 'Describe the building or structure you want to create:',
      examples: [
        'A medieval stone tower with a pointed roof',
        'A small wooden cabin with a chimney',
        'An ancient temple with pillars and stairs',
        'A futuristic metal structure with glowing panels',
      ],
      maxInputLength: 200,
      progressTotal: 3,
      generatingMessage: 'Generating 3×3 tile building...',
    };
  }

  protected getAdditionalInputInfo(): string[] {
    const anchorX = this.playerX;
    const anchorY = this.playerY - 1;
    return [
      `Building will be placed at (${anchorX - 1} to ${anchorX + 1}, ${anchorY - 2} to ${anchorY})`,
      'Size: 3×3 tiles, directly above your character',
    ];
  }

  protected async generate(prompt: string, onProgress: ProgressCallback): Promise<GenerationOutput<DirectionalBuildingSprite>> {
    if (!this.providerConfig.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    resourceMonitor.startOperation('BUILDING_GENERATE');
    try {
      const result = await generateBuildingSprite({
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
      resourceMonitor.endOperation('BUILDING_GENERATE');
    }
  }

  protected renderPreview(): void {
    if (!this.generatedResult) return;

    const config = this.getConfig();
    const startX = config.startX + 13;
    const startY = config.startY + 4;

    // Use 'north' direction for preview (camera at 0° rotation)
    const northSprite = this.generatedResult.north;

    // Render 3×3 grid of tiles
    const previewRes = '51';

    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        const tile = northSprite.tiles[ty]?.[tx];
        if (!tile) continue;

        // Use the pre-computed resolution or fall back to base
        const pixels = tile.resolutions[previewRes] || tile.pixels;

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

    // Placement info
    const anchorX = this.playerX;
    const anchorY = this.playerY - 1;
    this.stream.write(
      this.ansi
        .moveTo(config.startX + 3, config.startY + 18)
        .setForeground({ type: 'rgb', value: [150, 150, 100] })
        .write(`Will be placed at (${anchorX}, ${anchorY}) - above your character`)
        .resetAttributes()
        .build()
    );
  }

  protected getConfirmButtonText(): string {
    return 'Place Building';
  }
}
