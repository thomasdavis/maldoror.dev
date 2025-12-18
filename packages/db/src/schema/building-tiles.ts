import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { buildings } from './buildings';

/**
 * Building tiles table - Individual PNG files for building tile resolutions
 * Each row represents one PNG file: tile position + resolution
 */
export const buildingTiles = pgTable('building_tiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),

  // Tile position in 3x3 grid
  tileX: integer('tile_x').notNull(), // 0-2
  tileY: integer('tile_y').notNull(), // 0-2
  resolution: integer('resolution').notNull(), // 26, 51, 77, ... 256

  // File info
  filePath: text('file_path').notNull(), // relative path to PNG

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  buildingIdx: index('idx_building_tiles_building').on(table.buildingId),
  uniqueTile: unique('uq_building_tiles').on(table.buildingId, table.tileX, table.tileY, table.resolution),
}));

/**
 * Building tiles relations
 */
export const buildingTilesRelations = relations(buildingTiles, ({ one }) => ({
  building: one(buildings, {
    fields: [buildingTiles.buildingId],
    references: [buildings.id],
  }),
}));
