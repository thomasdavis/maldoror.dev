import {
  pgTable,
  uuid,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';

/**
 * Roads table - Player-placed road tiles on the map
 * Roads are single tiles that connect intelligently with neighbors
 */
export const roads = pgTable('roads', {
  id: uuid('id').primaryKey().defaultRandom(),
  placedBy: uuid('placed_by').references(() => users.id, { onDelete: 'set null' }),

  // Road tile position
  x: integer('x').notNull(),
  y: integer('y').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Unique constraint on position - only one road per tile
  positionIdx: uniqueIndex('idx_roads_position').on(table.x, table.y),
  placedByIdx: index('idx_roads_placed_by').on(table.placedBy),
}));

/**
 * Road relations
 */
export const roadsRelations = relations(roads, ({ one }) => ({
  placer: one(users, {
    fields: [roads.placedBy],
    references: [users.id],
  }),
}));
