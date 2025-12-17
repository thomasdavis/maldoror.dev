import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Player state - real-time position and status
 */
export const playerState = pgTable('player_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

  // Position (world coordinates)
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),

  // Visual state
  direction: varchar('direction', { length: 8 }).notNull().default('down'),
  animationFrame: integer('animation_frame').notNull().default(0),

  // Presence tracking
  isOnline: boolean('is_online').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastInputAt: timestamp('last_input_at', { withTimezone: true }).notNull().defaultNow(),

  // Session tracking
  sessionId: uuid('session_id'),
  connectedAt: timestamp('connected_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_player_state_user_id').on(table.userId),
  onlineIdx: index('idx_player_state_online').on(table.isOnline),
  positionIdx: index('idx_player_state_position').on(table.x, table.y),
}));

/**
 * Sessions - track connected clients
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Viewport tracking
  viewportX: integer('viewport_x').notNull().default(0),
  viewportY: integer('viewport_y').notNull().default(0),
  viewportWidth: integer('viewport_width').notNull().default(80),
  viewportHeight: integer('viewport_height').notNull().default(24),

  // Connection metadata
  connectionType: varchar('connection_type', { length: 32 }).notNull().default('ssh'),
  clientInfo: jsonb('client_info'),
  ipAddress: varchar('ip_address', { length: 45 }), // IPv6 max length

  // Heartbeat
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_sessions_user_id').on(table.userId),
  heartbeatIdx: index('idx_sessions_heartbeat').on(table.lastHeartbeatAt),
}));

/**
 * Game events - audit log for debugging and analytics
 */
export const gameEvents = pgTable('game_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  typeTimeIdx: index('idx_game_events_type').on(table.eventType, table.createdAt),
  userTimeIdx: index('idx_game_events_user').on(table.userId, table.createdAt),
}));

/**
 * Player state relations
 */
export const playerStateRelations = relations(playerState, ({ one }) => ({
  user: one(users, {
    fields: [playerState.userId],
    references: [users.id],
  }),
}));

/**
 * Sessions relations
 */
export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));
