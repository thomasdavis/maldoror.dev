import { ChunkCache, ChunkGenerator, SpatialIndex, GameLoop } from '@maldoror/world';
import type { PlayerInput, Direction, NPCVisualState, Sprite } from '@maldoror/protocol';
import { isPositionInBuilding } from '@maldoror/protocol';
import { db, schema } from '@maldoror/db';
import { NPCManager } from './npc-manager.js';
import type { NPCCreateData } from '../utils/npc-storage.js';

interface GameServerConfig {
  worldSeed: bigint;
  tickRate: number;
  chunkCacheSize: number;
}

interface PlayerState {
  userId: string;
  sessionId: string;
  username: string;
  x: number;
  y: number;
  direction: Direction;
  animationFrame: number;
  isOnline: boolean;
  isMoving: boolean;
  lastMoveTime: number;
}

interface ChatMessage {
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

type ChatCallback = (message: ChatMessage) => void;
type SpriteReloadCallback = (userId: string) => void;
type NPCCreatedCallback = (npc: NPCVisualState) => void;
type RoadPlacementCallback = (x: number, y: number, placedBy: string) => void;
type RoadRemovalCallback = (x: number, y: number) => void;


/**
 * Main game server coordinating all systems
 */
export class GameServer {
  private config: GameServerConfig;
  private chunkGenerator: ChunkGenerator;
  private chunkCache: ChunkCache;
  private spatialIndex: SpatialIndex;
  private gameLoop: GameLoop;
  private npcManager: NPCManager;
  private players: Map<string, PlayerState> = new Map();
  private inputQueue: PlayerInput[] = [];
  private chatCallbacks: Map<string, ChatCallback> = new Map();
  private spriteReloadCallbacks: Map<string, SpriteReloadCallback> = new Map();
  private globalSpriteReloadCallback: SpriteReloadCallback | null = null;
  private globalNPCCreatedCallback: NPCCreatedCallback | null = null;
  private recentChat: ChatMessage[] = [];
  // Building positions for NPC collision: Map of "anchorX,anchorY" -> true
  private buildingAnchors: Set<string> = new Set();
  // Road callbacks for broadcasting to all players
  private roadPlacementCallbacks: Map<string, RoadPlacementCallback> = new Map();
  private roadRemovalCallbacks: Map<string, RoadRemovalCallback> = new Map();

  constructor(config: GameServerConfig) {
    this.config = config;

    // Initialize world systems
    this.chunkGenerator = new ChunkGenerator(config.worldSeed);
    this.chunkCache = new ChunkCache(this.chunkGenerator, config.chunkCacheSize);
    this.spatialIndex = new SpatialIndex();
    this.npcManager = new NPCManager();

    // Initialize game loop
    this.gameLoop = new GameLoop({ tickRate: config.tickRate });
    this.setupGameLoop();
  }

  private setupGameLoop(): void {
    // Pre-tick: process inputs
    this.gameLoop.onPreTick(async (_ctx) => {
      const inputs = this.drainInputQueue();
      for (const input of inputs) {
        await this.processInput(input);
      }
    });

    // Tick: update game state
    this.gameLoop.onTick(async (ctx) => {
      const now = Date.now();
      // Update animation frames only for moving players
      for (const player of this.players.values()) {
        if (player.isOnline) {
          // Stop moving after 200ms of no input
          if (player.isMoving && now - player.lastMoveTime > 200) {
            player.isMoving = false;
            player.animationFrame = 0;
          }
          // Only cycle animation when moving
          if (player.isMoving) {
            player.animationFrame = (ctx.tick % 4) as 0 | 1 | 2 | 3;
          }
        }
      }

      // Tick NPCs with current player positions
      const playerPositions = this.getPlayerPositions();
      this.npcManager.tickAll(playerPositions);
    });

    // Post-tick: broadcast state (if needed)
    this.gameLoop.onPostTick(async (_ctx) => {
      // Future: broadcast position updates to nearby players
    });

    this.gameLoop.on('tickError', ({ tick, error }) => {
      console.error(`Tick ${tick} error:`, error);
    });
  }

  /**
   * Start the game server
   */
  start(): void {
    this.gameLoop.start();
    console.log(`Game server started at ${this.config.tickRate} Hz`);
  }

  /**
   * Stop the game server
   */
  stop(): void {
    this.gameLoop.stop();
    console.log('Game server stopped');
  }

  /**
   * Handle player connection
   */
  async playerConnect(userId: string, sessionId: string, username: string): Promise<void> {
    const existing = this.players.get(userId);

    if (existing) {
      // Reconnect
      existing.sessionId = sessionId;
      existing.username = username;
      existing.isOnline = true;
      existing.isMoving = false;
      existing.animationFrame = 0;
    } else {
      // New player
      this.players.set(userId, {
        userId,
        sessionId,
        username,
        x: 0,
        y: 0,
        direction: 'down',
        animationFrame: 0,
        isOnline: true,
        isMoving: false,
        lastMoveTime: 0,
      });
    }

    // Add to spatial index
    const player = this.players.get(userId)!;
    this.spatialIndex.updatePlayer(userId, player.x, player.y);

    console.log(`Player connected: ${userId}`);
  }

