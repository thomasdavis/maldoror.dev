import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * World configuration - singleton table
 */
export const world = pgTable('world', {
  id: integer('id').primaryKey().default(1),
  seed: bigint('seed', { mode: 'bigint' }).notNull(),
  name: varchar('name', { length: 128 }).notNull().default('Maldoror'),
  tickRateHz: integer('tick_rate_hz').notNull().default(15),
  chunkSizeTiles: integer('chunk_size_tiles').notNull().default(16), // Tiles per chunk
  tileSizePixels: integer('tile_size_pixels').notNull().default(16), // Pixels per tile
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tilemap chunks - stored tile grids for the world
 * Each chunk is 16x16 tiles, stored as array of tile IDs
 */
export const tilemapChunks = pgTable('tilemap_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  chunkX: integer('chunk_x').notNull(),
  chunkY: integer('chunk_y').notNull(),
  // 2D array of tile IDs [y][x], 16x16
  tiles: jsonb('tiles').$type<string[][]>().notNull(),
  // Generation metadata
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  modifiedAt: timestamp('modified_at', { withTimezone: true }),
  modifiedBy: uuid('modified_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  chunkIdx: uniqueIndex('idx_tilemap_chunks_coords').on(table.chunkX, table.chunkY),
}));

/**
 * Tile definitions - reusable pixel art tiles
 */
export const tileDefinitions = pgTable('tile_definitions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  // 16x16 pixel grid as RGB values
  pixels: jsonb('pixels').$type<Array<Array<{ r: number; g: number; b: number } | null>>>().notNull(),
  walkable: integer('walkable').notNull().default(1), // 1 = true, 0 = false
  animated: integer('animated').notNull().default(0),
  // Animation frames if animated
  animationFrames: jsonb('animation_frames').$type<Array<Array<Array<{ r: number; g: number; b: number } | null>>>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Chunk deltas - individual tile modifications (overrides)
 */
export const chunkDeltas = pgTable('chunk_deltas', {
  id: uuid('id').primaryKey().defaultRandom(),
  chunkX: integer('chunk_x').notNull(),
  chunkY: integer('chunk_y').notNull(),
  tileX: integer('tile_x').notNull(), // Position within chunk (0-15)
  tileY: integer('tile_y').notNull(),
  tileId: varchar('tile_id', { length: 64 }).notNull().references(() => tileDefinitions.id),
  placedBy: uuid('placed_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  chunkIdx: index('idx_chunk_deltas_chunk').on(table.chunkX, table.chunkY),
  uniqueTile: uniqueIndex('idx_chunk_deltas_unique').on(
    table.chunkX,
    table.chunkY,
    table.tileX,
    table.tileY
  ),
}));
