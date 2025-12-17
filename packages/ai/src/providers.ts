import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

/**
 * Available AI providers
 */
export type AIProvider = 'anthropic' | 'openai';

/**
 * Provider configuration
 */
export interface ProviderConfig {
  provider: AIProvider;
  model?: string;
  apiKey?: string;
}

/**
 * Default models for each provider
 */
export const DEFAULT_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
};

/**
 * Create a model instance based on configuration
 */
export function createModel(config: ProviderConfig) {
  const { provider, model, apiKey } = config;
  const modelId = model || DEFAULT_MODELS[provider];

  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