  /**
   * Handle player disconnection
   */
  async playerDisconnect(userId: string): Promise<void> {
    const player = this.players.get(userId);
    if (player) {
      player.isOnline = false;
      this.spatialIndex.removePlayer(userId);
      this.chatCallbacks.delete(userId);
      this.spriteReloadCallbacks.delete(userId);
    }
    console.log(`Player disconnected: ${userId}`);
  }

  /**
   * Queue input for processing
   */
  queueInput(input: PlayerInput): void {
    this.inputQueue.push(input);
  }

  /**
   * Drain input queue
   */
  private drainInputQueue(): PlayerInput[] {
    const inputs = this.inputQueue;
    this.inputQueue = [];
    return inputs.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Process a single input
   */
  private async processInput(input: PlayerInput): Promise<void> {
    const player = this.players.get(input.userId);
    if (!player || !player.isOnline) return;

    if (input.type === 'move') {
      const { dx, dy } = input.payload as { dx: number; dy: number };
      player.x += dx;
      player.y += dy;

      // Update direction
      if (dy < 0) player.direction = 'up';
      else if (dy > 0) player.direction = 'down';
      else if (dx < 0) player.direction = 'left';
      else if (dx > 0) player.direction = 'right';

      // Mark as moving for animation
      player.isMoving = true;
      player.lastMoveTime = Date.now();

      // Update spatial index
      this.spatialIndex.updatePlayer(input.userId, player.x, player.y);
    }
  }

  /**
   * Update player position (called directly by session)
   */
  updatePlayerPosition(userId: string, x: number, y: number): void {
    const player = this.players.get(userId);
    if (player) {
      player.x = x;
      player.y = y;
      // Mark as moving for animation
      player.isMoving = true;
      player.lastMoveTime = Date.now();
      this.spatialIndex.updatePlayer(userId, x, y);
    }
  }

  /**
   * Get visible players in viewport
   */
  getVisiblePlayers(
    centerX: number,
    centerY: number,
    width: number,
    height: number,
    excludeId: string
  ): Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
  }> {
    const viewportX = centerX - Math.floor(width / 2);
    const viewportY = centerY - Math.floor(height / 2);

    const nearby = this.spatialIndex.getPlayersInViewport(
      viewportX,
      viewportY,
      width,
      height,
      excludeId
    );

    return nearby
      .map(({ playerId, x, y }) => {
        const player = this.players.get(playerId);
        if (!player || !player.isOnline) return null;
        return {
          userId: player.userId,
          username: player.username || 'Unknown',
          x,
          y,
          direction: player.direction,
          animationFrame: player.animationFrame,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }

  /**
   * Get all online players
   */
  getAllPlayers(): Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    isOnline: boolean;
  }> {
    return Array.from(this.players.values())
      .filter(p => p.isOnline)
      .map(p => ({
        userId: p.userId,
        username: p.username || 'Unknown',
        x: p.x,
        y: p.y,
        isOnline: p.isOnline,
      }));
  }

  /**
   * Get online player count
   */
  getOnlineCount(): number {
    return Array.from(this.players.values()).filter(p => p.isOnline).length;
  }

  /**
   * Register chat callback for a user
   */
  onChat(userId: string, callback: ChatCallback): void {
    this.chatCallbacks.set(userId, callback);
  }

  /**
   * Broadcast chat message to all online players
   */
  broadcastChat(senderId: string, senderName: string, text: string): void {
    const message: ChatMessage = {
      senderId,
      senderName,
      text,
      timestamp: Date.now(),
    };

    // Store in recent chat
    this.recentChat.push(message);
    if (this.recentChat.length > 100) {
      this.recentChat.shift();
    }

    // Broadcast to all online players
    for (const [userId, callback] of this.chatCallbacks) {
      if (userId !== senderId) {
        callback(message);
      }
    }
  }

  /**
   * Register sprite reload callback for a user
   */
  onSpriteReload(userId: string, callback: SpriteReloadCallback): void {
    this.spriteReloadCallbacks.set(userId, callback);
  }

  /**
   * Broadcast sprite reload to all online players
   * Called when a player regenerates their avatar
   */
  async broadcastSpriteReload(changedUserId: string): Promise<void> {
    // If running in worker, use global callback to notify main process
    if (this.globalSpriteReloadCallback) {
      this.globalSpriteReloadCallback(changedUserId);
    }

    // Also notify direct callbacks (for non-worker mode / local dev)
    for (const [_userId, callback] of this.spriteReloadCallbacks) {
      callback(changedUserId);
    }
    console.log(`Sprite reload broadcast for user: ${changedUserId}`);
  }

  // ==================== Road Broadcasting ====================

  /**
   * Register road placement callback for a user
   */
  onRoadPlacement(userId: string, callback: RoadPlacementCallback): void {
    this.roadPlacementCallbacks.set(userId, callback);
  }

  /**
   * Register road removal callback for a user
   */
  onRoadRemoval(userId: string, callback: RoadRemovalCallback): void {
    this.roadRemovalCallbacks.set(userId, callback);
  }

  /**
   * Broadcast road placement to all online players
   */
  broadcastRoadPlacement(x: number, y: number, placedBy: string): void {
    for (const [_userId, callback] of this.roadPlacementCallbacks) {
      callback(x, y, placedBy);
    }
  }

  /**
   * Broadcast road removal to all online players
   */
  broadcastRoadRemoval(x: number, y: number): void {
    for (const [_userId, callback] of this.roadRemovalCallbacks) {
      callback(x, y);
    }
  }

  /**
   * Get chunk cache
   */
  getChunkCache(): ChunkCache {
    return this.chunkCache;
  }

  /**
   * Get player count
   */
  getOnlinePlayerCount(): number {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.isOnline) count++;
    }
    return count;
  }

