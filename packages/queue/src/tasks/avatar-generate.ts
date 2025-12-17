import type { Task } from 'graphile-worker';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';
import { generateAvatar, generatePlaceholderSprite, type AIProvider } from '@maldoror/ai';

/**
 * Avatar generation task payload
 */
interface AvatarGeneratePayload {
  avatarId: string;
  userId: string;
  prompt: string;
  vibe?: string;
}

/**
 * Avatar generation task
 */
export const avatarGenerate: Task = async (payload, helpers) => {
  const { avatarId, userId, prompt, vibe } = payload as AvatarGeneratePayload;

  helpers.logger.info(`Generating avatar for user ${userId}`, { avatarId, prompt, vibe });

  try {
    // Update avatar status to 'generating'
    await db
      .update(schema.avatars)
      .set({ generationStatus: 'generating', updatedAt: new Date() })
      .where(eq(schema.avatars.id, avatarId));

    // Determine provider from environment
    const provider = (process.env.AI_PROVIDER || 'anthropic') as AIProvider;
    const apiKey = provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

    // Generate avatar
    const result = await generateAvatar({
      description: prompt,
      vibe: vibe as 'bleak' | 'surreal' | 'aristocratic' | 'feral' | 'ethereal' | undefined,
      providerConfig: {
        provider,
        apiKey,
      },
      maxRetries: 3,
    });

    if (result.success && result.sprite) {
      // Save generated sprite
      await db
        .update(schema.avatars)
        .set({
          spriteJson: result.sprite,
          generationStatus: 'completed',
          updatedAt: new Date(),
        })
        .where(eq(schema.avatars.id, avatarId));

      helpers.logger.info(`Avatar generated successfully for user ${userId}`, {
        avatarId,
        attempts: result.attempts,
      });
    } else {
      // Generation failed, use placeholder
      helpers.logger.warn(`Avatar generation failed for user ${userId}, using placeholder`, {
        avatarId,
        error: result.error,
        attempts: result.attempts,
      });

      const placeholder = generatePlaceholderSprite();
      await db
        .update(schema.avatars)
        .set({
          spriteJson: placeholder,
          generationStatus: 'failed',
          updatedAt: new Date(),
        })
        .where(eq(schema.avatars.id, avatarId));
    }
  } catch (error) {
    helpers.logger.error(`Avatar generation error for user ${userId}`, {
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Update status to failed
    await db
      .update(schema.avatars)
      .set({ generationStatus: 'failed', updatedAt: new Date() })
      .where(eq(schema.avatars.id, avatarId));

    throw error; // Re-throw to trigger retry
  }
};
