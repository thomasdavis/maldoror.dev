import type { Duplex } from 'stream';
import { PixelGameRenderer, InputHandler } from '@maldoror/render';
import { TileProvider, createPlaceholderSprite } from '@maldoror/world';
import type { Direction, AnimationFrame, PlayerVisualState, Sprite } from '@maldoror/protocol';
import { WorkerManager, ReloadState } from './worker-manager.js';
import { OnboardingFlow } from './onboarding.js';
import { AvatarScreen } from './avatar-screen.js';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';
import type { ProviderConfig } from '@maldoror/ai';

interface GameSessionConfig {
  stream: Duplex;
  fingerprint: string;
  username: string;
  userId?: string;
  cols: number;
  rows: number;
  workerManager: WorkerManager;
  worldSeed: bigint;
  providerConfig: ProviderConfig;
}

export class GameSession {
  private stream: Duplex;
  private fingerprint: string;
  private username: string;
  private userId: string | null;
  private cols: number;
  private rows: number;
  private workerManager: WorkerManager;
  private worldSeed: bigint;
  private providerConfig: ProviderConfig;
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
  private currentPrompt: string = '';
  private showPlayerList: boolean = false;
  // Cache for player list (Tab menu)
  private cachedAllPlayers: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    isOnline: boolean;
  }> = [];
  // Performance: Cache visible players query
  private cachedVisiblePlayers: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
  }> = [];
  private lastQueryX: number = -999;
  private lastQueryY: number = -999;
  // Performance: Track sprites being loaded to prevent duplicate DB queries
  private loadingSprites: Set<string> = new Set();
  // Hot reload state
  private reloadState: ReloadState = 'running';
  private unsubscribeReload: (() => void) | null = null;

  constructor(config: GameSessionConfig) {
    this.stream = config.stream;
    this.fingerprint = config.fingerprint;
    this.username = config.username;
    this.userId = config.userId || null;
    this.cols = config.cols;
    this.rows = config.rows;
    this.workerManager = config.workerManager;
    this.worldSeed = config.worldSeed;
    this.providerConfig = config.providerConfig;
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

    // Load avatar from database or use placeholder
    const avatar = await db.query.avatars.findFirst({
      where: eq(schema.avatars.userId, this.userId),
    });

    if (avatar?.spriteJson) {
      this.tileProvider.setPlayerSprite(this.userId, avatar.spriteJson as Sprite);
      this.currentPrompt = avatar.prompt || '';
    } else {
      // Use placeholder sprite
      const placeholderSprite = createPlaceholderSprite({ r: 100, g: 150, b: 255 });
      this.tileProvider.setPlayerSprite(this.userId, placeholderSprite);
    }

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

    // Register with worker manager
    await this.workerManager.playerConnect(this.userId!, this.sessionId, this.username);

    // Register for sprite reload events
    this.workerManager.onSpriteReload(this.userId!, (changedUserId) => {
      this.handleSpriteReload(changedUserId);
    });

    // Subscribe to reload state changes for hot reload overlay
    this.unsubscribeReload = this.workerManager.onReloadState((state) => {
      this.reloadState = state;
      if (state === 'running') {
        // Force a full re-render when reload completes
        this.renderer?.invalidate();
      }
    });

    // Start render loop (60ms = ~16fps for smooth animation)
    this.tickInterval = setInterval(() => this.tick(), 67); // Match server's 15Hz tick rate
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

  private async tick(): Promise<void> {
    if (this.destroyed || !this.renderer || !this.tileProvider) return;

    // Show reload overlay if reloading
    if (this.reloadState === 'reloading') {
      const output = this.renderer.renderToString(this.tileProvider);
      const overlay = this.generateReloadOverlay();
      this.stream.write(output + overlay);
      return;
    }

    // Update animation frame when moving
    if (this.isMoving) {
      this.playerAnimationFrame = ((this.playerAnimationFrame + 1) % 4) as AnimationFrame;
      this.updateLocalPlayerState();
    }

    // Performance: Only re-query visible players when position changes
    const positionChanged = this.playerX !== this.lastQueryX || this.playerY !== this.lastQueryY;
    if (positionChanged) {
      this.cachedVisiblePlayers = await this.workerManager.getVisiblePlayers(
        this.playerX,
        this.playerY,
        this.cols,
        this.rows,
        this.userId!
      );
      this.lastQueryX = this.playerX;
      this.lastQueryY = this.playerY;
    }

    // Update other players in tile provider
    for (const player of this.cachedVisiblePlayers) {
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

      // Performance: Load sprite if not already loaded AND not already loading
      if (!this.tileProvider.getPlayerSprite(player.userId) && !this.loadingSprites.has(player.userId)) {
        // Set placeholder immediately for rendering
        const color = this.getPlayerColor(player.userId);
        this.tileProvider.setPlayerSprite(player.userId, createPlaceholderSprite(color));

        // Mark as loading and load actual sprite from database asynchronously
        this.loadingSprites.add(player.userId);
        this.loadPlayerSprite(player.userId);
      }
    }

    // Center camera on player
    this.renderer.setCamera(this.playerX, this.playerY);

    // Performance: Batch all output into single write
    let output = this.renderer.renderToString(this.tileProvider);

    // Add player list overlay if showing
    if (this.showPlayerList) {
      output += this.generatePlayerListOverlay();
    }

    // Single write for entire frame
    if (output) {
      this.stream.write(output);
    }
  }

  /**
   * Generate the player list overlay (Tab menu) as a string
   */
  private generatePlayerListOverlay(): string {
    const ESC = '\x1b';
    const players = this.cachedAllPlayers;

    // Calculate overlay dimensions
    const overlayWidth = 50;
    const overlayHeight = Math.min(players.length + 4, 20);
    const startX = Math.floor((this.cols - overlayWidth) / 2);
    const startY = Math.floor((this.rows - overlayHeight) / 2);

    // Semi-transparent background using dark color
    const bgColor = `${ESC}[48;2;20;20;35m`;
    const borderColor = `${ESC}[38;2;100;100;150m`;
    const headerColor = `${ESC}[38;2;255;200;100m`;
    const textColor = `${ESC}[38;2;200;200;200m`;
    const selfColor = `${ESC}[38;2;100;255;150m`;
    const reset = `${ESC}[0m`;

    let output = '';

    // Draw overlay box
    // Top border
    output += `${ESC}[${startY};${startX}H${bgColor}${borderColor}╔${'═'.repeat(overlayWidth - 2)}╗`;

    // Title row
    const title = ` PLAYERS ONLINE (${players.length}) `;
    const titlePad = Math.floor((overlayWidth - 2 - title.length) / 2);
    output += `${ESC}[${startY + 1};${startX}H${bgColor}${borderColor}║${' '.repeat(titlePad)}${headerColor}${title}${borderColor}${' '.repeat(overlayWidth - 2 - titlePad - title.length)}║`;

    // Separator
    output += `${ESC}[${startY + 2};${startX}H${bgColor}${borderColor}╟${'─'.repeat(overlayWidth - 2)}╢`;

    // Column headers
    const nameHeader = 'Name';
    const posHeader = 'Position';
    const pingHeader = 'Ping';
    output += `${ESC}[${startY + 3};${startX}H${bgColor}${borderColor}║ ${headerColor}${nameHeader.padEnd(20)}${posHeader.padEnd(18)}${pingHeader.padEnd(8)}${borderColor}║`;

    // Player rows
    const maxPlayers = Math.min(players.length, overlayHeight - 5);
    for (let i = 0; i < maxPlayers; i++) {
      const player = players[i]!;
      const isSelf = player.userId === this.userId;
      const color = isSelf ? selfColor : textColor;
      const name = (isSelf ? '► ' : '  ') + player.username.slice(0, 16).padEnd(18);
      const pos = `(${player.x}, ${player.y})`.padEnd(18);
      const ping = '--ms'.padEnd(8);  // TODO: actual ping

      output += `${ESC}[${startY + 4 + i};${startX}H${bgColor}${borderColor}║${color}${name}${pos}${ping}${borderColor}║`;
    }

    // Fill remaining rows
    for (let i = maxPlayers; i < overlayHeight - 5; i++) {
      output += `${ESC}[${startY + 4 + i};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;
    }

    // Bottom border
    output += `${ESC}[${startY + overlayHeight - 1};${startX}H${bgColor}${borderColor}╚${'═'.repeat(overlayWidth - 2)}╝`;

    // Footer hint
    const hint = ' Press TAB to close ';
    output += `${ESC}[${startY + overlayHeight};${startX + Math.floor((overlayWidth - hint.length) / 2)}H${textColor}${hint}`;

    output += reset;

    return output;
  }

  /**
   * Generate the reload/reconnecting overlay
   */
  private generateReloadOverlay(): string {
    const ESC = '\x1b';

    // Calculate overlay dimensions
    const overlayWidth = 40;
    const overlayHeight = 7;
    const startX = Math.floor((this.cols - overlayWidth) / 2);
    const startY = Math.floor((this.rows - overlayHeight) / 2);

    // Colors
    const bgColor = `${ESC}[48;2;20;20;35m`;
    const borderColor = `${ESC}[38;2;100;100;150m`;
    const textColor = `${ESC}[38;2;255;200;100m`;
    const subTextColor = `${ESC}[38;2;150;150;170m`;
    const reset = `${ESC}[0m`;

    // Spinner frames
    const spinnerFrames = ['◐', '◓', '◑', '◒'];
    const spinnerFrame = spinnerFrames[Math.floor(Date.now() / 200) % spinnerFrames.length];

    let output = '';

    // Top border
    output += `${ESC}[${startY};${startX}H${bgColor}${borderColor}╔${'═'.repeat(overlayWidth - 2)}╗`;

    // Empty row
    output += `${ESC}[${startY + 1};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Main message with spinner
    const message = ` ${spinnerFrame} Updating Server... `;
    const msgPad = Math.floor((overlayWidth - 2 - message.length) / 2);
    output += `${ESC}[${startY + 2};${startX}H${bgColor}${borderColor}║${' '.repeat(msgPad)}${textColor}${message}${' '.repeat(overlayWidth - 2 - msgPad - message.length)}${borderColor}║`;

    // Empty row
    output += `${ESC}[${startY + 3};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Sub message
    const subMessage = 'Please wait...';
    const subPad = Math.floor((overlayWidth - 2 - subMessage.length) / 2);
    output += `${ESC}[${startY + 4};${startX}H${bgColor}${borderColor}║${' '.repeat(subPad)}${subTextColor}${subMessage}${' '.repeat(overlayWidth - 2 - subPad - subMessage.length)}${borderColor}║`;

    // Empty row
    output += `${ESC}[${startY + 5};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Bottom border
    output += `${ESC}[${startY + 6};${startX}H${bgColor}${borderColor}╚${'═'.repeat(overlayWidth - 2)}╝`;

    output += reset;

    return output;
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
      case 'zoom_in':
        this.renderer?.zoomIn();
        break;
      case 'zoom_out':
        this.renderer?.zoomOut();
        break;
      case 'cycle_render_mode':
        this.renderer?.cycleRenderMode();
        break;
      case 'regenerate_avatar':
        this.openAvatarScreen();
        break;
      case 'toggle_players':
        this.togglePlayerList();
        break;
      case 'toggle_camera_mode':
        this.toggleCameraMode();
        break;
      case 'snap_to_player':
        this.snapCameraToPlayer();
        break;
      case 'pan_camera_up':
        this.panCamera(0, -1);
        break;
      case 'pan_camera_down':
        this.panCamera(0, 1);
        break;
      case 'pan_camera_left':
        this.panCamera(-1, 0);
        break;
      case 'pan_camera_right':
        this.panCamera(1, 0);
        break;
      case 'quit':
        this.quit();
        break;
    }
  }

  /**
   * Toggle the player list overlay
   */
  private async togglePlayerList(): Promise<void> {
    this.showPlayerList = !this.showPlayerList;
    if (this.showPlayerList) {
      // Fetch fresh player list when opening
      this.cachedAllPlayers = await this.workerManager.getAllPlayers();
    }
    this.renderer?.invalidate();
  }

  /**
   * Toggle between follow and free camera modes
   */
  private toggleCameraMode(): void {
    if (!this.renderer) return;
    this.renderer.toggleCameraMode();
    // When switching to free mode, camera stays at current position
    // When switching back to follow mode, it will snap to player on next tick
    this.renderer.invalidate();
  }

  /**
   * Snap camera back to player position
   */
  private snapCameraToPlayer(): void {
    if (!this.renderer) return;
    this.renderer.snapCameraToPlayer();
    // Also switch back to follow mode
    this.renderer.setCameraMode('follow');
    this.renderer.invalidate();
  }

  /**
   * Pan camera by tile offset (for free camera mode)
   */
  private panCamera(dx: number, dy: number): void {
    if (!this.renderer) return;
    // Auto-switch to free mode when panning
    if (this.renderer.getCameraMode() === 'follow') {
      this.renderer.setCameraMode('free');
    }
    this.renderer.panCameraByTiles(dx, dy);
    this.renderer.invalidate();
  }

  /**
   * Gracefully quit the session
   */
  private async quit(): Promise<void> {
    await this.destroy();
    this.stream.end();
  }

  /**
   * Open the avatar regeneration screen
   */
  private async openAvatarScreen(): Promise<void> {
    // Pause render loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Clean up current renderer state
    this.renderer?.cleanup();

    // Run avatar screen
    const screen = new AvatarScreen({
      stream: this.stream,
      currentPrompt: this.currentPrompt,
      providerConfig: this.providerConfig,
      username: this.username,
    });

    const result = await screen.run();

    if (result.action === 'confirm' && result.sprite && result.prompt) {
      // Update local prompt
      this.currentPrompt = result.prompt;

      // Save to database
      await this.saveAvatar(result.prompt, result.sprite);

      // Update local sprite
      if (this.tileProvider && this.userId) {
        this.tileProvider.setPlayerSprite(this.userId, result.sprite);
      }

      // Broadcast to all players
      await this.workerManager.broadcastSpriteReload(this.userId!);
    }

    // Reinitialize renderer
    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    // Resume render loop
    this.renderer.invalidate();
    this.tickInterval = setInterval(() => this.tick(), 67); // Match server's 15Hz tick rate
  }

  /**
   * Save avatar to database
   */
  private async saveAvatar(prompt: string, sprite: Sprite): Promise<void> {
    if (!this.userId) return;

    await db
      .update(schema.avatars)
      .set({
        prompt,
        spriteJson: sprite as any, // Sprite is compatible with storage format
        generationStatus: 'completed',
        modelUsed: this.providerConfig.model || 'default',
        updatedAt: new Date(),
      })
      .where(eq(schema.avatars.userId, this.userId));
  }

  /**
   * Handle sprite reload event from another player
   */
  private async handleSpriteReload(changedUserId: string): Promise<void> {
    if (!this.tileProvider) return;

    // Clear cached sprite for this user
    this.tileProvider.setPlayerSprite(changedUserId, createPlaceholderSprite(this.getPlayerColor(changedUserId)));

    // Load from database
    try {
      const avatar = await db.query.avatars.findFirst({
        where: eq(schema.avatars.userId, changedUserId),
      });

      if (avatar?.spriteJson) {
        this.tileProvider.setPlayerSprite(changedUserId, avatar.spriteJson as Sprite);
      }
    } catch (error) {
      console.error(`Failed to reload sprite for ${changedUserId}:`, error);
    }
  }

  /**
   * Load sprite for another player from database
   */
  private async loadPlayerSprite(playerId: string): Promise<void> {
    if (!this.tileProvider) return;

    try {
      const avatar = await db.query.avatars.findFirst({
        where: eq(schema.avatars.userId, playerId),
      });

      if (avatar?.spriteJson) {
        this.tileProvider.setPlayerSprite(playerId, avatar.spriteJson as Sprite);
      }
    } catch (error) {
      console.error(`Failed to load sprite for ${playerId}:`, error);
    } finally {
      // Performance: Clear from loading set so we don't re-query
      this.loadingSprites.delete(playerId);
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

    // Queue input for worker manager
    this.workerManager.queueInput({
      userId: this.userId!,
      sessionId: this.sessionId,
      type: 'move',
      payload: { dx, dy },
      timestamp: Date.now(),
      sequence: this.inputSequence,
    });

    // Update spatial index
    this.workerManager.updatePlayerPosition(this.userId!, this.playerX, this.playerY);

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

    // Unsubscribe from reload state changes
    if (this.unsubscribeReload) {
      this.unsubscribeReload();
      this.unsubscribeReload = null;
    }

    // Clean up renderer
    if (this.renderer) {
      this.renderer.cleanup();
    }

    // Save state and disconnect from worker manager
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

      await this.workerManager.playerDisconnect(this.userId);
    }
  }
}
