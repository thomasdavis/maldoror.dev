import type { Sprite, NPCState, NPCVisualState, NPCRecord, NPCConfig, Direction } from '@maldoror/protocol';
import { DEFAULT_NPC_CONFIG } from '@maldoror/protocol';
import { loadAllNPCs, loadNPCSpriteFromDisk, createNPC, type NPCCreateData } from '../utils/npc-storage.js';

/**
 * Player position for AI calculations
 */
interface PlayerPosition {
  userId: string;
  x: number;
  y: number;
}

/**
 * Collision check function type
 * Returns true if the position is blocked
 */
type CollisionChecker = (x: number, y: number) => boolean;

/**
 * NPC creation callback type
 * Called when a new NPC is created
 */
type NPCCreatedCallback = (npc: NPCVisualState) => void;

/**
 * NPCManager - Server-side NPC state management and AI
 *
 * Handles:
 * - Loading NPCs from database on startup
 * - Storing NPC sprites in memory
 * - Ticking all NPCs to update their AI/movement
 * - Providing visible NPCs for viewport queries
 */
export class NPCManager {
  private npcs: Map<string, NPCState> = new Map();
  private sprites: Map<string, Sprite> = new Map();
  private collisionChecker: CollisionChecker | null = null;
  private npcCreatedCallbacks: Set<NPCCreatedCallback> = new Set();
  private tickCounter: number = 0;

  /**
   * Set collision checker function
   * Called to check if a position is blocked by terrain or buildings
   */
  setCollisionChecker(checker: CollisionChecker): void {
    this.collisionChecker = checker;
  }

  /**
   * Register callback for NPC creation events
   */
  onNPCCreated(callback: NPCCreatedCallback): void {
    this.npcCreatedCallbacks.add(callback);
  }

  /**
   * Unregister NPC creation callback
   */
  offNPCCreated(callback: NPCCreatedCallback): void {
    this.npcCreatedCallbacks.delete(callback);
  }

  /**
   * Load all NPCs from database on startup
   */
  async loadFromDB(): Promise<void> {
    const records = await loadAllNPCs();
    console.log(`[NPCManager] Loading ${records.length} NPCs from database...`);

    let loadedCount = 0;
    let spriteCount = 0;

    for (const record of records) {
      // Create NPC state from record
      const state = this.createStateFromRecord(record);
      this.npcs.set(record.id, state);
      loadedCount++;

      // Load sprite from disk
      const sprite = await loadNPCSpriteFromDisk(record.id);
      if (sprite) {
        this.sprites.set(record.id, sprite);
        spriteCount++;
      }
    }

    console.log(`[NPCManager] Loaded ${loadedCount} NPCs, ${spriteCount} sprites`);
  }

  /**
   * Create NPC state from database record
   */
  private createStateFromRecord(record: NPCRecord): NPCState {
    const config: NPCConfig = {
      ...DEFAULT_NPC_CONFIG,
      roamRadius: record.roamRadius,
      playerAffinity: record.playerAffinity,
    };

    return {
      npcId: record.id,
      name: record.name,
      x: record.spawnX,
      y: record.spawnY,
      direction: 'down',
      animationFrame: 0,
      isMoving: false,
      spawnX: record.spawnX,
      spawnY: record.spawnY,
      targetX: null,
      targetY: null,
      ticksUntilNextDecision: this.randomDecisionTicks(),
      behaviorState: 'idle',
      config,
    };
  }

  /**
   * Create a new NPC and add it to the manager
   */
  async addNPC(data: NPCCreateData): Promise<NPCState> {
    // Save to database and disk
    const record = await createNPC(data);

    // Create state
    const state = this.createStateFromRecord(record);
    this.npcs.set(record.id, state);

    // Cache sprite
    this.sprites.set(record.id, data.sprite);

    console.log(`[NPCManager] Created NPC "${data.name}" at (${data.spawnX}, ${data.spawnY})`);

    // Notify callbacks
    const visualState = this.toVisualState(state);
    for (const callback of this.npcCreatedCallbacks) {
      callback(visualState);
    }

    return state;
  }

  /**
   * Get an NPC by ID
   */
  getNPC(npcId: string): NPCState | null {
    return this.npcs.get(npcId) ?? null;
  }

  /**
   * Get NPC sprite by ID
   */
  getNPCSprite(npcId: string): Sprite | null {
    return this.sprites.get(npcId) ?? null;
  }

  /**
   * Get all NPCs as visual states
   */
  getAllNPCs(): NPCVisualState[] {
    return Array.from(this.npcs.values()).map(npc => this.toVisualState(npc));
  }

