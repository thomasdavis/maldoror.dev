import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';

/**
 * Sprite frames table - Individual PNG files for sprite resolutions
 * Each row represents one PNG file: direction + frame + resolution
 */
export const spriteFrames = pgTable('sprite_frames', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Frame identification
  direction: varchar('direction', { length: 8 }).notNull(), // 'up', 'down', 'left', 'right'
  frameNum: integer('frame_num').notNull(), // 0-3 (animation frames)
  resolution: integer('resolution').notNull(), // 26, 51, 77, ... 256

  // File info
  filePath: text('file_path').notNull(), // relative path to PNG
  width: integer('width').notNull(),
  height: integer('height').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('idx_sprite_frames_user').on(table.userId),
  uniqueFrame: unique('uq_sprite_frames').on(table.userId, table.direction, table.frameNum, table.resolution),
}));

/**
 * Sprite frames relations
 */
export const spriteFramesRelations = relations(spriteFrames, ({ one }) => ({
  user: one(users, {
    fields: [spriteFrames.userId],
    references: [users.id],
  }),
}));
