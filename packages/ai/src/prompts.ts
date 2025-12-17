/**
 * System prompt for avatar generation
 */
export const AVATAR_SYSTEM_PROMPT = `You are an ASCII sprite artist creating character sprites for a dark, surreal terminal-based MMO called Maldoror.

The visual style draws from:
- Les Chants de Maldoror (Lautréamont) - dark surrealism, metamorphosis
- Terminal aesthetics - limited colors, character-based art
- Gothic and grotesque imagery

You will create a 7-character wide by 12-character tall sprite with 4 animation frames for each of the 4 cardinal directions (up, down, left, right). The animation represents a walking cycle.

Guidelines:
1. Use varied ASCII characters to create texture and depth: @#$%&*+=~^.,'"\`-_|/\\()[]{}<>
2. Use muted, atmospheric colors - purples, blues, grays, deep reds
3. The sprite should be recognizable as humanoid but can have surreal/unsettling elements
4. Walking animations should show subtle limb movement
5. Left/right sprites should be mirror-appropriate
6. Up sprite shows back, down sprite shows front
7. Keep the silhouette consistent across frames
8. Empty space should use ' ' (space character)

The sprite format is JSON with this structure:
- width: 7 (always)
- height: 12 (always)
- frames: { up: [...], down: [...], left: [...], right: [...] }
- Each direction has 4 frames (walking animation)
- Each frame is an array of 12 rows
- Each row is an array of 7 cells
- Each cell has: char (single character), fg (optional hex color), bg (optional hex color)`;

/**
 * Build user prompt from description
 */
export function buildUserPrompt(description: string, vibe?: string): string {
  let prompt = `Create an ASCII sprite for the following character description:\n\n"${description}"`;

  if (vibe) {
    prompt += `\n\nThe character should embody a "${vibe}" aesthetic.`;
  }

  prompt += `\n\nGenerate the complete sprite data as JSON following the schema provided.`;

  return prompt;
}

/**
 * Available aesthetic vibes
 */
export const VIBES = [
  'bleak',       // Muted colors, hunched posture, tattered
  'surreal',     // Strange proportions, unusual features
  'aristocratic', // Elegant but decaying, refined
  'feral',       // Animal-like, primal, sharp
  'ethereal',    // Ghostly, translucent, otherworldly
] as const;

export type Vibe = typeof VIBES[number];
