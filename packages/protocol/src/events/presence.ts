import type { BaseEvent } from './game.js';
import type { PlayerPresence } from '../types/index.js';

/**
 * Player connected event
 */
export interface PlayerConnectedEvent extends BaseEvent {
  type: 'playerConnected';
  player: PlayerPresence;
}

/**
 * Player disconnected event
 */
export interface PlayerDisconnectedEvent extends BaseEvent {
  type: 'playerDisconnected';
  userId: string;
  username: string;
}

/**
 * Nearby players update (batch update of visible players)
 */
export interface NearbyPlayersEvent extends BaseEvent {
  type: 'nearbyPlayers';
  players: PlayerPresence[];
}

/**
 * Union of presence events
 */
export type PresenceEvent = PlayerConnectedEvent | PlayerDisconnectedEvent | NearbyPlayersEvent;

/**
 * All broadcast events
 */
export type BroadcastEvent =
  | PlayerConnectedEvent
  | PlayerDisconnectedEvent
  | NearbyPlayersEvent
  | import('./game.js').PlayerMovedEvent
  | import('./chat.js').ChatMessageEvent
  | import('./chat.js').SystemNotificationEvent;
