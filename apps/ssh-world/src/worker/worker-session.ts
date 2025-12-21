/**
 * WorkerSession - Game session running in worker process
 *
 * This is the worker-side counterpart to SessionProxy. It runs the actual
 * game logic (rendering, input handling, player state) in the worker process,
 * which allows the game code to be hot-reloaded without disconnecting SSH.
 *
 * Key differences from GameSession (main process):
 * - Uses VirtualStream instead of real SSH stream
 * - Has direct access to GameServer (no IPC)
 * - Sends output back to main via IPC
 */

import {
  PixelGameRenderer,
  ComponentManager,
  InputRouter,
  HelpModalComponent,
  PlayerListComponent,
  ReloadOverlayComponent,
  BG_PRIMARY,
  CRIMSON_BRIGHT,
  ACCENT_GOLD,
  fg,
  bg,
} from '@maldoror/render';
import { TileProvider, createPlaceholderSprite } from '@maldoror/world';
import type { Direction, AnimationFrame, PlayerVisualState, Sprite } from '@maldoror/protocol';
import type { DirectionalBuildingSprite } from '@maldoror/ai';
import { getBuildingTilePositions } from '@maldoror/protocol';
import type { GameServer } from '../game/game-server.js';
import { OnboardingFlow } from '../server/onboarding.js';
import { AvatarScreen } from '../server/avatar-screen.js';
import { BuildingScreen } from '../server/building-screen.js';
import { NPCScreen } from '../server/npc-screen.js';
import { BootScreen } from '../server/boot-screen.js';
import { db, schema } from '@maldoror/db';
import { eq, and, between, inArray } from 'drizzle-orm';
import type { ProviderConfig } from '@maldoror/ai';
import { saveSpriteToDisk, loadSpriteFromDisk } from '../utils/sprite-storage.js';
import { saveBuildingToDisk, loadAllBuildingDirections } from '../utils/building-storage.js';
import { VirtualStream } from './virtual-stream.js';
import type { SessionState } from './game-worker.js';

export interface WorkerSessionConfig {
  sessionId: string;
  fingerprint: string;
  username: string;
  userId: string | null;
  cols: number;
  rows: number;
  gameServer: GameServer;
  worldSeed: bigint;
  providerConfig: ProviderConfig;
  sendOutput: (sessionId: string, output: string) => void;
  sendUserId: (sessionId: string, userId: string) => void;
  sendEnded: (sessionId: string) => void;
  restoredState?: SessionState;
}

export class WorkerSession {
  private sessionId: string;
  private stream: VirtualStream;
  private fingerprint: string;
  private username: string;
  private userId: string | null;
  private cols: number;
  private rows: number;
  private gameServer: GameServer;
  private worldSeed: bigint;
  private providerConfig: ProviderConfig;
  private sendUserId: (sessionId: string, userId: string) => void;
  private sendEnded: (sessionId: string) => void;

  private renderer: PixelGameRenderer | null = null;
  private componentManager: ComponentManager | null = null;
  private inputRouter: InputRouter | null = null;
  private helpModal: HelpModalComponent | null = null;
  private playerListModal: PlayerListComponent | null = null;
  private reloadOverlay: ReloadOverlayComponent | null = null;
  private tileProvider: TileProvider | null = null;
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