  /**
   * Get NPCs visible within a viewport
   */
  getVisibleNPCs(
    centerX: number,
    centerY: number,
    width: number,
    height: number
  ): NPCVisualState[] {
    const viewportX = centerX - Math.floor(width / 2);
    const viewportY = centerY - Math.floor(height / 2);

    const result: NPCVisualState[] = [];

    for (const npc of this.npcs.values()) {
      // Check if NPC is in viewport (with some padding for sprites)
      if (
        npc.x >= viewportX - 2 &&
        npc.x < viewportX + width + 2 &&
        npc.y >= viewportY - 2 &&
        npc.y < viewportY + height + 2
      ) {
        result.push(this.toVisualState(npc));
      }
    }

    return result;
  }

  /**
   * Tick all NPCs - update AI and movement
   * @param playerPositions - Current positions of all players for AI calculations
   */
  tickAll(playerPositions: PlayerPosition[]): void {
    this.tickCounter++;

    for (const npc of this.npcs.values()) {
      this.tickNPC(npc, playerPositions);
    }
  }

  /**
   * Tick a single NPC
   */
  private tickNPC(npc: NPCState, playerPositions: PlayerPosition[]): void {
    // 1. Update animation if moving (cycle through frames)
    if (npc.isMoving) {
      npc.animationFrame = ((this.tickCounter % 4) as 0 | 1 | 2 | 3);
    }

    // 2. Decrement decision timer
    npc.ticksUntilNextDecision--;

    // 3. If we have a target, try to move toward it
    // Only move every 4 ticks (5 moves/second at 20 TPS) to avoid too-fast movement
    if (npc.targetX !== null && npc.targetY !== null && this.tickCounter % 4 === 0) {
      const moved = this.moveTowardTarget(npc);

      // Check if we reached the target
      if (!moved || (npc.x === npc.targetX && npc.y === npc.targetY)) {
        npc.targetX = null;
        npc.targetY = null;
        npc.isMoving = false;
        npc.animationFrame = 0;
        npc.behaviorState = 'idle';
      }
    }

    // 4. Make a new decision if timer expired
    if (npc.ticksUntilNextDecision <= 0) {
      this.makeDecision(npc, playerPositions);
      npc.ticksUntilNextDecision = this.randomDecisionTicks();
    }
  }

  /**
   * Make an AI decision for an NPC
   */
  private makeDecision(npc: NPCState, playerPositions: PlayerPosition[]): void {
    // Find nearest player within detection radius
    const nearestPlayer = this.findNearestPlayer(npc, playerPositions);

    // Decide behavior based on player proximity and affinity
    if (nearestPlayer) {
      const { player } = nearestPlayer;

      if (npc.config.playerAffinity > 60) {
        // Follow player
        npc.behaviorState = 'following_player';
        this.setTargetNear(npc, player.x, player.y, 2, 4);
      } else if (npc.config.playerAffinity < 40) {
        // Flee from player
        npc.behaviorState = 'fleeing';
        const dx = npc.x - player.x;
        const dy = npc.y - player.y;
        const fleeDistance = 8;
        const targetX = npc.x + Math.sign(dx) * fleeDistance;
        const targetY = npc.y + Math.sign(dy) * fleeDistance;
        this.setTargetWithinBounds(npc, targetX, targetY);
      } else {
        // Neutral - wander or idle
        this.wanderOrIdle(npc);
      }
    } else {
      // No player nearby - wander or idle
      this.wanderOrIdle(npc);
    }
  }

  /**
   * Find the nearest player within detection radius
   */
  private findNearestPlayer(
    npc: NPCState,
    playerPositions: PlayerPosition[]
  ): { player: PlayerPosition; distance: number } | null {
    let nearest: { player: PlayerPosition; distance: number } | null = null;

    for (const player of playerPositions) {
      const dx = player.x - npc.x;
      const dy = player.y - npc.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= npc.config.detectionRadius) {
        if (!nearest || distance < nearest.distance) {
          nearest = { player, distance };
        }
      }
    }

