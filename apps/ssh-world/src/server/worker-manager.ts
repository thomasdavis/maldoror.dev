/**
 * Worker Manager - Manages the game worker child process
 *
 * Handles hot reload by:
 * 1. Killing current worker
 * 2. Spawning fresh worker
 * 3. Re-registering all connected sessions
 *
 * State is NOT serialized - sessions have their own positions
 * and the database is the source of truth.
 */

import { fork, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { PlayerInput, NPCVisualState, Sprite } from '@maldoror/protocol';
import type { ProviderConfig } from '@maldoror/ai';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../worker/game-worker.js';
import type { NPCCreateData } from '../utils/npc-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type ReloadState = 'running' | 'reloading';
export type ReloadCallback = (state: ReloadState) => void;
export type SpriteReloadCallback = (userId: string) => void;
export type BuildingPlacementCallback = (buildingId: string, anchorX: number, anchorY: number) => void;
export type NPCCreatedCallback = (npc: NPCVisualState) => void;
export type SessionOutputCallback = (sessionId: string, output: string) => void;
export type SessionUserIdCallback = (sessionId: string, userId: string) => void;
export type SessionEndedCallback = (sessionId: string) => void;

export interface SessionRestoredState {
  playerX: number;
  playerY: number;
  zoomLevel: number;
  renderMode: string;
  cameraMode: string;
}

export interface WorkerSessionConfig {
  sessionId: string;
  fingerprint: string;
  username: string;
  userId: string | null;
  cols: number;
  rows: number;
  restoredState?: SessionRestoredState;
}

interface WorkerManagerConfig {
  worldSeed: bigint;
  tickRate: number;
  chunkCacheSize: number;
  providerConfig: ProviderConfig;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// Track connected sessions for re-registration after hot reload
interface ConnectedSession {
  userId: string;
  sessionId: string;
  username: string;
}

export class WorkerManager {
  private config: WorkerManagerConfig;
  private worker: ChildProcess | null = null;
  private workerReady: boolean = false;
  private reloadState: ReloadState = 'running';
  private reloadCallbacks: Set<ReloadCallback> = new Set();
  private spriteReloadCallbacks: Map<string, SpriteReloadCallback> = new Map();
  private buildingPlacementCallbacks: Map<string, BuildingPlacementCallback> = new Map();
  private npcCreatedCallbacks: Map<string, NPCCreatedCallback> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter: number = 0;
  // Track connected sessions so we can re-register after hot reload
  private connectedSessions: Map<string, ConnectedSession> = new Map();
  // Session callbacks for hot-reload architecture
  private sessionOutputCallbacks: Map<string, SessionOutputCallback> = new Map();
  private sessionUserIdCallbacks: Map<string, SessionUserIdCallback> = new Map();
  private sessionEndedCallbacks: Map<string, SessionEndedCallback> = new Map();
  // Track worker sessions for hot-reload re-registration
  private workerSessions: Map<string, WorkerSessionConfig> = new Map();

  constructor(config: WorkerManagerConfig) {
    this.config = config;
  }

  /**
   * Start the worker process
   */
  async start(): Promise<void> {
    await this.spawnWorker();
  }

  /**
   * Stop the worker process
   */
  stop(): void {
    if (this.worker) {
      this.sendToWorker({ type: 'shutdown' });
      this.worker = null;
      this.workerReady = false;
    }
    this.clearPendingRequests();
  }

  /**
   * Clear all pending requests and their timeouts
   * Called during shutdown to prevent memory leaks from dangling promises
   */
  clearPendingRequests(): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WorkerManager shutdown'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Hot reload - spawn fresh worker and re-register sessions
   * Preserves session state (player position, zoom, camera mode) across reloads.
   */
  async hotReload(): Promise<void> {
    console.log('[WorkerManager] Hot reload initiated...');
    console.log(`[WorkerManager] ${this.connectedSessions.size} legacy sessions, ${this.workerSessions.size} worker sessions to re-register`);

    // Notify all sessions that we're reloading
    this.reloadState = 'reloading';
    this.notifyReloadState();

    // Capture session states before killing worker
    let sessionStates: Map<string, SessionRestoredState> = new Map();
    if (this.workerReady && this.workerSessions.size > 0) {
      try {
        const states = await this.getAllSessionStates();
        for (const state of states) {
          sessionStates.set(state.sessionId, {
            playerX: state.playerX,
            playerY: state.playerY,
            zoomLevel: state.zoomLevel,
            renderMode: state.renderMode,
            cameraMode: state.cameraMode,
          });
        }
        console.log(`[WorkerManager] Captured ${sessionStates.size} session states`);
      } catch (error) {
        console.error('[WorkerManager] Failed to capture session states:', error);
        // Continue with hot reload anyway, sessions will start fresh
      }
    }

    try {
      // Kill current worker
      if (this.worker) {
        this.worker.kill('SIGTERM');
        this.worker = null;
        this.workerReady = false;
      }

      // Small delay to ensure process is fully terminated
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Spawn fresh worker
      await this.spawnWorker();

      // Re-register all connected sessions with the new worker (legacy system)
      for (const session of this.connectedSessions.values()) {
        this.sendToWorker({
          type: 'player_connect',
          userId: session.userId,
          sessionId: session.sessionId,
          username: session.username,
        });
      }

      // Re-register all worker sessions with restored state
      for (const config of this.workerSessions.values()) {
        const restoredState = sessionStates.get(config.sessionId);
        this.sendToWorker({
          type: 'create_session',
          sessionId: config.sessionId,
          fingerprint: config.fingerprint,
          username: config.username,
          userId: config.userId,
          cols: config.cols,
          rows: config.rows,
          restoredState: restoredState ? {
            sessionId: config.sessionId,
            playerX: restoredState.playerX,
            playerY: restoredState.playerY,
            zoomLevel: restoredState.zoomLevel,
            renderMode: restoredState.renderMode,
            cameraMode: restoredState.cameraMode,
          } : undefined,
        });
      }

      console.log('[WorkerManager] Hot reload complete');
    } catch (error) {
      console.error('[WorkerManager] Hot reload failed:', error);
      // Try to recover by spawning fresh worker
      await this.spawnWorker();
    }

    // Notify all sessions that reload is complete
    this.reloadState = 'running';
    this.notifyReloadState();
  }

  /**
   * Request all session states from worker (for hot-reload preservation)
   */
  private async getAllSessionStates(): Promise<Array<{
    sessionId: string;
    playerX: number;
    playerY: number;
    zoomLevel: number;
    renderMode: string;
    cameraMode: string;
  }>> {
    if (!this.isReady()) return [];

    const requestId = this.nextRequestId();
    return this.sendRequest(
      {
        type: 'get_all_session_states',
        requestId,
      },
      requestId,
      'all_session_states'
    );
  }

  /**
   * Subscribe to reload state changes
   */
  onReloadState(callback: ReloadCallback): () => void {
    this.reloadCallbacks.add(callback);
    return () => this.reloadCallbacks.delete(callback);
  }

  /**
   * Subscribe to sprite reload broadcasts
   */
  onSpriteReload(userId: string, callback: SpriteReloadCallback): void {
    this.spriteReloadCallbacks.set(userId, callback);
  }

  /**
   * Unsubscribe from sprite reload broadcasts
   */
  offSpriteReload(userId: string): void {
    this.spriteReloadCallbacks.delete(userId);
  }

  /**
   * Subscribe to building placement broadcasts
   */
  onBuildingPlacement(userId: string, callback: BuildingPlacementCallback): void {
    this.buildingPlacementCallbacks.set(userId, callback);
  }

  /**
   * Unsubscribe from building placement broadcasts
   */
  offBuildingPlacement(userId: string): void {
    this.buildingPlacementCallbacks.delete(userId);
  }

  /**
   * Subscribe to NPC created broadcasts
   */
  onNPCCreated(userId: string, callback: NPCCreatedCallback): void {
    this.npcCreatedCallbacks.set(userId, callback);
  }

  /**
   * Unsubscribe from NPC created broadcasts
   */
  offNPCCreated(userId: string): void {
    this.npcCreatedCallbacks.delete(userId);
  }

  /**
   * Check if worker is ready
   */
  isReady(): boolean {
    return this.workerReady && this.reloadState === 'running';
  }

  /**
   * Get current reload state
   */
  getReloadState(): ReloadState {
    return this.reloadState;
  }

  // === Game Server Interface ===
  // These methods match the GameServer interface for easy migration

  async playerConnect(userId: string, sessionId: string, username: string): Promise<void> {
    // Track session for hot reload re-registration
    this.connectedSessions.set(userId, { userId, sessionId, username });

    if (!this.isReady()) return;
    this.sendToWorker({
      type: 'player_connect',
      userId,
      sessionId,
      username,
    });
  }

  async playerDisconnect(userId: string): Promise<void> {
    // Remove from tracked sessions
    this.connectedSessions.delete(userId);

    if (!this.worker) return;
    this.sendToWorker({
      type: 'player_disconnect',
      userId,
    });
    this.spriteReloadCallbacks.delete(userId);
    this.buildingPlacementCallbacks.delete(userId);
    this.npcCreatedCallbacks.delete(userId);
  }

  queueInput(input: PlayerInput): void {
    if (!this.isReady()) return;
    this.sendToWorker({
      type: 'player_input',
      input,
    });
  }

  updatePlayerPosition(userId: string, x: number, y: number): void {
    if (!this.isReady()) return;
    this.sendToWorker({
      type: 'update_position',
      userId,
      x,
      y,
    });
  }

  async getVisiblePlayers(
    x: number,
    y: number,
    cols: number,
    rows: number,
    excludeId: string
  ): Promise<
    Array<{
      userId: string;
      username: string;
      x: number;
      y: number;
      direction: string;
      animationFrame: number;
    }>
  > {
    if (!this.isReady()) return [];

    const requestId = this.nextRequestId();
    return this.sendRequest<
      Array<{
        userId: string;
        username: string;
        x: number;
        y: number;
        direction: string;
        animationFrame: number;
      }>
    >(
      {
        type: 'get_visible_players',
        requestId,
        x,
        y,
        cols,
        rows,
        excludeId,
      },
      requestId,
      'visible_players'
    );
  }

  async getAllPlayers(): Promise<
    Array<{
      userId: string;
      username: string;
      x: number;
      y: number;
      isOnline: boolean;
    }>
  > {
    if (!this.isReady()) return [];

    const requestId = this.nextRequestId();
    return this.sendRequest<
      Array<{
        userId: string;
        username: string;
        x: number;
        y: number;
        isOnline: boolean;
      }>
    >(
      {
        type: 'get_all_players',
        requestId,
      },
      requestId,
      'all_players'
    );
  }

  async broadcastSpriteReload(userId: string): Promise<void> {
    // Broadcast locally to all sessions
    for (const [_sessionUserId, callback] of this.spriteReloadCallbacks) {
      callback(userId);
    }

    // Also tell worker (in case it needs to track anything)
    if (this.isReady()) {
      this.sendToWorker({
        type: 'broadcast_sprite_reload',
        userId,
      });
    }
  }

  async broadcastBuildingPlacement(buildingId: string, anchorX: number, anchorY: number): Promise<void> {
    // Broadcast locally to all sessions
    for (const [_userId, callback] of this.buildingPlacementCallbacks) {
      callback(buildingId, anchorX, anchorY);
    }

    // Update worker's building collision cache for NPC pathfinding
    if (this.isReady()) {
      this.sendToWorker({
        type: 'add_building_collision',
        anchorX,
        anchorY,
      });
    }
  }

  // === NPC Methods ===

  async getVisibleNPCs(
    x: number,
    y: number,
    cols: number,
    rows: number
  ): Promise<NPCVisualState[]> {
    if (!this.isReady()) return [];

    const requestId = this.nextRequestId();
    return this.sendRequest<NPCVisualState[]>(
      {
        type: 'get_visible_npcs',
        requestId,
        x,
        y,
        cols,
        rows,
      },
      requestId,
      'visible_npcs'
    );
  }

  async getNPCSprite(npcId: string): Promise<Sprite | null> {
    if (!this.isReady()) return null;

    const requestId = this.nextRequestId();
    const response = await this.sendRequest<{ npcId: string; sprite: Sprite | null }>(
      {
        type: 'get_npc_sprite',
        requestId,
        npcId,
      },
      requestId,
      'npc_sprite'
    );
    return response.sprite;
  }

  async createNPC(data: NPCCreateData): Promise<NPCVisualState | null> {
    if (!this.isReady()) return null;

    const requestId = this.nextRequestId();
    return this.sendRequest<NPCVisualState>(
      {
        type: 'create_npc',
        requestId,
        data,
      },
      requestId,
      'npc_created'
    );
  }

  // === Session Methods (Hot-Reload Architecture) ===

  /**
   * Create a new session in the worker
   */
  async createWorkerSession(config: WorkerSessionConfig): Promise<void> {
    // Track for hot-reload re-registration
    this.workerSessions.set(config.sessionId, config);

    if (!this.isReady()) return;

    this.sendToWorker({
      type: 'create_session',
      sessionId: config.sessionId,
      fingerprint: config.fingerprint,
      username: config.username,
      userId: config.userId,
      cols: config.cols,
      rows: config.rows,
    });
  }

  /**
   * Destroy a session in the worker
   */
  async destroyWorkerSession(sessionId: string): Promise<void> {
    // Remove from tracked sessions
    this.workerSessions.delete(sessionId);
    this.sessionOutputCallbacks.delete(sessionId);
    this.sessionUserIdCallbacks.delete(sessionId);
    this.sessionEndedCallbacks.delete(sessionId);

    if (!this.worker) return;

    this.sendToWorker({
      type: 'destroy_session',
      sessionId,
    });
  }

  /**
   * Forward input data to worker session
   */
  sendSessionInput(sessionId: string, data: Buffer): void {
    if (!this.isReady()) return;

    this.sendToWorker({
      type: 'session_input',
      sessionId,
      data: Array.from(data),
    });
  }

  /**
   * Forward resize event to worker session
   */
  sendSessionResize(sessionId: string, cols: number, rows: number): void {
    if (!this.isReady()) return;

    // Also update stored config
    const config = this.workerSessions.get(sessionId);
    if (config) {
      config.cols = cols;
      config.rows = rows;
    }

    this.sendToWorker({
      type: 'session_resize',
      sessionId,
      cols,
      rows,
    });
  }

  /**
   * Register callback for session output
   */
  onSessionOutput(sessionId: string, callback: SessionOutputCallback): void {
    this.sessionOutputCallbacks.set(sessionId, callback);
  }

  /**
   * Register callback for session userId updates (after onboarding)
   */
  onSessionUserId(sessionId: string, callback: SessionUserIdCallback): void {
    this.sessionUserIdCallbacks.set(sessionId, callback);
  }

  /**
   * Register callback for session ended events
   */
  onSessionEnded(sessionId: string, callback: SessionEndedCallback): void {
    this.sessionEndedCallbacks.set(sessionId, callback);
  }

  // === Private Methods ===

  private async spawnWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, '../worker/game-worker.js');

      console.log(`[WorkerManager] Spawning worker: ${workerPath}`);

      this.worker = fork(workerPath, [], {
        stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
      });

      const timeout = setTimeout(() => {
        reject(new Error('Worker startup timeout'));
      }, 10000);

      const onReady = (msg: WorkerToMainMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          this.workerReady = true;
          console.log('[WorkerManager] Worker is ready');
          resolve();
        }
      };

      this.worker.once('message', onReady);

      this.worker.on('message', (msg: WorkerToMainMessage) => {
        this.handleWorkerMessage(msg);
      });

      this.worker.on('error', (error) => {
        console.error('[WorkerManager] Worker error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      this.worker.on('exit', (code) => {
        console.log(`[WorkerManager] Worker exited with code ${code}`);
        this.workerReady = false;

        // If unexpected exit during normal operation, try to restart
        if (this.reloadState === 'running' && code !== 0) {
          console.log('[WorkerManager] Unexpected worker exit, restarting...');
          setTimeout(() => this.spawnWorker(), 1000);
        }
      });

      // Initialize worker
      this.sendToWorker({
        type: 'init',
        worldSeed: this.config.worldSeed.toString(),
        tickRate: this.config.tickRate,
        chunkCacheSize: this.config.chunkCacheSize,
        providerConfig: this.config.providerConfig,
      });
    });
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case 'visible_players':
      case 'all_players': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve(msg.players);
        }
        break;
      }

      case 'sprite_reload': {
        // Forward sprite reload to all sessions
        for (const [_userId, callback] of this.spriteReloadCallbacks) {
          callback(msg.userId);
        }
        break;
      }

      // NPC response handlers
      case 'visible_npcs': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve(msg.npcs);
        }
        break;
      }

      case 'npc_sprite': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve({ npcId: msg.npcId, sprite: msg.sprite });
        }
        break;
      }

      case 'npc_created': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve(msg.npc);
        }
        break;
      }

      case 'npc_created_broadcast': {
        // Forward NPC creation to all sessions
        for (const [_userId, callback] of this.npcCreatedCallbacks) {
          callback(msg.npc);
        }
        break;
      }

      case 'all_session_states': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve(msg.states);
        }
        break;
      }

      case 'session_output': {
        const callback = this.sessionOutputCallbacks.get(msg.sessionId);
        if (callback) {
          callback(msg.sessionId, msg.output);
        }
        break;
      }

      case 'session_user_id': {
        const callback = this.sessionUserIdCallbacks.get(msg.sessionId);
        if (callback) {
          callback(msg.sessionId, msg.userId);
        }
        // Update stored config with new userId
        const config = this.workerSessions.get(msg.sessionId);
        if (config) {
          config.userId = msg.userId;
        }
        break;
      }

      case 'session_ended': {
        const callback = this.sessionEndedCallbacks.get(msg.sessionId);
        if (callback) {
          callback(msg.sessionId);
        }
        break;
      }

      case 'error': {
        console.error('[WorkerManager] Worker reported error:', msg.message);
        break;
      }

      case 'ready': {
        // Already handled in spawnWorker
        break;
      }
    }
  }

  private sendToWorker(msg: MainToWorkerMessage): void {
    if (this.worker && this.worker.connected) {
      this.worker.send(msg);
    }
  }

  private sendRequest<T>(
    msg: MainToWorkerMessage,
    requestId: string,
    _responseType: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out`));
      }, 5000);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });

      this.sendToWorker(msg);
    });
  }

  private notifyReloadState(): void {
    for (const callback of this.reloadCallbacks) {
      callback(this.reloadState);
    }
  }

  private nextRequestId(): string {
    return `req_${++this.requestIdCounter}`;
  }
}