  /**
   * Set global sprite reload callback (used by worker for IPC)
   */
  setGlobalSpriteReloadCallback(callback: SpriteReloadCallback): void {
    this.globalSpriteReloadCallback = callback;
  }

  // ==================== NPC Methods ====================

  /**
   * Get player positions for NPC AI calculations
   */
  private getPlayerPositions(): Array<{ userId: string; x: number; y: number }> {
    const positions: Array<{ userId: string; x: number; y: number }> = [];
    for (const player of this.players.values()) {
      if (player.isOnline) {
        positions.push({ userId: player.userId, x: player.x, y: player.y });
      }
    }
    return positions;
  }

  /**
   * Load NPCs from database on startup
   */
  async loadNPCs(): Promise<void> {
    // First load building positions for collision checking
    await this.loadBuildingPositions();

    // Set up NPC collision checker
    this.npcManager.setCollisionChecker((x: number, y: number) => {
      return this.isPositionBlocked(x, y);
    });

    // Then load NPCs
    await this.npcManager.loadFromDB();
  }

  /**
   * Load all building positions from database for collision checking
   */
  private async loadBuildingPositions(): Promise<void> {
    const buildings = await db.select({
      anchorX: schema.buildings.anchorX,
      anchorY: schema.buildings.anchorY,
    }).from(schema.buildings);

    this.buildingAnchors.clear();
    for (const building of buildings) {
      this.buildingAnchors.add(`${building.anchorX},${building.anchorY}`);
    }

    console.log(`[GameServer] Loaded ${this.buildingAnchors.size} building positions for collision`);
  }

  /**
   * Add a new building to the collision cache
   */
  addBuildingToCollisionCache(anchorX: number, anchorY: number): void {
    this.buildingAnchors.add(`${anchorX},${anchorY}`);
  }

  /**
   * Check if a position is blocked by terrain or buildings
   */
  private isPositionBlocked(x: number, y: number): boolean {
    // Check terrain walkability (use generator directly for walkable property)
    const tile = this.chunkGenerator.getTileAt(x, y);
    if (!tile.walkable) {
      return true;
    }

    // Check buildings (3x3 areas around each anchor)
    for (const anchorKey of this.buildingAnchors) {
      const [anchorX, anchorY] = anchorKey.split(',').map(Number);
      if (isPositionInBuilding(x, y, anchorX!, anchorY!)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Create a new NPC
   */
  async createNPC(data: NPCCreateData): Promise<NPCVisualState> {
    const state = await this.npcManager.addNPC(data);

    // Notify global callback for worker IPC
    if (this.globalNPCCreatedCallback) {
      this.globalNPCCreatedCallback({
        npcId: state.npcId,
        name: state.name,
        x: state.x,
        y: state.y,
        direction: state.direction,
        animationFrame: state.animationFrame,
        isMoving: state.isMoving,
      });
    }

    return {
      npcId: state.npcId,
      name: state.name,
      x: state.x,
      y: state.y,
      direction: state.direction,
      animationFrame: state.animationFrame,
      isMoving: state.isMoving,
    };
  }

  /**
   * Get visible NPCs in viewport
   */
  getVisibleNPCs(
    centerX: number,
    centerY: number,
    width: number,
    height: number
  ): NPCVisualState[] {
    return this.npcManager.getVisibleNPCs(centerX, centerY, width, height);
  }

  /**
   * Get all NPCs
   */
  getAllNPCs(): NPCVisualState[] {
    return this.npcManager.getAllNPCs();
  }

  /**
   * Get NPC sprite by ID
   */
  getNPCSprite(npcId: string): Sprite | null {
    return this.npcManager.getNPCSprite(npcId);
  }

  /**
   * Get NPC count
   */
  getNPCCount(): number {
    return this.npcManager.getCount();
  }

  /**
   * Set collision checker for NPCs
   * Called to check if a position is blocked by terrain, buildings, or other entities
   */
  setNPCCollisionChecker(checker: (x: number, y: number) => boolean): void {
    this.npcManager.setCollisionChecker(checker);
  }

  /**
   * Set global NPC created callback (used by worker for IPC)
   */
  setGlobalNPCCreatedCallback(callback: NPCCreatedCallback): void {
    this.globalNPCCreatedCallback = callback;
    this.npcManager.onNPCCreated(callback);
  }
}
