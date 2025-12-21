import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';

/**
 * NPCs table - AI-generated non-player characters that roam the world
 * Each NPC has a spawn point and roams within a configurable radius
 */
export const npcs = pgTable('npcs', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // NPC identity
  name: varchar('name', { length: 64 }).notNull(),
  prompt: text('prompt').notNull(),

  // Spawn position (center of roaming area)
  spawnX: integer('spawn_x').notNull(),
  spawnY: integer('spawn_y').notNull(),

  // AI behavior configuration
  roamRadius: integer('roam_radius').notNull().default(15), // Half of 30x30 area
  playerAffinity: integer('player_affinity').notNull().default(50), // 0=flees, 50=neutral, 100=follows

  // Metadata
  modelUsed: varchar('model_used', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  creatorIdx: index('idx_npcs_creator').on(table.creatorId),
  positionIdx: index('idx_npcs_position').on(table.spawnX, table.spawnY),
}));

/**
 * NPC relations
 */
export const npcsRelations = relations(npcs, ({ one }) => ({
  creator: one(users, {
    fields: [npcs.creatorId],
    references: [users.id],
  }),
}));
