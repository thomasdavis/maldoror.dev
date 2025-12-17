// Noise generation
export { SeededRandom, ValueNoise } from './noise/noise.js';

// Chunk system
export { ChunkGenerator, type GeneratedChunk } from './chunk/chunk-generator.js';
export { ChunkCache } from './chunk/chunk-cache.js';
export { CHUNK_SIZE } from './chunk/constants.js';

// Spatial indexing
export {
  SpatialIndex,
  worldToCell,
  cellKey,
} from './spatial/spatial-index.js';

// Game loop
export { GameLoop, type TickContext, type GameLoopConfig } from './tick/game-loop.js';

// Tile system
export {
  GRASS_TILE,
  DIRT_TILE,
  STONE_TILE,
  WATER_TILE,
  SAND_TILE,
  VOID_TILE,
  BASE_TILES,
  getTileById,
} from './tiles/base-tiles.js';

export {
  TileProvider,
  createPlaceholderSprite,
  type TileProviderConfig,
} from './tiles/tile-provider.js';

// Procedural tile generation
export {
  generateProceduralTile,
  generateTerrainPixel,
  generateAllResolutions,
  generateWaterAnimationFrames,
  type TerrainType,
  type NeighborInfo,
} from './tiles/procedural-tiles.js';