    return nearest;
  }

  /**
   * Wander randomly or stay idle
   */
  private wanderOrIdle(npc: NPCState): void {
    // 30% chance to idle
    if (Math.random() < npc.config.idleChance) {
      npc.behaviorState = 'idle';
      npc.targetX = null;
      npc.targetY = null;
      npc.isMoving = false;
      npc.animationFrame = 0;
      return;
    }

    // Wander to a random point within roam radius
    npc.behaviorState = 'wandering';
    const angle = Math.random() * Math.PI * 2;
    const distance = 3 + Math.random() * 5; // 3-8 tiles
    const targetX = npc.x + Math.round(Math.cos(angle) * distance);
    const targetY = npc.y + Math.round(Math.sin(angle) * distance);

    this.setTargetWithinBounds(npc, targetX, targetY);
  }

  /**
   * Set target position ensuring it's within roam radius of spawn
   */
  private setTargetWithinBounds(npc: NPCState, targetX: number, targetY: number): void {
    const radius = npc.config.roamRadius;

    // Clamp to roam radius
    const dx = targetX - npc.spawnX;
    const dy = targetY - npc.spawnY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > radius) {
      // Scale back to radius
      const scale = radius / dist;
      targetX = npc.spawnX + Math.round(dx * scale);
      targetY = npc.spawnY + Math.round(dy * scale);
    }

    npc.targetX = targetX;
    npc.targetY = targetY;
    npc.isMoving = true;
  }

  /**
   * Set target near a position with some random offset
   */
  private setTargetNear(npc: NPCState, x: number, y: number, minDist: number, maxDist: number): void {
    const angle = Math.random() * Math.PI * 2;
    const distance = minDist + Math.random() * (maxDist - minDist);
    const targetX = x + Math.round(Math.cos(angle) * distance);
    const targetY = y + Math.round(Math.sin(angle) * distance);

    this.setTargetWithinBounds(npc, targetX, targetY);
  }

  /**
   * Move NPC one step toward target
   * Returns true if moved, false if blocked
   */
  private moveTowardTarget(npc: NPCState): boolean {
    if (npc.targetX === null || npc.targetY === null) {
      return false;
    }

    const dx = npc.targetX - npc.x;
    const dy = npc.targetY - npc.y;

    if (dx === 0 && dy === 0) {
      return false; // Already at target
    }

    // Determine move direction (prioritize larger axis)
    let moveX = 0;
    let moveY = 0;

    if (Math.abs(dx) > Math.abs(dy)) {
      moveX = Math.sign(dx);
    } else if (dy !== 0) {
      moveY = Math.sign(dy);
    } else {
      moveX = Math.sign(dx);
    }

    // Update direction based on movement
    npc.direction = this.getDirection(moveX, moveY);

    // Check collision
    const newX = npc.x + moveX;
    const newY = npc.y + moveY;

    if (this.isBlocked(newX, newY)) {
      // Try alternate direction
      if (moveX !== 0 && dy !== 0) {
        // Was moving horizontally, try vertical
        moveX = 0;
        moveY = Math.sign(dy);
        npc.direction = this.getDirection(moveX, moveY);
        if (!this.isBlocked(npc.x, npc.y + moveY)) {
          npc.y += moveY;
          return true;
        }
      } else if (moveY !== 0 && dx !== 0) {
        // Was moving vertically, try horizontal
        moveY = 0;
        moveX = Math.sign(dx);
        npc.direction = this.getDirection(moveX, moveY);
        if (!this.isBlocked(npc.x + moveX, npc.y)) {
          npc.x += moveX;
          return true;
        }
      }

      // Completely blocked - cancel target
      return false;
    }

    // Move
    npc.x = newX;
    npc.y = newY;
    npc.isMoving = true;

    return true;
  }

  /**
   * Check if a position is blocked
   */
  private isBlocked(x: number, y: number): boolean {
    if (!this.collisionChecker) {
      return false;
    }
    return this.collisionChecker(x, y);
  }

  /**
   * Get direction from movement delta
   */
  private getDirection(dx: number, dy: number): Direction {
    if (dy < 0) return 'up';
    if (dy > 0) return 'down';
    if (dx < 0) return 'left';
    if (dx > 0) return 'right';
    return 'down';
  }

  /**
   * Generate random ticks until next decision (1 minute at 20 TPS)
   */
  private randomDecisionTicks(): number {
    return 1200 + Math.floor(Math.random() * 200); // ~60-70 seconds at 20 TPS
  }

  /**
   * Convert full state to visual state for broadcasting
   */
  private toVisualState(npc: NPCState): NPCVisualState {
    return {
      npcId: npc.npcId,
      name: npc.name,
      x: npc.x,
      y: npc.y,
      direction: npc.direction,
      animationFrame: npc.animationFrame,
      isMoving: npc.isMoving,
    };
  }

  /**
   * Get NPC count
   */
  getCount(): number {
    return this.npcs.size;
  }

  /**
   * Remove an NPC by ID
   */
  removeNPC(npcId: string): void {
    this.npcs.delete(npcId);
    this.sprites.delete(npcId);
  }

  /**
   * Clear all NPCs
   */
  clear(): void {
    this.npcs.clear();
    this.sprites.clear();
  }
}