  // Performance caches
  private cachedAllPlayers: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    isOnline: boolean;
  }> = [];
  private cachedVisiblePlayers: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
  }> = [];
  private cachedVisibleNPCs: Array<{
    npcId: string;
    name: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
    isMoving: boolean;
  }> = [];
  private lastQueryX: number = -999;
  private lastQueryY: number = -999;
  private tickCounter: number = 0;
  private loadingSprites: Set<string> = new Set();
  private loadingNPCSprites: Set<string> = new Set();

  // Movement tracking
  private consecutiveMoveDirection: Direction | null = null;
  private consecutiveMoveCount: number = 0;
  private readonly MOMENTUM_THRESHOLD = 3;

  // State restoration for hot-reload
  private restoredState?: SessionState;

  constructor(config: WorkerSessionConfig) {
    this.sessionId = config.sessionId;
    this.fingerprint = config.fingerprint;
    this.username = config.username;
    this.userId = config.userId;
    this.cols = config.cols;
    this.rows = config.rows;
    this.gameServer = config.gameServer;
    this.worldSeed = config.worldSeed;
    this.providerConfig = config.providerConfig;
    this.sendUserId = config.sendUserId;
    this.sendEnded = config.sendEnded;
    this.restoredState = config.restoredState;

    // Create virtual stream that sends output to main process
    this.stream = new VirtualStream(config.sessionId, config.sendOutput);
  }

  /**
   * Get serializable state for hot-reload preservation
   */
  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      playerX: this.playerX,
      playerY: this.playerY,
      zoomLevel: this.renderer?.getZoomLevel() ?? 1,
      renderMode: this.renderer?.getRenderMode() ?? 'pixel',
      cameraMode: this.renderer?.getCameraMode() ?? 'follow',
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Handle input data from main process
   */
  handleInput(data: Buffer): void {
    if (this.destroyed) return;

    if (this.inputPaused || !this.inputRouter) {
      // When paused (modal screens open) OR during onboarding (before inputRouter exists),
      // push input to stream so screens can receive it via stream.on('data', ...)
      this.stream.pushInput(data);
    } else {
      // Normal game mode - route through InputRouter
      this.inputRouter.process(data);
    }
  }

  /**
   * Handle resize event from main process
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.renderer) {
      this.renderer.resize(cols, rows);
    }
    if (this.componentManager) {
      this.componentManager.resize(cols, rows);
    }
    this.helpModal?.updateScreenSize(cols, rows);
    this.playerListModal?.updateScreenSize(cols, rows);
    this.reloadOverlay?.updateScreenSize(cols, rows);
  }

  async start(): Promise<void> {
    // Check if this is a hot-reload restoration
    const isRestoring = !!this.restoredState;

    // Handle new vs returning user
    if (!this.userId) {
      // New user - run onboarding
      const onboarding = new OnboardingFlow(this.stream, this.fingerprint);
      const result = await onboarding.run();

      if (!result) {
        // User quit during onboarding
        this.sendEnded(this.sessionId);
        return;
      }

      this.userId = result.userId;
      this.username = result.username;
      // Notify main process of new userId
      this.sendUserId(this.sessionId, this.userId);
    }

    // Skip boot screen for hot-reload restoration
    let boot: BootScreen | null = null;
    if (!isRestoring) {
      boot = new BootScreen(this.stream, this.cols, this.rows);
      boot.show();

      // Fetch online players for honourable mentions
      const allPlayers = this.gameServer.getAllPlayers();
      const onlinePlayers = allPlayers
        .filter(p => p.isOnline && p.userId !== this.userId)
        .map(p => ({ username: p.username }));
      boot.renderHonourableMentions(onlinePlayers);
      boot.updateStep('Loading player state...', 'loading');
    }

    // Load player state - use restored state if available
    if (isRestoring && this.restoredState) {
      this.playerX = this.restoredState.playerX;
      this.playerY = this.restoredState.playerY;
      // Keep current direction
    } else {
      const playerState = await db.query.playerState.findFirst({
        where: eq(schema.playerState.userId, this.userId!),
      });

      if (playerState) {
        this.playerX = playerState.x;
        this.playerY = playerState.y;
        this.playerDirection = (playerState.direction as Direction) || 'down';
      } else {
        // Create initial player state
        await db.insert(schema.playerState).values({
          userId: this.userId!,
          x: 0,
          y: 0,
          direction: 'down',
        });
      }
    }
    boot?.markPreviousDone();

    // Initialize tile provider
    boot?.updateStep('Generating world chunks...', 'loading');
    this.tileProvider = new TileProvider({
      worldSeed: this.worldSeed,
      chunkCacheSize: 64,
    });
    this.tileProvider.setLocalPlayerId(this.userId!);
    boot?.markPreviousDone();

    // Load avatar
    boot?.updateStep('Loading avatar sprites...', 'loading');
    let sprite = await loadSpriteFromDisk(this.userId!);
    const avatar = await db.query.avatars.findFirst({
      where: eq(schema.avatars.userId, this.userId!),
    });

    if (sprite) {
      this.tileProvider.setPlayerSprite(this.userId!, sprite);
      this.currentPrompt = avatar?.prompt || '';
    } else if (avatar?.spriteJson) {
      this.tileProvider.setPlayerSprite(this.userId!, avatar.spriteJson as Sprite);
      this.currentPrompt = avatar.prompt || '';
    } else {
      const placeholderSprite = createPlaceholderSprite({ r: 100, g: 150, b: 255 });
      this.tileProvider.setPlayerSprite(this.userId!, placeholderSprite);
    }
    boot?.markPreviousDone();

    // Load nearby buildings
    boot?.updateStep('Loading nearby buildings...', 'loading');
    await this.loadNearbyBuildings();
    boot?.markPreviousDone();

    // Load nearby roads
    boot?.updateStep('Loading nearby roads...', 'loading');
    await this.loadNearbyRoads();
    boot?.markPreviousDone();

    // Update local player state
    this.updateLocalPlayerState();

    // Initialize renderer
    boot?.updateStep('Initializing renderer...', 'loading');
    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    boot?.markPreviousDone();

    // Initialize component manager
    this.componentManager = new ComponentManager(this.cols, this.rows);

    // Create modal components
    this.helpModal = new HelpModalComponent(this.cols, this.rows);
    this.helpModal.setOnClose(() => this.componentManager?.popFocus());
    this.componentManager.addComponent(this.helpModal);

    this.playerListModal = new PlayerListComponent(this.cols, this.rows);
    this.playerListModal.setOnClose(() => this.componentManager?.popFocus());
    this.componentManager.addComponent(this.playerListModal);

    this.reloadOverlay = new ReloadOverlayComponent(this.cols, this.rows);
    this.componentManager.addComponent(this.reloadOverlay);

    // Initialize input router
    this.inputRouter = new InputRouter(this.componentManager);
    this.inputRouter.setFallbackHandler((action, event) => {
      this.handleAction(action, event);
    });

    // Set up stream handlers (for VirtualStream)
    this.stream.on('data', (data: Buffer) => {
      if (this.inputRouter && !this.destroyed && !this.inputPaused) {
        this.inputRouter.process(data);
      }
    });

    // Register with game server (direct, no IPC)
    boot?.updateStep('Connecting to game server...', 'loading');
    await this.gameServer.playerConnect(this.userId!, this.sessionId, this.username);

    // Register road callbacks to receive updates from other players
    this.gameServer.onRoadPlacement(this.userId!, (x, y, placedBy) => {
      if (placedBy !== this.userId && this.tileProvider) {
        this.tileProvider.setRoad(x, y, placedBy);
      }
    });
    this.gameServer.onRoadRemoval(this.userId!, (x, y) => {
      if (this.tileProvider) {
        this.tileProvider.removeRoad(x, y);
      }
    });
    boot?.markPreviousDone();

    // Clean up boot screen and start game
    boot?.hide();

    // Restore renderer state if hot-reloading
    if (isRestoring && this.restoredState) {
      this.renderer.setZoomLevel(this.restoredState.zoomLevel);
      this.renderer.setRenderMode(this.restoredState.renderMode as 'normal' | 'halfblock' | 'braille');
      this.renderer.setCameraMode(this.restoredState.cameraMode as 'follow' | 'free');
    }

    // Show entrance screen (skip for hot-reload)
    if (!isRestoring) {
      await this.showEntranceScreen();
    }

    // Initialize the renderer
    this.renderer.initialize();

    // Start render loop
    this.tickInterval = setInterval(() => this.tick(), 67);
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

    this.tickCounter++;

    // Refresh visible players/NPCs periodically
    this.refreshVisiblePlayersIfNeeded();
    this.refreshVisibleNPCsIfNeeded();

    // Update other players
    const missingPlayerIds: string[] = [];
    for (const player of this.cachedVisiblePlayers) {
      if (player.userId === this.userId) continue;

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

      if (!this.tileProvider.getPlayerSprite(player.userId) && !this.loadingSprites.has(player.userId)) {
        const color = this.getPlayerColor(player.userId);
        this.tileProvider.setPlayerSprite(player.userId, createPlaceholderSprite(color));
        missingPlayerIds.push(player.userId);
      }
    }

    if (missingPlayerIds.length > 0) {
      missingPlayerIds.forEach(id => this.loadingSprites.add(id));
      void this.batchLoadPlayerSprites(missingPlayerIds);
    }

    // Update visible NPCs
    const missingNPCIds: string[] = [];
    for (const npc of this.cachedVisibleNPCs) {
      this.tileProvider.updateNPC({
        npcId: npc.npcId,
        name: npc.name,
        x: npc.x,
        y: npc.y,
        direction: npc.direction as Direction,
        animationFrame: npc.animationFrame as AnimationFrame,
        isMoving: npc.isMoving,
      });

      if (!this.tileProvider.getNPCSprite(npc.npcId) && !this.loadingNPCSprites.has(npc.npcId)) {
        missingNPCIds.push(npc.npcId);
      }
    }

    if (missingNPCIds.length > 0) {
      missingNPCIds.forEach(id => this.loadingNPCSprites.add(id));
      void this.batchLoadNPCSprites(missingNPCIds);
    }

    // Center camera on player
    this.renderer.setCamera(this.playerX, this.playerY);

    // Render
    let output = this.renderer.renderToString(this.tileProvider);

    if (this.componentManager?.hasVisibleComponents()) {
      output += this.componentManager.renderToString();
    }

    if (output) {
      this.stream.write(output);
    }
  }

  private refreshVisiblePlayersIfNeeded(): void {
    const POSITION_THRESHOLD = 2;
    const positionChanged =
      Math.abs(this.playerX - this.lastQueryX) > POSITION_THRESHOLD ||
      Math.abs(this.playerY - this.lastQueryY) > POSITION_THRESHOLD;

    if (!positionChanged && this.tickCounter % 45 !== 0) {
      return;
    }

    // Direct call to GameServer (no IPC!)
    this.cachedVisiblePlayers = this.gameServer.getVisiblePlayers(
      this.playerX,
      this.playerY,
      this.cols,
      this.rows,
      this.userId!
    );
    this.lastQueryX = this.playerX;
    this.lastQueryY = this.playerY;
  }

  private refreshVisibleNPCsIfNeeded(): void {
    if (this.tickCounter % 45 !== 0) {
      return;
    }

    // Direct call to GameServer (no IPC!)
    this.cachedVisibleNPCs = this.gameServer.getVisibleNPCs(
      this.playerX,
      this.playerY,
      this.cols,
      this.rows
    );
  }

  private async batchLoadNPCSprites(npcIds: string[]): Promise<void> {
    for (const npcId of npcIds) {
      try {
        const sprite = this.gameServer.getNPCSprite(npcId);
        if (sprite && this.tileProvider) {
          this.tileProvider.setNPCSprite(npcId, sprite);
        }
      } catch (err) {
        console.error(`[WorkerSession] Failed to load NPC sprite ${npcId}:`, err);
      } finally {
        this.loadingNPCSprites.delete(npcId);
      }
    }
  }

  private getPlayerColor(userId: string): { r: number; g: number; b: number } {
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
        this.moveScreenRelative('up');
        break;
      case 'move_down':
        this.moveScreenRelative('down');
        break;
      case 'move_left':
        this.moveScreenRelative('left');
        break;
      case 'move_right':
        this.moveScreenRelative('right');
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
      case 'place_building':
        this.openBuildingScreen();
        break;
      case 'place_road':
        void this.placeRoad();
        break;
      case 'remove_road':
        void this.removeRoad();
        break;
      case 'create_npc':
        this.openNPCScreen();
        break;
      case 'toggle_players':
        this.togglePlayerList();
        break;
      case 'toggle_camera_mode':
        this.renderer?.toggleCameraMode();
        this.renderer?.invalidate();
        break;
      case 'snap_to_player':
        this.renderer?.snapCameraToPlayer();
        this.renderer?.setCameraMode('follow');
        this.renderer?.invalidate();
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
      case 'rotate_camera_cw':
        this.renderer?.rotateCameraClockwise();
        this.renderer?.invalidate();
        break;
      case 'rotate_camera_ccw':
        this.renderer?.rotateCameraCounterClockwise();
        this.renderer?.invalidate();
        break;
      case 'show_help':
        if (this.helpModal && !this.helpModal.isVisible()) {
          this.componentManager?.pushFocus(this.helpModal);
        }
        break;
      case 'quit':
        this.quit();
        break;
    }
  }

  private togglePlayerList(): void {
    if (!this.playerListModal) return;

    if (this.playerListModal.isVisible()) {
      this.componentManager?.popFocus();
    } else {
      this.cachedAllPlayers = this.gameServer.getAllPlayers();
      this.playerListModal.setPlayers(this.cachedAllPlayers, this.userId);
      this.componentManager?.pushFocus(this.playerListModal);
    }
  }

  private panCamera(dx: number, dy: number): void {
    if (!this.renderer) return;
    if (this.renderer.getCameraMode() === 'follow') {
      this.renderer.setCameraMode('free');
    }
    this.renderer.panCameraByTiles(dx, dy);
    this.renderer.invalidate();
  }

  private getWorldDirection(screenDirection: Direction): Direction {
    if (!this.renderer) return screenDirection;
    return this.renderer.getWorldDirection(screenDirection);
  }

  private async quit(): Promise<void> {
    await this.destroy();
  }

  private async openAvatarScreen(): Promise<void> {
    this.inputPaused = true;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    this.renderer?.cleanup();

    try {
      const screen = new AvatarScreen({
        stream: this.stream,
        currentPrompt: this.currentPrompt,
        providerConfig: this.providerConfig,
        username: this.username,
      });

      const result = await screen.run();

      if (result.action === 'confirm' && result.result && result.prompt) {
        this.currentPrompt = result.prompt;

        try {
          await this.saveAvatar(result.prompt, result.result);
        } catch (err) {
          console.error('Failed to save avatar:', err);
        }

        if (this.tileProvider && this.userId) {
          this.tileProvider.setPlayerSprite(this.userId, result.result);
        }

        if (this.userId) {
          await this.gameServer.broadcastSpriteReload(this.userId);
        }
      }
    } catch (err) {
      console.error('Avatar screen error:', err);
    }

    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    this.inputPaused = false;
    this.renderer.invalidate();
    this.tickInterval = setInterval(() => this.tick(), 67);
  }

  private async saveAvatar(prompt: string, sprite: Sprite): Promise<void> {
    if (!this.userId) return;

    await saveSpriteToDisk(this.userId, sprite);

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

  private async openBuildingScreen(): Promise<void> {
    this.inputPaused = true;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    this.renderer?.cleanup();

    try {
      const screen = new BuildingScreen({
        stream: this.stream,
        providerConfig: this.providerConfig,
        username: this.username,
        playerX: this.playerX,
        playerY: this.playerY,
      });

      const result = await screen.run();

      if (result.action === 'confirm' && result.result && result.prompt) {
        try {
          await this.saveBuilding(result.prompt, result.result);
        } catch (err) {
          console.error('Failed to save building:', err);
        }
      }
    } catch (err) {
      console.error('Building screen error:', err);
    }

    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    this.inputPaused = false;
    this.renderer.invalidate();
    this.tickInterval = setInterval(() => this.tick(), 67);
  }

  private async saveBuilding(prompt: string, sprite: DirectionalBuildingSprite): Promise<void> {
    if (!this.userId) return;

    const anchorX = this.playerX;
    const anchorY = this.playerY - 1;

    const positions = getBuildingTilePositions(anchorX, anchorY);
    for (const [x, y] of positions) {
      if (this.tileProvider?.isBuildingAt(x, y)) {
        console.log(`[Building] Cannot place - tile (${x}, ${y}) already occupied`);
        return;
      }
    }

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

    await saveBuildingToDisk(building.id, sprite);

    this.tileProvider?.setBuilding(building.id, anchorX, anchorY, sprite.north, {
      north: sprite.north,
      east: sprite.east,
      south: sprite.south,
      west: sprite.west,
    });

    // Update collision cache directly
    this.gameServer.addBuildingToCollisionCache(anchorX, anchorY);

    console.log(`[Building] Placed building ${building.id} at (${anchorX}, ${anchorY})`);
  }

  private async placeRoad(): Promise<void> {
    if (!this.userId || !this.tileProvider) return;

    const x = this.playerX;
    const y = this.playerY;

    // Check if road already exists at this position
    if (this.tileProvider.hasRoadAt(x, y)) {
      return;
    }

    // Check if building exists at this position (can't place road on building)
    if (this.tileProvider.isBuildingAt(x, y)) {
      return;
    }

    try {
      // Insert into database
      await db.insert(schema.roads).values({
        x,
        y,
        placedBy: this.userId,
      });

      // Update local tile provider
      this.tileProvider.setRoad(x, y, this.userId);

      // Broadcast to all players via game server
      this.gameServer.broadcastRoadPlacement(x, y, this.userId);

      console.log(`[Road] Placed road at (${x}, ${y}) by ${this.username}`);
    } catch (error: unknown) {
      // Handle unique constraint violation (road already exists)
      const err = error as { code?: string };
      if (err.code === '23505') {
        // Road already exists, just update local state
        this.tileProvider.setRoad(x, y, this.userId);
      } else {
        console.error('[Road] Failed to place road:', error);
      }
    }
  }

  private async removeRoad(): Promise<void> {
    if (!this.userId || !this.tileProvider) return;

    const x = this.playerX;
    const y = this.playerY;

    // Check if road exists at this position
    if (!this.tileProvider.hasRoadAt(x, y)) {
      return;
    }

    try {
      // Delete from database
      await db.delete(schema.roads).where(
        and(eq(schema.roads.x, x), eq(schema.roads.y, y))
      );

      // Update local tile provider
      this.tileProvider.removeRoad(x, y);

      // Broadcast to all players via game server
      this.gameServer.broadcastRoadRemoval(x, y);

      console.log(`[Road] Removed road at (${x}, ${y}) by ${this.username}`);
    } catch (error) {
      console.error('[Road] Failed to remove road:', error);
    }
  }

  private async openNPCScreen(): Promise<void> {
    this.inputPaused = true;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    this.renderer?.cleanup();

    try {
      const screen = new NPCScreen({
        stream: this.stream,
        providerConfig: this.providerConfig,
        username: this.username,
        playerX: this.playerX,
        playerY: this.playerY,
      });

      const result = await screen.run();

      if (result.action === 'confirm' && result.result && result.prompt) {
        const npcData = {
          creatorId: this.userId!,
          name: result.result.name,
          prompt: result.prompt,
          spawnX: this.playerX,
          spawnY: this.playerY,
          roamRadius: 15,
          playerAffinity: 50,
          sprite: result.result.sprite,
        };

        const createdNpc = await this.gameServer.createNPC(npcData);

        if (createdNpc) {
          console.log(`[NPC] Created "${createdNpc.name}" at (${createdNpc.x}, ${createdNpc.y})`);

          this.tileProvider?.updateNPC(createdNpc);

          const sprite = this.gameServer.getNPCSprite(createdNpc.npcId);
          if (sprite) {
            this.tileProvider?.setNPCSprite(createdNpc.npcId, sprite);
          }
        }
      }
    } catch (err) {
      console.error('NPC screen error:', err);
    }

    this.renderer = new PixelGameRenderer({
      stream: this.stream,
      cols: this.cols,
      rows: this.rows,
      username: this.username,
    });
    this.renderer.initialize();

    this.inputPaused = false;
    this.renderer.invalidate();
    this.tickInterval = setInterval(() => this.tick(), 67);
  }

  private async loadNearbyBuildings(): Promise<void> {
    if (!this.tileProvider) return;

    const range = 50;
    const buildings = await db.query.buildings.findMany({
      where: and(
        between(schema.buildings.anchorX, this.playerX - range, this.playerX + range),
        between(schema.buildings.anchorY, this.playerY - range, this.playerY + range)
      ),
    });

    for (const building of buildings) {
      if (this.tileProvider.getBuildingAt(building.anchorX, building.anchorY)) {
        continue;
      }

      const dirSprite = await loadAllBuildingDirections(building.id);
      if (dirSprite) {
        this.tileProvider.setBuilding(building.id, building.anchorX, building.anchorY, dirSprite.north, {
          north: dirSprite.north,
          east: dirSprite.east,
          south: dirSprite.south,
          west: dirSprite.west,
        });
      }
    }
  }

  private async loadNearbyRoads(): Promise<void> {
    if (!this.tileProvider) return;

    const range = 100; // Load roads in a larger area since they're lightweight
    const roads = await db.query.roads.findMany({
      where: and(
        between(schema.roads.x, this.playerX - range, this.playerX + range),
        between(schema.roads.y, this.playerY - range, this.playerY + range)
      ),
    });

    for (const road of roads) {
      this.tileProvider.setRoad(road.x, road.y, road.placedBy);
    }

    console.log(`[WorkerSession] Loaded ${roads.length} nearby roads`);
  }

  private async batchLoadPlayerSprites(playerIds: string[]): Promise<void> {
    if (!this.tileProvider || playerIds.length === 0) return;

    const diskResults = await Promise.all(
      playerIds.map(async (playerId) => {
        try {
          const sprite = await loadSpriteFromDisk(playerId);
          return { playerId, sprite, success: !!sprite };
        } catch {
          return { playerId, sprite: null, success: false };
        }
      })
    );

    const needsDbLookup: string[] = [];
    for (const result of diskResults) {
      if (result.success && result.sprite) {
        this.tileProvider?.setPlayerSprite(result.playerId, result.sprite);
        this.loadingSprites.delete(result.playerId);
      } else {
        needsDbLookup.push(result.playerId);
      }
    }

    if (needsDbLookup.length > 0) {
      try {
        const avatars: Array<{ userId: string; spriteJson: Sprite | null }> = await db.select({
          userId: schema.avatars.userId,
          spriteJson: schema.avatars.spriteJson,
        })
          .from(schema.avatars)
          .where(inArray(schema.avatars.userId, needsDbLookup)) as Array<{ userId: string; spriteJson: Sprite | null }>;

        const avatarMap = new Map(avatars.map(a => [a.userId, a]));

        for (const playerId of needsDbLookup) {
          const avatar = avatarMap.get(playerId);
          if (avatar?.spriteJson) {
            this.tileProvider?.setPlayerSprite(playerId, avatar.spriteJson);
          }
          this.loadingSprites.delete(playerId);
        }
      } catch (error) {
        console.error('Failed to batch load avatars from DB:', error);
        for (const playerId of needsDbLookup) {
          this.loadingSprites.delete(playerId);
        }
      }
    }
  }

  private moveScreenRelative(screenDirection: Direction): void {
    const worldDirection = this.getWorldDirection(screenDirection);

    const deltas: Record<Direction, { dx: number; dy: number }> = {
      up: { dx: 0, dy: -1 },
      down: { dx: 0, dy: 1 },
      left: { dx: -1, dy: 0 },
      right: { dx: 1, dy: 0 },
    };

    const { dx, dy } = deltas[worldDirection];

    if (this.consecutiveMoveDirection === worldDirection) {
      this.consecutiveMoveCount++;
    } else {
      this.consecutiveMoveDirection = worldDirection;
      this.consecutiveMoveCount = 1;
    }

    this.moveOptimistic(dx, dy, worldDirection);
  }

  private moveOptimistic(dx: number, dy: number, direction: Direction): void {
    dx = Math.max(-1, Math.min(1, dx));
    dy = Math.max(-1, Math.min(1, dy));

    const targetX = this.playerX + dx;
    const targetY = this.playerY + dy;
    const targetTile = this.tileProvider?.getTile(targetX, targetY);

    if (targetTile && !targetTile.walkable) {
      return;
    }

    if (this.tileProvider?.isBuildingAt(targetX, targetY)) {
      return;
    }

    this.playerX = targetX;
    this.playerY = targetY;
    this.playerDirection = direction;
    this.isMoving = true;
    this.inputSequence++;

    this.updateLocalPlayerState();

    // Direct update to game server (no IPC!)
    this.gameServer.queueInput({
      userId: this.userId!,
      sessionId: this.sessionId,
      type: 'move',
      payload: { dx, dy },
      timestamp: Date.now(),
      sequence: this.inputSequence,
    });

    this.gameServer.updatePlayerPosition(this.userId!, this.playerX, this.playerY);

    this.updateMoveAnimation();
  }

  private updateMoveAnimation(): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
    }

    const isRunning = this.consecutiveMoveCount >= this.MOMENTUM_THRESHOLD;
    const animationDelay = isRunning ? 100 : 200;

    this.moveTimer = setTimeout(() => {
      this.isMoving = false;
      this.playerAnimationFrame = 0;
      this.consecutiveMoveCount = 0;
      this.consecutiveMoveDirection = null;
      this.updateLocalPlayerState();
    }, animationDelay);
  }

  private async showEntranceScreen(): Promise<void> {
    const ESC = '\x1b';
    const bgAnsi = bg(BG_PRIMARY);
    const crimsonFg = fg(CRIMSON_BRIGHT);
    const goldFg = fg(ACCENT_GOLD);
    const reset = `${ESC}[0m`;

    for (let row = 1; row <= this.rows; row++) {
      this.stream.write(`${ESC}[${row};1H${bgAnsi}${' '.repeat(this.cols)}`);
    }

    const centerY = Math.floor(this.rows / 2);

    const nameDisplay = this.username.toUpperCase();
    const nameX = Math.floor((this.cols - nameDisplay.length) / 2);
    this.stream.write(`${ESC}[${centerY - 2};${nameX}H${goldFg}${nameDisplay}${reset}`);
    await new Promise(resolve => setTimeout(resolve, 400));

    const vsText = 'VS';
    const vsX = Math.floor((this.cols - vsText.length) / 2);
    this.stream.write(`${ESC}[${centerY};${vsX}H${crimsonFg}${vsText}${reset}`);
    await new Promise(resolve => setTimeout(resolve, 300));

    const abyssText = 'THE ABYSS';
    const abyssX = Math.floor((this.cols - abyssText.length) / 2);
    this.stream.write(`${ESC}[${centerY + 2};${abyssX}H${goldFg}${abyssText}${reset}`);
    await new Promise(resolve => setTimeout(resolve, 500));

    const fightArt = [
      '███████╗██╗ ██████╗ ██╗  ██╗████████╗██╗',
      '██╔════╝██║██╔════╝ ██║  ██║╚══██╔══╝██║',
      '█████╗  ██║██║  ███╗███████║   ██║   ██║',
      '██╔══╝  ██║██║   ██║██╔══██║   ██║   ╚═╝',
      '██║     ██║╚██████╔╝██║  ██║   ██║   ██╗',
      '╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝',
    ];

    const fightWidth = fightArt[0]!.length;
    const fightX = Math.floor((this.cols - fightWidth) / 2);
    const fightY = centerY + 5;

    for (let i = 0; i < fightArt.length; i++) {
      this.stream.write(`${ESC}[${fightY + i};${fightX}H${crimsonFg}${fightArt[i]}${reset}`);
    }

    await new Promise(resolve => setTimeout(resolve, 800));

    const whiteFg = `${ESC}[38;2;255;255;255m`;
    for (let i = 0; i < fightArt.length; i++) {
      this.stream.write(`${ESC}[${fightY + i};${fightX}H${whiteFg}${fightArt[i]}${reset}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));

    for (let i = 0; i < fightArt.length; i++) {
      this.stream.write(`${ESC}[${fightY + i};${fightX}H${crimsonFg}${fightArt[i]}${reset}`);
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }

    if (this.componentManager) {
      this.componentManager.destroy();
      this.componentManager = null;
    }
    this.inputRouter = null;
    this.helpModal = null;
    this.playerListModal = null;
    this.reloadOverlay = null;

    if (this.renderer) {
      this.renderer.cleanup();
    }

    // Save state and disconnect from game server
    if (this.userId) {
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

    // Close the virtual stream
    this.stream.end();

    // Notify main process
    this.sendEnded(this.sessionId);
  }
}
