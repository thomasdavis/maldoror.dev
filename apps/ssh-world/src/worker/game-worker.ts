/**
 * Game Worker - Child process that runs game logic
 *
 * This process can be killed and respawned during hot reload
 * while the main process maintains SSH connections.
 */

import { GameServer } from '../game/game-server.js';
import type { PlayerInput, NPCVisualState, Sprite } from '@maldoror/protocol';
import type { NPCCreateData } from '../utils/npc-storage.js';
import type { ProviderConfig } from '@maldoror/ai';
import { WorkerSession } from './worker-session.js';

// Message types for IPC
export interface WorkerInitMessage {
  type: 'init';
  worldSeed: string; // BigInt serialized as string
  tickRate: number;
  chunkCacheSize: number;
  providerConfig: ProviderConfig;
}

export interface PlayerConnectMessage {
  type: 'player_connect';
  userId: string;
  sessionId: string;
  username: string;
}

export interface PlayerDisconnectMessage {
  type: 'player_disconnect';
  userId: string;
}

export interface PlayerInputMessage {
  type: 'player_input';
  input: PlayerInput;
}

export interface UpdatePositionMessage {
  type: 'update_position';
  userId: string;
  x: number;
  y: number;
}

export interface GetVisiblePlayersMessage {
  type: 'get_visible_players';
  requestId: string;
  x: number;
  y: number;
  cols: number;
  rows: number;
  excludeId: string;
}

export interface GetAllPlayersMessage {
  type: 'get_all_players';
  requestId: string;
}

