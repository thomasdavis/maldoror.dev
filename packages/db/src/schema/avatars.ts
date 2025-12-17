import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.js';
import type { SpriteGrid } from '@maldoror/protocol';

/**
 * Avatars table - AI-generated character sprites
 */
export const avatars = pgTable('avatars', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  spriteJson: jsonb('sprite_json').$type<SpriteGrid>(),
  generationStatus: varchar('generation_status', { length: 32 }).notNull().default('pending'),
  generationError: text('generation_error'),
  modelUsed: varchar('model_used', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_avatars_user_id').on(table.userId),
  statusIdx: index('idx_avatars_generation_status').on(table.generationStatus),
}));

/**
 * Avatar generation jobs - background processing queue
 */
export const avatarJobs = pgTable('avatar_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  statusIdx: index('idx_avatar_jobs_status').on(table.status, table.scheduledAt),
  avatarIdIdx: index('idx_avatar_jobs_avatar_id').on(table.avatarId),
}));

/**
 * Avatar relations
 */
export const avatarsRelations = relations(avatars, ({ one, many }) => ({
  user: one(users, {
    fields: [avatars.userId],
    references: [users.id],
  }),
  jobs: many(avatarJobs),
}));

export const avatarJobsRelations = relations(avatarJobs, ({ one }) => ({
  avatar: one(avatars, {
    fields: [avatarJobs.avatarId],
    references: [avatars.id],
  }),
}));
