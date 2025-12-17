import type { Duplex } from 'stream';
import { PixelGameRenderer, InputHandler } from '@maldoror/render';
import { TileProvider, createPlaceholderSprite } from '@maldoror/world';
import type { Direction, AnimationFrame, PlayerVisualState } from '@maldoror/protocol';
import { GameServer } from '../game/game-server.js';
import { OnboardingFlow } from './onboarding.js';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';

interface GameSessionConfig {
  stream: Duplex;
  fingerprint: string;
  username: string;
  userId?: string;
  cols: number;
  rows: number;
  gameServer: GameServer;
  worldSeed: bigint;
}

export class GameSession {
  private stream: Duplex;
  private fingerprint: string;
  private username: string;
  private userId: string | null;
  private cols: number;
  private rows: number;
  private gameServer: GameServer;
  private worldSeed: bigint;
  private renderer: PixelGameRenderer | null = null;
  private inputHandler: InputHandler | null = null;
  private tileProvider: TileProvider | null = null;
  private sessionId: string;
  private destroyed: boolean = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private playerX: number = 0;
  private playerY: number = 0;
  private playerDirection: Direction = 'down';
  private playerAnimationFrame: AnimationFrame = 0;
  private isMoving: boolean = false;
  private inputSequence: number = 0;
  private moveTimer: NodeJS.Timeout | null = null;

  constructor(config: GameSessionConfig) {
    this.stream = config.stream;
    this.fingerprint = config.fingerprint;
    this.username = config.username;
    this.userId = config.userId || null;
    this.cols = config.cols;
    this.rows = config.rows;
    this.gameServer = config.gameServer;
    this.worldSeed = config.worldSeed;
    this.sessionId = crypto.randomUUID();
  }

  async start(): Promise<void> {
    // Handle new vs returning user
    if (!this.userId) {
      // New user - run onboarding
      const onboarding = new OnboardingFlow(this.stream, this.fingerprint);
      const result = await onboarding.run();

      if (!result) {
        // User quit during onboarding
        this.stream.end();
        return;
      }

      this.userId = result.userId;
      this.username = result.username;
    }

    // Load player state
    const playerState = await db.query.playerState.findFirst({
      where: eq(schema.playerState.userId, this.userId),
    });

    if (playerState) {
      this.playerX = playerState.x;
      this.playerY = playerState.y;
      this.playerDirection = (playerState.direction as Direction) || 'down';
    } else {
      // Create initial player state
      await db.insert(schema.playerState).values({
        userId: this.userId,
        x: 0,
        y: 0,
        direction: 'down',
      });
    }

    // Initialize tile provider
    this.tileProvider = new TileProvider({
      worldSeed: this.worldSeed,
      chunkCacheSize: 64,
    });
    this.tileProvider.setLocalPlayerId(this.userId);

    // Set up placeholder sprite for local player
    const placeholderSprite = createPlaceholderSprite({ r: 100, g: 150, b: 255 });
    this.tileProvider.setPlayerSprite(this.userId, placeholderSprite);

    // Update local player state
    this.updateLocalPlayerState();

    // Initialize renderer
    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    // Initialize input handler
    this.inputHandler = new InputHandler();
    this.inputHandler.onAction((action, event) => {
      this.handleAction(action, event);
    });

    // Set up stream handlers
    this.stream.on('data', (data: Buffer) => {
      if (this.inputHandler && !this.destroyed) {
        this.inputHandler.process(data);
      }
    });

    this.stream.on('close', () => {
      this.destroy();
    });

    // Register with game server
    await this.gameServer.playerConnect(this.userId!, this.sessionId);

    // Start render loop (60ms = ~16fps for smooth animation)
    this.tickInterval = setInterval(() => this.tick(), 60);
  }

  private updateLocalPlayerState(): void {
    if (!this.tileProvider || !this.userId) return;

    const state: PlayerVisualState = {
      userId: this.userId,
      username: this.username,
      x: this.playerX,
      y: this.playerY,
      direction: this.playerDirection,
      animationFrame: this.playerAnimationFrame,
      isMoving: this.isMoving,
    };

    this.tileProvider.updatePlayer(state);
  }

