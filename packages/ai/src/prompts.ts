/**
 * System prompt for avatar generation (legacy ASCII mode)
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
 * System prompt for pixel sprite generation (16x24 RGB mode) - COMPACT FORMAT
 */
export const PIXEL_SPRITE_SYSTEM_PROMPT = `You are a pixel art sprite generator. Create character sprites for a dark, surreal terminal-based MMO.

JSON STRUCTURE:
{
  "width": 16,
  "height": 24,
  "frames": {
    "up": [[row0], [row1], ... 24 rows],
    "down": [[row0], [row1], ... 24 rows],
    "left": [[row0], [row1], ... 24 rows],
    "right": [[row0], [row1], ... 24 rows]
  }
}

PIXEL FORMAT (compact strings):
- "0" = transparent pixel
- "RRRGGGBBBf" = visible pixel (9 digits for RGB 000-255, then 'f')

Example row: ["0","0","0","090090106f","090090106f","0","0","0","0","0","0","0","090090106f","090090106f","0","0"]

COLOR PALETTE (use these muted, dark colors):
- Purple: "074044106f"
- Blue: "046074106f"
- Gray: "090090106f"
- Deep red: "106042042f"
- Skin: "210180140f"
- Dark: "040040050f"

LAYOUT (16 wide x 24 tall):
- Rows 0-6: Head area (transparent sides)
- Rows 7-15: Torso/arms
- Rows 16-23: Legs/feet

Direction meanings:
- down = front view (character faces toward viewer)
- up = back view (character faces away from viewer)
- left = character faces LEFT (viewer sees their right side)
- right = character faces RIGHT (viewer sees their left side)`;

/**
 * Build user prompt from description (legacy ASCII mode)
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
 * Build user prompt for pixel sprite generation
 */
export function buildPixelSpritePrompt(description: string, vibe?: string): string {
  let prompt = `Create a 16x24 pixel sprite for: "${description}"`;

  if (vibe) {
    prompt += ` with a ${vibe} aesthetic`;
  }

  prompt += `

Generate:
- 4 directions (up, down, left, right)
- 24 rows per direction
- 16 pixels per row
- Use "0" for transparent, "RRRGGGBBBf" for visible pixels`;

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
