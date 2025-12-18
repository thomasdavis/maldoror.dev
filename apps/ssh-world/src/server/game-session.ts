import type { Duplex } from 'stream';
import { PixelGameRenderer, InputHandler } from '@maldoror/render';
import { TileProvider, createPlaceholderSprite } from '@maldoror/world';
import type { Direction, AnimationFrame, PlayerVisualState, Sprite, BuildingSprite } from '@maldoror/protocol';
import { getBuildingTilePositions } from '@maldoror/protocol';
import { WorkerManager, ReloadState } from './worker-manager.js';
import { OnboardingFlow } from './onboarding.js';
import { AvatarScreen } from './avatar-screen.js';
import { BuildingScreen } from './building-screen.js';
import { db, schema } from '@maldoror/db';
import { eq, and, between } from 'drizzle-orm';
import type { ProviderConfig } from '@maldoror/ai';
import { saveSpriteToDisk, loadSpriteFromDisk } from '../utils/sprite-storage.js';
import { saveBuildingToDisk, loadBuildingFromDisk } from '../utils/building-storage.js';

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
  private inputPaused: boolean = false;
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
  private tickCounter: number = 0;
  // Performance: Track sprites being loaded to prevent duplicate DB queries
  private loadingSprites: Set<string> = new Set();
  // Hot reload state
  private reloadState: ReloadState = 'running';
  private unsubscribeReload: (() => void) | null = null;
  // Adaptive tick rate based on zoom level
  private currentTickMs: number = 67;  // Default 15fps

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

    // Load avatar - try file first, then database fallback
    let sprite = await loadSpriteFromDisk(this.userId);
    const avatar = await db.query.avatars.findFirst({
      where: eq(schema.avatars.userId, this.userId),
    });

    if (sprite) {
      this.tileProvider.setPlayerSprite(this.userId, sprite);
      this.currentPrompt = avatar?.prompt || '';
    } else if (avatar?.spriteJson) {
      // Fallback to database (for existing sprites before file storage)
      this.tileProvider.setPlayerSprite(this.userId, avatar.spriteJson as Sprite);
      this.currentPrompt = avatar.prompt || '';
    } else {
      // Use placeholder sprite
      const placeholderSprite = createPlaceholderSprite({ r: 100, g: 150, b: 255 });
      this.tileProvider.setPlayerSprite(this.userId, placeholderSprite);
    }

    // Load nearby buildings
    await this.loadNearbyBuildings();

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
      if (this.inputHandler && !this.destroyed && !this.inputPaused) {
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

    // Register for building placement events
    this.workerManager.onBuildingPlacement(this.userId!, (buildingId, anchorX, anchorY) => {
      this.handleBuildingPlacement(buildingId, anchorX, anchorY);
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

    // Increment tick counter for periodic refreshes
    this.tickCounter++;

    // Refresh visible players when position changes OR periodically (every ~1 second = 15 ticks)
    const positionChanged = this.playerX !== this.lastQueryX || this.playerY !== this.lastQueryY;
    const periodicRefresh = this.tickCounter % 15 === 0;
    if (positionChanged || periodicRefresh) {
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
        this.updateTickInterval();
        break;
      case 'zoom_out':
        this.renderer?.zoomOut();
        this.updateTickInterval();
        break;
      case 'cycle_render_mode':
        this.renderer?.cycleRenderMode();
        break;
      case 'regenerate_avatar':
        this.openAvatarScreen();
        break;
      case 'place_building':
        this.openBuildingScreen();
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
    // Pause input handling to prevent game from processing avatar screen input
    this.inputPaused = true;

    // Pause render loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Clean up current renderer state
    this.renderer?.cleanup();

    try {
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
        try {
          await this.saveAvatar(result.prompt, result.sprite);
        } catch (err) {
          console.error('Failed to save avatar:', err);
        }

        // Update local sprite
        if (this.tileProvider && this.userId) {
          this.tileProvider.setPlayerSprite(this.userId, result.sprite);
        }

        // Broadcast to all players
        if (this.userId) {
          try {
            await this.workerManager.broadcastSpriteReload(this.userId);
          } catch (err) {
            console.error('Failed to broadcast sprite reload:', err);
          }
        }
      }
    } catch (err) {
      console.error('Avatar screen error:', err);
    }

    // Always reinitialize renderer and resume input
    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    // Resume input handling and render loop
    this.inputPaused = false;
    this.renderer.invalidate();
    this.tickInterval = setInterval(() => this.tick(), 67); // Match server's 15Hz tick rate
  }

  /**
   * Save avatar - sprite to file, metadata to database
   */
  private async saveAvatar(prompt: string, sprite: Sprite): Promise<void> {
    if (!this.userId) return;

    // Save sprite to file (avoids 78MB JSONB in PostgreSQL)
    await saveSpriteToDisk(this.userId, sprite);

    // Save metadata to database (no spriteJson)
    await db
      .update(schema.avatars)
      .set({
        prompt,
        generationStatus: 'completed',
        modelUsed: this.providerConfig.model || 'default',
        updatedAt: new Date(),
      })
      .where(eq(schema.avatars.userId, this.userId));
  }

  /**
   * Open the building placement screen
   */
  private async openBuildingScreen(): Promise<void> {
    // Pause input handling
    this.inputPaused = true;

    // Pause render loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Clean up current renderer state
    this.renderer?.cleanup();

    try {
      // Run building screen
      const screen = new BuildingScreen({
        stream: this.stream,
        providerConfig: this.providerConfig,
        username: this.username,
        playerX: this.playerX,
        playerY: this.playerY,
      });

      const result = await screen.run();

      if (result.action === 'confirm' && result.sprite && result.prompt) {
        // Save building
        try {
          await this.saveBuilding(result.prompt, result.sprite);
        } catch (err) {
          console.error('Failed to save building:', err);
        }
      }
    } catch (err) {
      console.error('Building screen error:', err);
    }

    // Reinitialize renderer and resume
    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    // Resume input handling and render loop
    this.inputPaused = false;
    this.renderer.invalidate();
    this.tickInterval = setInterval(() => this.tick(), 67);
  }

  /**
   * Save building - sprite to file, metadata to database
   */
  private async saveBuilding(prompt: string, sprite: BuildingSprite): Promise<void> {
    if (!this.userId) return;

    // Calculate anchor position (bottom-center of building, one tile above player)
    const anchorX = this.playerX;
    const anchorY = this.playerY - 1;

    // Check if any building tiles would overlap with existing buildings
    const positions = getBuildingTilePositions(anchorX, anchorY);
    for (const [x, y] of positions) {
      if (this.tileProvider?.isBuildingAt(x, y)) {
        console.log(`[Building] Cannot place - tile (${x}, ${y}) already occupied`);
        return;
      }
    }

    // Create building record in database
    const [building] = await db
      .insert(schema.buildings)
      .values({
        ownerId: this.userId,
        anchorX,
        anchorY,
        prompt,
        modelUsed: this.providerConfig.model || 'gpt-image-1',
      })
      .returning({ id: schema.buildings.id });

    if (!building) {
      console.error('[Building] Failed to create building record');
      return;
    }

    // Save sprite to file
    await saveBuildingToDisk(building.id, sprite);

    // Add building to tile provider
    this.tileProvider?.setBuilding(building.id, anchorX, anchorY, sprite);

    // Broadcast building placement to other players
    try {
      await this.workerManager.broadcastBuildingPlacement(building.id, anchorX, anchorY);
    } catch (err) {
      console.error('Failed to broadcast building placement:', err);
    }

    console.log(`[Building] Placed building ${building.id} at (${anchorX}, ${anchorY})`);
  }

  /**
   * Load nearby buildings into the tile provider
   */
  private async loadNearbyBuildings(): Promise<void> {
    if (!this.tileProvider) return;

    // Load buildings within a reasonable range (e.g., 50 tiles in each direction)
    const range = 50;
    const buildings = await db.query.buildings.findMany({
      where: and(
        between(schema.buildings.anchorX, this.playerX - range, this.playerX + range),
        between(schema.buildings.anchorY, this.playerY - range, this.playerY + range)
      ),
    });

    for (const building of buildings) {
      // Skip if already loaded
      if (this.tileProvider.getBuildingAt(building.anchorX, building.anchorY)) {
        continue;
      }

      // Load sprite from disk
      const sprite = await loadBuildingFromDisk(building.id);
      if (sprite) {
        this.tileProvider.setBuilding(building.id, building.anchorX, building.anchorY, sprite);
      }
    }
  }

  /**
   * Handle building placement broadcast from another player
   */
  private async handleBuildingPlacement(buildingId: string, anchorX: number, anchorY: number): Promise<void> {
    if (!this.tileProvider) return;

    // Skip if already loaded
    if (this.tileProvider.getBuildingAt(anchorX, anchorY)) {
      return;
    }

    // Load building sprite from disk
    const sprite = await loadBuildingFromDisk(buildingId);
    if (sprite) {
      this.tileProvider.setBuilding(buildingId, anchorX, anchorY, sprite);
      console.log(`[Building] Received building ${buildingId} at (${anchorX}, ${anchorY})`);
    }
  }

  /**
   * Handle sprite reload event from another player
   */
  private async handleSpriteReload(changedUserId: string): Promise<void> {
    if (!this.tileProvider) return;

    // Clear cached sprite for this user
    this.tileProvider.setPlayerSprite(changedUserId, createPlaceholderSprite(this.getPlayerColor(changedUserId)));

    // Load from file first, then database fallback
    try {
      const sprite = await loadSpriteFromDisk(changedUserId);
      if (sprite) {
        this.tileProvider.setPlayerSprite(changedUserId, sprite);
        return;
      }

      // Fallback to database (for existing sprites before file storage)
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
   * Load sprite for another player
   */
  private async loadPlayerSprite(playerId: string): Promise<void> {
    if (!this.tileProvider) return;

    try {
      // Try file first
      const sprite = await loadSpriteFromDisk(playerId);
      if (sprite) {
        this.tileProvider.setPlayerSprite(playerId, sprite);
        return;
      }

      // Fallback to database (for existing sprites before file storage)
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

    // Check building collision
    if (this.tileProvider?.isBuildingAt(targetX, targetY)) {
      return;  // Can't move into building tile
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

  /**
   * Calculate appropriate tick interval based on zoom level
   * Higher zoom = more pixels = slower updates acceptable
   */
  private getTargetTickMs(): number {
    if (!this.renderer) return 67;
    const zoom = this.renderer.getZoomLevel();

    // 0-30% zoom: 67ms (15 fps) - less data, can update fast
    // 40-60% zoom: 100ms (10 fps) - medium data
    // 70-100% zoom: 150ms (~7 fps) - lots of data, slow updates ok
    if (zoom <= 30) return 67;
    if (zoom <= 60) return 100;
    return 150;
  }

  /**
   * Update tick interval based on current zoom level
   */
  private updateTickInterval(): void {
    const targetMs = this.getTargetTickMs();
    if (targetMs === this.currentTickMs) return;  // No change needed

    this.currentTickMs = targetMs;

    // Restart tick interval with new timing
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = setInterval(() => this.tick(), this.currentTickMs);
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
