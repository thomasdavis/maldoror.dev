import type { BaseEvent } from './game.js';

/**
 * Chat message received event
 */
export interface ChatMessageEvent extends BaseEvent {
  type: 'chatMessage';
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  channel: 'global' | 'local' | 'system';
}

/**
 * System notification event
 */
export interface SystemNotificationEvent extends BaseEvent {
  type: 'systemNotification';
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * Union of chat events
 */
export type ChatEvent = ChatMessageEvent | SystemNotificationEvent;
