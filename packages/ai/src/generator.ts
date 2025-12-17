import { generateObject } from 'ai';
import { createModel, type ProviderConfig } from './providers.js';
import { SpriteGridSchema, type SpriteGrid } from './schema.js';
import { AVATAR_SYSTEM_PROMPT, buildUserPrompt, type Vibe } from './prompts.js';

/**
 * Avatar generation options
 */
export interface AvatarGenerationOptions {
  description: string;
  vibe?: Vibe;
  providerConfig: ProviderConfig;
  maxRetries?: number;
}

/**
 * Generation result
 */
export interface GenerationResult {
  success: boolean;
  sprite?: SpriteGrid;
  error?: string;
  attempts: number;
}

/**
 * Generate an avatar sprite from a description
 */
export async function generateAvatar(
  options: AvatarGenerationOptions
): Promise<GenerationResult> {
  const { description, vibe, providerConfig, maxRetries = 3 } = options;

  const model = createModel(providerConfig);
  const userPrompt = buildUserPrompt(description, vibe);

  let attempts = 0;
  let lastError: Error | null = null;

  while (attempts < maxRetries) {
    attempts++;

    try {
      const result = await generateObject({
        model,
        schema: SpriteGridSchema,
        system: AVATAR_SYSTEM_PROMPT,
        prompt: userPrompt,
        temperature: 0.7,
      });

      // Validate the result
      const validated = SpriteGridSchema.safeParse(result.object);
      if (!validated.success) {
        lastError = new Error(`Validation failed: ${validated.error.message}`);
        continue;
      }

      return {
        success: true,
        sprite: validated.data,
        attempts,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Avatar generation attempt ${attempts} failed:`, lastError.message);
    }
  }

  return {
    success: false,
    error: lastError?.message || 'Unknown error',
    attempts,
  };
}

/**
 * Generate a simple placeholder sprite
 */
export function generatePlaceholderSprite(): SpriteGrid {
  const emptyCell = { char: ' ' };
  const bodyCell = { char: '@', fg: '#888888' };
  const headCell = { char: 'O', fg: '#AAAAAA' };

  // Create a simple humanoid shape
  const createFrame = (): SpriteGrid['frames']['down'][0] => {
    const frame: SpriteGrid['frames']['down'][0] = [];
    for (let y = 0; y < 12; y++) {
      const row = [];
      for (let x = 0; x < 7; x++) {
        // Simple humanoid shape centered
        if (y === 1 && x === 3) {
          row.push(headCell); // Head
        } else if (y === 2 && x === 3) {
          row.push({ char: '|', fg: '#888888' }); // Neck
        } else if (y >= 3 && y <= 6 && x >= 2 && x <= 4) {
          row.push(bodyCell); // Body
        } else if (y >= 7 && y <= 10 && (x === 2 || x === 4)) {
          row.push({ char: '|', fg: '#666666' }); // Legs
        } else {
          row.push(emptyCell);
        }
      }
      frame.push(row);
    }
    return frame;
  };

  const frame = createFrame();

  return {
    width: 7,
    height: 12,
    frames: {
      up: [frame, frame, frame, frame],
      down: [frame, frame, frame, frame],
      left: [frame, frame, frame, frame],
      right: [frame, frame, frame, frame],
    },
  };
}
