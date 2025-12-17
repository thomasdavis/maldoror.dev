import { ChunkCache, ChunkGenerator, SpatialIndex, GameLoop } from '@maldoror/world';
import type { PlayerInput, Direction } from '@maldoror/protocol';

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
}

interface ChatMessage {
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

type ChatCallback = (message: ChatMessage) => void;

/**
 * Main game server coordinating all systems
 */
export class GameServer {
  private config: GameServerConfig;
  private chunkGenerator: ChunkGenerator;
  private chunkCache: ChunkCache;
  private spatialIndex: SpatialIndex;
  private gameLoop: GameLoop;
  private players: Map<string, PlayerState> = new Map();
  private inputQueue: PlayerInput[] = [];
  private chatCallbacks: Map<string, ChatCallback> = new Map();
  private recentChat: ChatMessage[] = [];

  constructor(config: GameServerConfig) {
    this.config = config;

    // Initialize world systems
    this.chunkGenerator = new ChunkGenerator(config.worldSeed);
    this.chunkCache = new ChunkCache(this.chunkGenerator, config.chunkCacheSize);
    this.spatialIndex = new SpatialIndex();

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
      // Update animation frames
      for (const player of this.players.values()) {
        if (player.isOnline) {
          // Cycle animation
          player.animationFrame = (ctx.tick % 4) as 0 | 1 | 2 | 3;
        }
      }
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
  async playerConnect(userId: string, sessionId: string): Promise<void> {
    const existing = this.players.get(userId);

    if (existing) {
      // Reconnect
      existing.sessionId = sessionId;
      existing.isOnline = true;
    } else {
      // New player
      this.players.set(userId, {
        userId,
        sessionId,
        username: '', // Will be set by session
        x: 0,
        y: 0,
        direction: 'down',
        animationFrame: 0,
        isOnline: true,
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
}