  private tick(): void {
    if (this.destroyed || !this.renderer || !this.tileProvider) return;

    // Update animation frame when moving
    if (this.isMoving) {
      this.playerAnimationFrame = ((this.playerAnimationFrame + 1) % 4) as AnimationFrame;
      this.updateLocalPlayerState();
    }

    // Get visible players from game server
    const visiblePlayers = this.gameServer.getVisiblePlayers(
      this.playerX,
      this.playerY,
      this.cols,
      this.rows,
      this.userId!
    );

    // Update other players in tile provider
    for (const player of visiblePlayers) {
      const state: PlayerVisualState = {
        userId: player.userId,
        username: player.username,
        x: player.x,
        y: player.y,
        direction: player.direction as Direction,
        animationFrame: player.animationFrame as AnimationFrame,
        isMoving: false,
      };
      this.tileProvider.updatePlayer(state);

      // Set placeholder sprite if needed
      if (!this.tileProvider.getPlayerSprite(player.userId)) {
        const color = this.getPlayerColor(player.userId);
        this.tileProvider.setPlayerSprite(player.userId, createPlaceholderSprite(color));
      }
    }

    // Center camera on player
    this.renderer.setCamera(this.playerX, this.playerY);

    // Render frame
    this.renderer.render(this.tileProvider);
  }

  private getPlayerColor(userId: string): { r: number; g: number; b: number } {
    // Generate deterministic color from userId
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash) + userId.charCodeAt(i);
      hash = hash & hash;
    }
    return {
      r: ((hash >> 16) & 0xFF),
      g: ((hash >> 8) & 0xFF),
      b: (hash & 0xFF),
    };
  }

  private handleAction(action: string, _event: unknown): void {
    if (this.destroyed) return;

    switch (action) {
      case 'move_up':
        this.move(0, -1, 'up');
        break;
      case 'move_down':
        this.move(0, 1, 'down');
        break;
      case 'move_left':
        this.move(-1, 0, 'left');
        break;
      case 'move_right':
        this.move(1, 0, 'right');
        break;
    }
  }

  private move(dx: number, dy: number, direction: Direction): void {
    // Check if target tile is walkable
    const targetX = this.playerX + dx;
    const targetY = this.playerY + dy;
    const targetTile = this.tileProvider?.getTile(targetX, targetY);

    if (targetTile && !targetTile.walkable) {
      return;  // Can't move to non-walkable tile
    }

    this.playerX = targetX;
    this.playerY = targetY;
    this.playerDirection = direction;
    this.isMoving = true;
    this.inputSequence++;

    // Update local state
    this.updateLocalPlayerState();

    // Queue input for game server
    this.gameServer.queueInput({
      userId: this.userId!,
      sessionId: this.sessionId,
      type: 'move',
      payload: { dx, dy },
      timestamp: Date.now(),
      sequence: this.inputSequence,
    });

    // Update spatial index
    this.gameServer.updatePlayerPosition(this.userId!, this.playerX, this.playerY);

    // Stop "moving" animation after a short delay
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
    }
    this.moveTimer = setTimeout(() => {
      this.isMoving = false;
      this.playerAnimationFrame = 0;
      this.updateLocalPlayerState();
    }, 200);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.renderer) {
      this.renderer.resize(cols, rows);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Stop tick loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }

    // Clean up renderer
    if (this.renderer) {
      this.renderer.cleanup();
    }

    // Save state and disconnect from game server
    if (this.userId) {
      // Save position
      await db
        .update(schema.playerState)
        .set({
          x: this.playerX,
          y: this.playerY,
          direction: this.playerDirection,
          animationFrame: this.playerAnimationFrame,
          isOnline: false,
          lastSeenAt: new Date(),
        })
        .where(eq(schema.playerState.userId, this.userId));

      await this.gameServer.playerDisconnect(this.userId);
    }
  }
}
