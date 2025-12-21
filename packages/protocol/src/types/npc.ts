/**
 * NPC visual state for rendering and broadcast
 * Mirrors PlayerVisualState but for AI-controlled characters
 */
export interface NPCVisualState {
  npcId: string;
  name: string;
  x: number;          // World position in tiles
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
  animationFrame: 0 | 1 | 2 | 3;
  isMoving: boolean;
  spriteId?: string;  // Reference to sprite in DB
}
