/**
 * NPC (Non-Player Character) types
 * NPCs are AI-controlled entities that roam the world
 */

/**
 * NPC behavior state
 */
export type NPCBehaviorState = 'idle' | 'wandering' | 'following_player' | 'fleeing';

/**
 * NPC configuration for behavior
 */
export interface NPCConfig {
  roamRadius: number;      // Max distance from spawn (default: 15 for 30x30 area)
  playerAffinity: number;  // 0-100: 0=flees players, 50=neutral, 100=seeks players
  detectionRadius: number; // Radius to detect nearby players (default: 10)
  idleChance: number;      // Probability of idling each decision (0-1, default: 0.3)
}

/**
 * NPC visual state for rendering (similar to PlayerVisualState)
 * Used for broadcasting to clients
 */
export interface NPCVisualState {
  npcId: string;
  name: string;
  x: number;
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
  animationFrame: 0 | 1 | 2 | 3;
  isMoving: boolean;
}

/**
 * Full NPC state (server-side authoritative state)
 * Extends visual state with AI behavior data
 */
export interface NPCState extends NPCVisualState {
  // Spawn point (center of roaming area)
  spawnX: number;
  spawnY: number;

  // Current AI target
  targetX: number | null;
  targetY: number | null;

  // AI timing
  ticksUntilNextDecision: number;

  // Behavior state
  behaviorState: NPCBehaviorState;

  // Configuration
  config: NPCConfig;
}

/**
 * NPC database record (as stored in DB)
 */
export interface NPCRecord {
  id: string;
  creatorId: string;
  name: string;
  prompt: string;
  spawnX: number;
  spawnY: number;
  roamRadius: number;
  playerAffinity: number;
  modelUsed: string | null;
  createdAt: Date;
}

/**
 * Default NPC configuration
 */
export const DEFAULT_NPC_CONFIG: NPCConfig = {
  roamRadius: 15,        // 30x30 area
  playerAffinity: 50,    // Neutral
  detectionRadius: 10,   // 10 tile detection range
  idleChance: 0.3,       // 30% chance to idle
};