export interface BroadcastSpriteReloadMessage {
  type: 'broadcast_sprite_reload';
  userId: string;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

// NPC Messages
export interface GetVisibleNPCsMessage {
  type: 'get_visible_npcs';
  requestId: string;
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export interface GetNPCSpriteMessage {
  type: 'get_npc_sprite';
  requestId: string;
  npcId: string;
}

export interface CreateNPCMessage {
  type: 'create_npc';
  requestId: string;
  data: NPCCreateData;
}

export interface AddBuildingCollisionMessage {
  type: 'add_building_collision';
  anchorX: number;
  anchorY: number;
}

// Session state for hot-reload preservation
export interface SessionState {
  sessionId: string;
  playerX: number;
  playerY: number;
  zoomLevel: number;
  renderMode: string;
  cameraMode: string;
}

// Session messages for hot-reload architecture
export interface CreateSessionMessage {
  type: 'create_session';
  sessionId: string;
  fingerprint: string;
  username: string;
  userId: string | null;
  cols: number;
  rows: number;
  restoredState?: SessionState;
}

export interface GetAllSessionStatesMessage {
  type: 'get_all_session_states';
  requestId: string;
}

export interface DestroySessionMessage {
  type: 'destroy_session';
  sessionId: string;
}

export interface SessionInputMessage {
  type: 'session_input';
  sessionId: string;
  data: number[]; // Buffer as array
}

export interface SessionResizeMessage {
  type: 'session_resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export type MainToWorkerMessage =
  | WorkerInitMessage
  | PlayerConnectMessage
  | PlayerDisconnectMessage
  | PlayerInputMessage
  | UpdatePositionMessage
  | GetVisiblePlayersMessage
  | GetAllPlayersMessage
  | BroadcastSpriteReloadMessage
  | GetVisibleNPCsMessage
  | GetNPCSpriteMessage
  | CreateNPCMessage
  | AddBuildingCollisionMessage
  | CreateSessionMessage
  | DestroySessionMessage
  | SessionInputMessage
  | SessionResizeMessage
  | GetAllSessionStatesMessage
  | ShutdownMessage;

// Response types
export interface WorkerReadyMessage {
  type: 'ready';
}

export interface VisiblePlayersResponse {
  type: 'visible_players';
  requestId: string;
  players: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    direction: string;
    animationFrame: number;
  }>;
}

export interface AllPlayersResponse {
  type: 'all_players';
  requestId: string;
  players: Array<{
    userId: string;
    username: string;
    x: number;
    y: number;
    isOnline: boolean;
  }>;
}

export interface SpriteReloadBroadcast {
  type: 'sprite_reload';
  userId: string;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

// NPC Response types
export interface VisibleNPCsResponse {
  type: 'visible_npcs';
  requestId: string;
  npcs: NPCVisualState[];
}

export interface NPCSpriteResponse {
  type: 'npc_sprite';
  requestId: string;
  npcId: string;
  sprite: Sprite | null;
}

export interface CreateNPCResponse {
  type: 'npc_created';
  requestId: string;
  npc: NPCVisualState;
}

export interface NPCCreatedBroadcast {
  type: 'npc_created_broadcast';
  npc: NPCVisualState;
}

// Session output (worker → main)
export interface SessionOutputMessage {
  type: 'session_output';
  sessionId: string;
  output: string;
}

export interface SessionUserIdMessage {
  type: 'session_user_id';
  sessionId: string;
  userId: string;
}

export interface SessionEndedMessage {
  type: 'session_ended';
  sessionId: string;
}

export interface AllSessionStatesResponse {
  type: 'all_session_states';
  requestId: string;
  states: SessionState[];
}

export type WorkerToMainMessage =
  | WorkerReadyMessage
  | VisiblePlayersResponse
  | AllPlayersResponse
  | SpriteReloadBroadcast
  | VisibleNPCsResponse
  | NPCSpriteResponse
  | CreateNPCResponse
  | NPCCreatedBroadcast
  | SessionOutputMessage
  | SessionUserIdMessage
  | SessionEndedMessage
  | AllSessionStatesResponse
  | WorkerErrorMessage;

let gameServer: GameServer | null = null;
let worldSeed: bigint = 0n;
let providerConfig: ProviderConfig = { provider: 'openai', model: 'gpt-image-1' };
const workerSessions: Map<string, WorkerSession> = new Map();

function send(message: WorkerToMainMessage): void {
  if (process.send) {
    process.send(message);
  }
}

function sendSessionOutput(sessionId: string, output: string): void {
  send({ type: 'session_output', sessionId, output });
}

function sendSessionUserId(sessionId: string, userId: string): void {
  send({ type: 'session_user_id', sessionId, userId });
}

function sendSessionEnded(sessionId: string): void {
  send({ type: 'session_ended', sessionId });
}

process.on('message', async (msg: MainToWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init': {
        // Store config for session creation
        worldSeed = BigInt(msg.worldSeed);
        providerConfig = msg.providerConfig;

        gameServer = new GameServer({
          worldSeed,
          tickRate: msg.tickRate,
          chunkCacheSize: msg.chunkCacheSize,
        });

        // Set up sprite reload callback to forward to main process
        gameServer.setGlobalSpriteReloadCallback((userId: string) => {
          send({ type: 'sprite_reload', userId });
        });

        // Set up NPC created callback to forward to main process
        gameServer.setGlobalNPCCreatedCallback((npc: NPCVisualState) => {
          send({ type: 'npc_created_broadcast', npc });
        });

        // Load NPCs from database
        await gameServer.loadNPCs();

        gameServer.start();
        send({ type: 'ready' });
        console.log('[Worker] Game server initialized and ready');
        break;
      }

      case 'player_connect': {
        if (!gameServer) break;
        await gameServer.playerConnect(msg.userId, msg.sessionId, msg.username);
        break;
      }

      case 'player_disconnect': {
        if (!gameServer) break;
        await gameServer.playerDisconnect(msg.userId);
        break;
      }

      case 'player_input': {
        if (!gameServer) break;
        gameServer.queueInput(msg.input);
        break;
      }

      case 'update_position': {
        if (!gameServer) break;
        gameServer.updatePlayerPosition(msg.userId, msg.x, msg.y);
        break;
      }

      case 'get_visible_players': {
        if (!gameServer) {
          send({ type: 'visible_players', requestId: msg.requestId, players: [] });
          break;
        }
        const visible = gameServer.getVisiblePlayers(
          msg.x,
          msg.y,
          msg.cols,
          msg.rows,
          msg.excludeId
        );
        send({ type: 'visible_players', requestId: msg.requestId, players: visible });
        break;
      }

      case 'get_all_players': {
        if (!gameServer) {
          send({ type: 'all_players', requestId: msg.requestId, players: [] });
          break;
        }
        const all = gameServer.getAllPlayers();
        send({ type: 'all_players', requestId: msg.requestId, players: all });
        break;
      }

      case 'broadcast_sprite_reload': {
        if (!gameServer) break;
        await gameServer.broadcastSpriteReload(msg.userId);
        break;
      }

      // NPC message handlers
      case 'get_visible_npcs': {
        if (!gameServer) {
          send({ type: 'visible_npcs', requestId: msg.requestId, npcs: [] });
          break;
        }
        const visibleNpcs = gameServer.getVisibleNPCs(msg.x, msg.y, msg.cols, msg.rows);
        send({ type: 'visible_npcs', requestId: msg.requestId, npcs: visibleNpcs });
        break;
      }

      case 'get_npc_sprite': {
        if (!gameServer) {
          send({ type: 'npc_sprite', requestId: msg.requestId, npcId: msg.npcId, sprite: null });
          break;
        }
        const npcSprite = gameServer.getNPCSprite(msg.npcId);
        send({ type: 'npc_sprite', requestId: msg.requestId, npcId: msg.npcId, sprite: npcSprite });
        break;
      }

      case 'create_npc': {
        if (!gameServer) {
          send({ type: 'error', message: 'Game server not initialized' });
          break;
        }
        const createdNpc = await gameServer.createNPC(msg.data);
        send({ type: 'npc_created', requestId: msg.requestId, npc: createdNpc });
        break;
      }

      case 'add_building_collision': {
        if (!gameServer) break;
        gameServer.addBuildingToCollisionCache(msg.anchorX, msg.anchorY);
        break;
      }

      // === Session management for hot-reload architecture ===

      case 'create_session': {
        if (!gameServer) {
          send({ type: 'error', message: 'Game server not initialized' });
          break;
        }

        // Check if session already exists (re-registration after hot reload)
        let session = workerSessions.get(msg.sessionId);
        if (session) {
          console.log(`[Worker] Session ${msg.sessionId.slice(0, 8)}... already exists, skipping creation`);
          break;
        }

        // Create new session
        session = new WorkerSession({
          sessionId: msg.sessionId,
          fingerprint: msg.fingerprint,
          username: msg.username,
          userId: msg.userId,
          cols: msg.cols,
          rows: msg.rows,
          gameServer,
          worldSeed,
          providerConfig,
          sendOutput: sendSessionOutput,
          sendUserId: sendSessionUserId,
          sendEnded: sendSessionEnded,
          restoredState: msg.restoredState,
        });

        workerSessions.set(msg.sessionId, session);
        console.log(`[Worker] Created session ${msg.sessionId.slice(0, 8)}... (${workerSessions.size} total)`);

        // Start the session (async, don't block IPC)
        session.start().catch(err => {
          console.error(`[Worker] Session ${msg.sessionId.slice(0, 8)}... start error:`, err);
          workerSessions.delete(msg.sessionId);
        });
        break;
      }

      case 'destroy_session': {
        const session = workerSessions.get(msg.sessionId);
        if (session) {
          await session.destroy();
          workerSessions.delete(msg.sessionId);
          console.log(`[Worker] Destroyed session ${msg.sessionId.slice(0, 8)}... (${workerSessions.size} remaining)`);
        }
        break;
      }

      case 'session_input': {
        const session = workerSessions.get(msg.sessionId);
        if (session) {
          session.handleInput(Buffer.from(msg.data));
        }
        break;
      }

      case 'session_resize': {
        const session = workerSessions.get(msg.sessionId);
        if (session) {
          session.resize(msg.cols, msg.rows);
        }
        break;
      }

      case 'get_all_session_states': {
        const states: SessionState[] = [];
        for (const session of workerSessions.values()) {
          states.push(session.getState());
        }
        send({ type: 'all_session_states', requestId: msg.requestId, states });
        break;
      }

      case 'shutdown': {
        console.log('[Worker] Shutdown requested');

        // Destroy all sessions
        for (const session of workerSessions.values()) {
          await session.destroy();
        }
        workerSessions.clear();

        if (gameServer) {
          gameServer.stop();
        }
        process.exit(0);
        break;
      }
    }
  } catch (error) {
    console.error('[Worker] Error processing message:', error);
    send({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Worker] Uncaught exception:', error);
  send({ type: 'error', message: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled rejection:', reason);
  send({
    type: 'error',
    message: reason instanceof Error ? reason.message : 'Unhandled rejection',
  });
});

console.log('[Worker] Game worker process started');
