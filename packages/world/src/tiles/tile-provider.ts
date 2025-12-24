import type { Tile, Sprite, PlayerVisualState, PixelGrid, RGB, WorldDataProvider, Pixel, DirectionFrames, BuildingSprite, BuildingTile, BuildingDirection, NPCVisualState } from '@maldoror/protocol';
import { CHUNK_SIZE_TILES, BASE_SIZE, RESOLUTIONS, isPositionInBuilding, getBuildingTileIndex } from '@maldoror/protocol';
import { BASE_TILES, getTileById, hasAITile } from './base-tiles.js';
import { getRoadTileVariant } from './road-tiles.js';
import { SeededRandom, ValueNoise } from '../noise/noise.js';

/**
 * Terrain transition pairs that we have generated tiles for
 * Format: [from, to] - tiles exist for "from_to_to_*" patterns
 */
const TERRAIN_TRANSITIONS: [string, string][] = [
  ['grass', 'water'],
  ['grass', 'sand'],
  ['grass', 'dirt'],
  ['grass', 'stone'],
  ['sand', 'water'],
  ['dirt', 'sand'],
  ['dirt', 'stone'],
];

/**
 * Build transition tile ID based on neighbor configuration
 * Returns null if no transition needed or no tile exists for this combination
 */
function getTransitionTileId(
  baseTerrain: string,
  northTerrain: string | null,
  eastTerrain: string | null,
  southTerrain: string | null,
  westTerrain: string | null
): string | null {
  // Find all different neighbors
  const differentNeighbors = new Set<string>();
  if (northTerrain && northTerrain !== baseTerrain) differentNeighbors.add(northTerrain);
  if (eastTerrain && eastTerrain !== baseTerrain) differentNeighbors.add(eastTerrain);
  if (southTerrain && southTerrain !== baseTerrain) differentNeighbors.add(southTerrain);
  if (westTerrain && westTerrain !== baseTerrain) differentNeighbors.add(westTerrain);

  if (differentNeighbors.size === 0) return null;

  // For simplicity, pick the first different neighbor type we find
  // (In complex cases with multiple different neighbors, use the most common one)
  const targetTerrain = Array.from(differentNeighbors)[0]!;

  // Check if we have this transition pair
  const hasTransition = TERRAIN_TRANSITIONS.some(
    ([from, to]) => (from === baseTerrain && to === targetTerrain)
  );

  if (!hasTransition) {
    // Try reverse - maybe we have the opposite direction
    const hasReverseTransition = TERRAIN_TRANSITIONS.some(
      ([from, to]) => (from === targetTerrain && to === baseTerrain)
    );
    if (!hasReverseTransition) return null;

    // Use reverse transition (swap perspective)
    // If we're sand and neighbor is grass, use grass_to_sand from grass's perspective
    // But we need sand_to_grass which doesn't exist, so skip
    return null;
  }

  // Build the variant name based on which edges have the target terrain
  // Bit pattern: N=0b0001, E=0b0010, S=0b0100, W=0b1000
  const hasN = northTerrain === targetTerrain;
  const hasE = eastTerrain === targetTerrain;
  const hasS = southTerrain === targetTerrain;
  const hasW = westTerrain === targetTerrain;

  // Build variant string in order: n, e, s, w (matching AUTOTILE_CONFIGS naming)
  let orderedVariant = '';
  if (hasN) orderedVariant += 'n';
  if (hasE) orderedVariant += 'e';
  if (hasS) orderedVariant += 's';
  if (hasW) orderedVariant += 'w';

  // Special case: if all 4 neighbors are the target, use "all"
  if (hasN && hasE && hasS && hasW) orderedVariant = 'all';

  // Build tile ID
  const tileId = `${baseTerrain}_to_${targetTerrain}_${orderedVariant}`;

  // Verify this tile exists
  if (hasAITile(tileId)) {
    return tileId;
  }

  return null;
}

/**
 * Rotate a pixel grid by 90 degrees clockwise
 */
function rotateGrid90(grid: PixelGrid): PixelGrid {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const result: PixelGrid = [];

  for (let x = 0; x < width; x++) {
    const row: Pixel[] = [];
    for (let y = height - 1; y >= 0; y--) {
      row.push(grid[y]?.[x] ?? null);
    }
    result.push(row);
  }
  return result;
}

/**
 * Rotate a pixel grid by specified amount (0, 1, 2, or 3 times 90 degrees)
 */
function rotateGrid(grid: PixelGrid, rotations: number): PixelGrid {
  let result = grid;
  for (let i = 0; i < (rotations % 4); i++) {
    result = rotateGrid90(result);
  }
  return result;
}

/**
 * Simple hash for deterministic rotation based on position
 */
function positionHash(x: number, y: number): number {
  // Mix x and y to get varied rotations
  let hash = x * 374761393 + y * 668265263;
  hash = (hash ^ (hash >> 13)) * 1274126177;
  return hash;
}

/**
 * Configuration for the tile provider
 */
export interface TileProviderConfig {
  worldSeed: bigint;
  chunkCacheSize?: number;
}

/**
 * Cached chunk data
 */
interface ChunkData {
  tiles: string[][];  // Tile IDs
  accessedAt: number;
}

/**
 * Cached procedural tile data
 */
interface ProceduralTileCache {
  tile: Tile;
  accessedAt: number;
}

/**
 * Directional sprites for a building (all 4 rotations for camera support)
 */
export interface DirectionalBuildingSprites {
  north: BuildingSprite;
  east: BuildingSprite;
  south: BuildingSprite;
  west: BuildingSprite;
}

/**
 * Cached building data
 * Supports both single-direction (legacy) and directional sprites
 */
export interface BuildingData {
  id: string;
  sprite: BuildingSprite;  // Primary sprite (north) or legacy single sprite
  directionalSprites?: DirectionalBuildingSprites;  // All 4 directions if available
  anchorX: number;
  anchorY: number;
}

/**
 * TileProvider - Provides tile and player data to the renderer
 *
 * Handles:
 * - Tile lookups by world coordinates
 * - Procedural tile generation with neighbor blending
 * - Chunk generation and caching
 * - Player sprite management
 */
export class TileProvider implements WorldDataProvider {
  private worldSeed: bigint;
  private noise: ValueNoise;
  private chunkCache: Map<string, ChunkData> = new Map();
  private tileCache: Map<string, ProceduralTileCache> = new Map();
  private maxChunks: number;
  private maxTiles: number;
  private players: Map<string, PlayerVisualState> = new Map();
  private sprites: Map<string, Sprite> = new Map();
  private buildings: Map<string, BuildingData> = new Map(); // Building ID -> BuildingData
  private npcs: Map<string, NPCVisualState> = new Map(); // NPC ID -> NPCVisualState
  private npcSprites: Map<string, Sprite> = new Map(); // NPC ID -> Sprite
  private localPlayerId: string = '';
  private useEdgeBlending: boolean = false; // Disabled - just use base tiles
  private buildingsByChunk: Map<string, Set<string>> = new Map(); // Spatial hash for O(1) building lookups
  private roads: Map<string, { x: number; y: number; placedBy: string | null }> = new Map(); // "x,y" -> road data
  private roadsByChunk: Map<string, Set<string>> = new Map(); // Spatial hash for O(1) road lookups

  constructor(config: TileProviderConfig) {
    this.worldSeed = config.worldSeed;
    this.noise = new ValueNoise(config.worldSeed);
    this.maxChunks = config.chunkCacheSize ?? 64;
    this.maxTiles = config.chunkCacheSize ? config.chunkCacheSize * 16 : 1024; // Cache up to 1024 procedural tiles (was 256)
  }

  /**
   * Get chunk key for spatial hashing
   */
  private getChunkKey(x: number, y: number): string {
    const chunkX = Math.floor(x / CHUNK_SIZE_TILES);
    const chunkY = Math.floor(y / CHUNK_SIZE_TILES);
    return `${chunkX},${chunkY}`;
  }

  /**
   * Get all chunk keys a building spans (buildings are 4x4 tiles)
   */
  private getBuildingChunkKeys(anchorX: number, anchorY: number): string[] {
    const keys = new Set<string>();
    // Buildings span 4x4 tiles from anchor
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        keys.add(this.getChunkKey(anchorX + dx, anchorY + dy));
      }
    }
    return Array.from(keys);
  }

  /**
   * Enable or disable edge blending
   */
  setEdgeBlending(enabled: boolean): void {
    this.useEdgeBlending = enabled;
    if (!enabled) {
      this.tileCache.clear();
    }
  }

  /**
   * Set the local player ID (for username rendering)
   */
  setLocalPlayerId(userId: string): void {
    this.localPlayerId = userId;
  }

  /**
   * Get the local player ID
   */
  getLocalPlayerId(): string {
    return this.localPlayerId;
  }


  /**
   * Get tile ID at world coordinates (for neighbor lookups)
   */
  private getTileId(tileX: number, tileY: number): string | null {
    const chunkX = Math.floor(tileX / CHUNK_SIZE_TILES);
    const chunkY = Math.floor(tileY / CHUNK_SIZE_TILES);

    const chunk = this.getChunk(chunkX, chunkY);
    if (!chunk) return null;

    const localX = ((tileX % CHUNK_SIZE_TILES) + CHUNK_SIZE_TILES) % CHUNK_SIZE_TILES;
    const localY = ((tileY % CHUNK_SIZE_TILES) + CHUNK_SIZE_TILES) % CHUNK_SIZE_TILES;

    return chunk.tiles[localY]?.[localX] ?? null;
  }

  /**
   * Get tile at world coordinates (terrain only, use getBuildingTileAt for buildings)
   */
  getTile(tileX: number, tileY: number): Tile | null {
    const tileId = this.getTileId(tileX, tileY);
    if (!tileId) return null;

    // Check neighbors for AI autotile transitions
    const northId = this.getTileId(tileX, tileY - 1);
    const eastId = this.getTileId(tileX + 1, tileY);
    const southId = this.getTileId(tileX, tileY + 1);
    const westId = this.getTileId(tileX - 1, tileY);

    // Try to get an AI transition tile
    const transitionTileId = getTransitionTileId(tileId, northId, eastId, southId, westId);
    if (transitionTileId) {
      const transitionTile = getTileById(transitionTileId);
      if (transitionTile) {
        return transitionTile;
      }
    }

    const baseTile = getTileById(tileId);
    if (!baseTile) return BASE_TILES.void ?? null;

    // Check if we need edge blending (has different neighbor) - fallback if no AI tiles
    if (this.useEdgeBlending && !baseTile.animated) {
      const needsBlend = this.hasDifferentNeighbor(tileX, tileY, tileId);
      if (needsBlend) {
        return this.getBlendedTile(tileX, tileY, tileId, baseTile);
      }
    }

    // Determine rotation based on world position for variety
    const rotation = Math.abs(positionHash(tileX, tileY)) % 4;

    if (rotation === 0 || baseTile.animated) {
      return baseTile;
    }

    return {
      ...baseTile,
      pixels: rotateGrid(baseTile.pixels, rotation),
    };
  }

  /**
   * Check if tile has any different neighbor (for edge detection)
   */
  private hasDifferentNeighbor(tileX: number, tileY: number, tileId: string): boolean {
    const neighbors = [
      this.getTileId(tileX, tileY - 1),     // north
      this.getTileId(tileX, tileY + 1),     // south
      this.getTileId(tileX + 1, tileY),     // east
      this.getTileId(tileX - 1, tileY),     // west
    ];
    return neighbors.some(n => n && n !== tileId);
  }

  /**
   * Get a blended tile with simple edge gradients
   */
  private getBlendedTile(tileX: number, tileY: number, tileId: string, baseTile: Tile): Tile {
    const cacheKey = `blend:${tileX},${tileY}`;

    // Check cache
    const cached = this.tileCache.get(cacheKey);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.tile;
    }

    // Get neighbor colors for blending
    const northId = this.getTileId(tileX, tileY - 1);
    const southId = this.getTileId(tileX, tileY + 1);
    const eastId = this.getTileId(tileX + 1, tileY);
    const westId = this.getTileId(tileX - 1, tileY);

    const northTile = northId && northId !== tileId ? (getTileById(northId) ?? null) : null;
    const southTile = southId && southId !== tileId ? (getTileById(southId) ?? null) : null;
    const eastTile = eastId && eastId !== tileId ? (getTileById(eastId) ?? null) : null;
    const westTile = westId && westId !== tileId ? (getTileById(westId) ?? null) : null;

    // Blend edges - super simple: just fade edge pixels toward neighbor color
    const blendDepth = Math.floor(BASE_SIZE * 0.15); // 15% edge blend
    const pixels = blendEdges(baseTile.pixels, blendDepth, northTile, southTile, eastTile, westTile);

    // Generate resolutions for blended tile
    const resolutions: Record<string, PixelGrid> = {};
    for (const size of RESOLUTIONS) {
      resolutions[String(size)] = resizeNearest(pixels, size);
    }

    const tile: Tile = {
      ...baseTile,
      pixels,
      resolutions,
    };

    // Cache
    this.tileCache.set(cacheKey, { tile, accessedAt: Date.now() });
    this.evictOldTiles();

    return tile;
  }

  /**
   * Evict old tiles from cache
   */
  private evictOldTiles(): void {
    if (this.tileCache.size <= this.maxTiles) return;

    const entries = Array.from(this.tileCache.entries())
      .sort((a, b) => a[1].accessedAt - b[1].accessedAt);

    const toRemove = entries.slice(0, entries.length - this.maxTiles);
    for (const [key] of toRemove) {
      this.tileCache.delete(key);
    }
  }

  /**
   * Update player visual state
   */
  updatePlayer(state: PlayerVisualState): void {
    this.players.set(state.userId, state);
  }

  /**
   * Remove player and their cached sprite
   */
  removePlayer(userId: string): void {
    this.players.delete(userId);
    this.sprites.delete(userId);  // Also remove cached sprite to free memory
  }

  /**
   * Get all players
   */
  getPlayers(): PlayerVisualState[] {
    return Array.from(this.players.values());
  }

  /**
   * Set player sprite
   */
  setPlayerSprite(userId: string, sprite: Sprite): void {
    this.sprites.set(userId, sprite);
  }

  /**
   * Get player sprite
   */
  getPlayerSprite(userId: string): Sprite | null {
    return this.sprites.get(userId) ?? null;
  }

  // ==================== NPC Management ====================

  /**
   * Update NPC visual state
   */
  updateNPC(state: NPCVisualState): void {
    this.npcs.set(state.npcId, state);
  }

  /**
   * Remove NPC
   */
  removeNPC(npcId: string): void {
    this.npcs.delete(npcId);
    this.npcSprites.delete(npcId);
  }

  /**
   * Get all NPCs
   */
  getNPCs(): NPCVisualState[] {
    return Array.from(this.npcs.values());
  }

  /**
   * Set NPC sprite
   */
  setNPCSprite(npcId: string, sprite: Sprite): void {
    this.npcSprites.set(npcId, sprite);
  }

  /**
   * Get NPC sprite
   */
  getNPCSprite(npcId: string): Sprite | null {
    return this.npcSprites.get(npcId) ?? null;
  }

  /**
   * Clear all NPCs
   */
  clearNPCs(): void {
    this.npcs.clear();
    this.npcSprites.clear();
  }

  // ==================== Road Management ====================

  /**
   * Get road key for position
   */
  private getRoadKey(x: number, y: number): string {
    return `${x},${y}`;
  }

  /**
   * Set a road at position
   */
  setRoad(x: number, y: number, placedBy: string | null): void {
    const key = this.getRoadKey(x, y);
    this.roads.set(key, { x, y, placedBy });

    // Register in spatial hash
    const chunkKey = this.getChunkKey(x, y);
    let set = this.roadsByChunk.get(chunkKey);
    if (!set) {
      set = new Set();
      this.roadsByChunk.set(chunkKey, set);
    }
    set.add(key);
  }

  /**
   * Remove a road at position
   */
  removeRoad(x: number, y: number): void {
    const key = this.getRoadKey(x, y);
    this.roads.delete(key);

    // Remove from spatial hash
    const chunkKey = this.getChunkKey(x, y);
    const set = this.roadsByChunk.get(chunkKey);
    if (set) {
      set.delete(key);
      if (set.size === 0) {
        this.roadsByChunk.delete(chunkKey);
      }
    }
  }

  /**
   * Check if there's a road at position
   */
  hasRoadAt(x: number, y: number): boolean {
    return this.roads.has(this.getRoadKey(x, y));
  }

  /**
   * Get the appropriate road tile at a position based on neighbor connections
   * Returns null if no road at position
   */
  getRoadTileAt(x: number, y: number): Tile | null {
    if (!this.hasRoadAt(x, y)) {
      return null;
    }

    // Check neighbors
    const hasNorth = this.hasRoadAt(x, y - 1);
    const hasSouth = this.hasRoadAt(x, y + 1);
    const hasEast = this.hasRoadAt(x + 1, y);
    const hasWest = this.hasRoadAt(x - 1, y);

    return getRoadTileVariant(hasNorth, hasSouth, hasEast, hasWest);
  }

  /**
   * Get all roads
   */
  getRoads(): Array<{ x: number; y: number; placedBy: string | null }> {
    return Array.from(this.roads.values());
  }

  /**
   * Clear all roads
   */
  clearRoads(): void {
    this.roads.clear();
    this.roadsByChunk.clear();
  }

  // ==================== Building Management ====================

  /**
   * Add a building to the tile provider
   * @param directionalSprites - Optional full directional sprites for camera rotation support
   */
  setBuilding(
    buildingId: string,
    anchorX: number,
    anchorY: number,
    sprite: BuildingSprite,
    directionalSprites?: DirectionalBuildingSprites
  ): void {
    // Remove from old spatial hash location if exists
    const existing = this.buildings.get(buildingId);
    if (existing) {
      this.unregisterBuildingFromSpatialHash(buildingId, existing.anchorX, existing.anchorY);
    }

    this.buildings.set(buildingId, {
      id: buildingId,
      sprite,
      directionalSprites,
      anchorX,
      anchorY,
    });

    // Register in spatial hash
    this.registerBuildingInSpatialHash(buildingId, anchorX, anchorY);
  }

  /**
   * Remove a building by ID
   */
  removeBuilding(buildingId: string): void {
    const building = this.buildings.get(buildingId);
    if (building) {
      this.unregisterBuildingFromSpatialHash(buildingId, building.anchorX, building.anchorY);
    }
    this.buildings.delete(buildingId);
  }

  private registerBuildingInSpatialHash(buildingId: string, anchorX: number, anchorY: number): void {
    for (const key of this.getBuildingChunkKeys(anchorX, anchorY)) {
      let set = this.buildingsByChunk.get(key);
      if (!set) {
        set = new Set();
        this.buildingsByChunk.set(key, set);
      }
      set.add(buildingId);
    }
  }

  private unregisterBuildingFromSpatialHash(buildingId: string, anchorX: number, anchorY: number): void {
    for (const key of this.getBuildingChunkKeys(anchorX, anchorY)) {
      const set = this.buildingsByChunk.get(key);
      if (set) {
        set.delete(buildingId);
        if (set.size === 0) {
          this.buildingsByChunk.delete(key);
        }
      }
    }
  }

  /**
   * Get all buildings
   */
  getBuildings(): BuildingData[] {
    return Array.from(this.buildings.values());
  }

  /**
   * Get buildings that might be at a position (from spatial hash)
   */
  private getBuildingsNearPosition(worldX: number, worldY: number): BuildingData[] {
    const chunkKey = this.getChunkKey(worldX, worldY);
    const buildingIds = this.buildingsByChunk.get(chunkKey);
    if (!buildingIds) return [];

    const result: BuildingData[] = [];
    for (const id of buildingIds) {
      const building = this.buildings.get(id);
      if (building) result.push(building);
    }
    return result;
  }

  /**
   * Check if a world position is blocked by a building
   * Uses spatial hash for O(1) average lookup instead of O(N)
   */
  isBuildingAt(worldX: number, worldY: number): boolean {
    for (const building of this.getBuildingsNearPosition(worldX, worldY)) {
      if (isPositionInBuilding(worldX, worldY, building.anchorX, building.anchorY)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remap tile indices based on camera direction
   * When camera rotates, we need to access different tiles from the directional sprite
   * to maintain visual coherence with the coordinate transformation
   */
  private remapTileIndex(tileX: number, tileY: number, direction: BuildingDirection): [number, number] {
    switch (direction) {
      case 'north':
        // No remapping - tiles[tileY][tileX]
        return [tileX, tileY];
      case 'east':
        // 90° CW - tiles[tileX][2-tileY] displays as: 2 5 8 / 1 4 7 / 0 3 6
        return [2 - tileY, tileX];
      case 'south':
        // 180° - tiles[2-tileY][2-tileX]
        return [2 - tileX, 2 - tileY];
      case 'west':
        // 270° CW - tiles[2-tileX][tileY] (opposite of east)
        return [tileY, 2 - tileX];
    }
  }

  /**
   * Get building tile at world coordinates, if any
   * Returns the BuildingTile for rendering, or null if no building at that position
   * Uses spatial hash for O(1) average lookup instead of O(N)
   * @param direction - Building direction for camera rotation (defaults to 'north')
   */
  getBuildingTileAt(worldX: number, worldY: number, direction: BuildingDirection = 'north'): BuildingTile | null {
    for (const building of this.getBuildingsNearPosition(worldX, worldY)) {
      const tileIndex = getBuildingTileIndex(worldX, worldY, building.anchorX, building.anchorY);
      if (tileIndex) {
        const [tileX, tileY] = tileIndex;
        // Check if we have the proper directional sprite
        const hasDirectionalSprite = building.directionalSprites?.[direction] != null;

        if (hasDirectionalSprite) {
          // Use directional sprite with remapped indices to account for coordinate transformation
          const [remappedX, remappedY] = this.remapTileIndex(tileX, tileY, direction);
          const sprite = building.directionalSprites![direction];
          return sprite.tiles[remappedY]?.[remappedX] ?? null;
        } else {
          // Fall back to primary sprite (north) without remapping
          // The building will appear as north view regardless of camera rotation
          return building.sprite.tiles[tileY]?.[tileX] ?? null;
        }
      }
    }
    return null;
  }

  /**
   * Get building at world coordinates, if any
   * Uses spatial hash for O(1) average lookup instead of O(N)
   */
  getBuildingAt(worldX: number, worldY: number): BuildingData | null {
    for (const building of this.getBuildingsNearPosition(worldX, worldY)) {
      if (isPositionInBuilding(worldX, worldY, building.anchorX, building.anchorY)) {
        return building;
      }
    }
    return null;
  }

  /**
   * Get or generate chunk
   */
  private getChunk(chunkX: number, chunkY: number): ChunkData | null {
    const key = `${chunkX},${chunkY}`;

    let chunk = this.chunkCache.get(key);
    if (chunk) {
      chunk.accessedAt = Date.now();
      return chunk;
    }

    // Generate new chunk
    chunk = this.generateChunk(chunkX, chunkY);
    this.chunkCache.set(key, chunk);

    // Evict old chunks if needed
    this.evictOldChunks();

    return chunk;
  }

  /**
   * Generate a chunk procedurally
   */
  private generateChunk(chunkX: number, chunkY: number): ChunkData {
    const tiles: string[][] = [];
    const seed = this.worldSeed + BigInt(chunkX * 1000000) + BigInt(chunkY);
    const rand = new SeededRandom(seed);

    for (let y = 0; y < CHUNK_SIZE_TILES; y++) {
      const row: string[] = [];
      for (let x = 0; x < CHUNK_SIZE_TILES; x++) {
        const worldX = chunkX * CHUNK_SIZE_TILES + x;
        const worldY = chunkY * CHUNK_SIZE_TILES + y;

        // Use noise to determine terrain
        const elevation = this.noise.sample(worldX * 0.05, worldY * 0.05);
        const moisture = this.noise.sample(worldX * 0.03 + 1000, worldY * 0.03 + 1000);

        row.push(this.getTileIdFromTerrain(elevation, moisture, rand));
      }
      tiles.push(row);
    }

    return {
      tiles,
      accessedAt: Date.now(),
    };
  }

  /**
   * Determine tile type from terrain values
   */
  private getTileIdFromTerrain(elevation: number, moisture: number, _rand: SeededRandom): string {
    // Water in low areas
    if (elevation < 0.3) {
      return 'water';
    }

    // Beach/sand at water edges
    if (elevation < 0.35) {
      return 'sand';
    }

    // Stone at high elevations
    if (elevation > 0.75) {
      return 'stone';
    }

    // Dirt in dry areas
    if (moisture < 0.35) {
      return 'dirt';
    }

    // Default to grass
    return 'grass';
  }

  /**
   * Evict least recently used chunks
   */
  private evictOldChunks(): void {
    if (this.chunkCache.size <= this.maxChunks) return;

    // Sort by access time and remove oldest
    const entries = Array.from(this.chunkCache.entries())
      .sort((a, b) => a[1].accessedAt - b[1].accessedAt);

    const toRemove = entries.slice(0, entries.length - this.maxChunks);
    for (const [key] of toRemove) {
      this.chunkCache.delete(key);
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.chunkCache.clear();
    this.tileCache.clear();
  }

  /**
   * Destroy and clean up all resources
   */
  destroy(): void {
    this.players.clear();
    this.sprites.clear();
    this.buildings.clear();
    this.buildingsByChunk.clear();
    this.npcs.clear();
    this.npcSprites.clear();
    this.roads.clear();
    this.roadsByChunk.clear();
    this.clearCache();
  }
}

/**
 * Resize a pixel grid using nearest-neighbor sampling (works for up or downscale)
 */
function upscaleNearest(grid: PixelGrid, targetSize: number): PixelGrid {
  const srcSize = grid.length;
  if (srcSize === targetSize) return grid;

  const scale = targetSize / srcSize;
  const result: PixelGrid = [];
  for (let y = 0; y < targetSize; y++) {
    const row: Pixel[] = [];
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < targetSize; x++) {
      const srcX = Math.floor(x / scale);
      row.push(grid[srcY]?.[srcX] ?? null);
    }
    result.push(row);
  }
  return result;
}

// Aliases
const downscaleGrid = upscaleNearest;
const resizeNearest = upscaleNearest;

/**
 * Get average color from a tile (sample center pixels)
 */
function getTileAvgColor(tile: Tile): RGB {
  const pixels = tile.pixels;
  const size = pixels.length;
  const center = Math.floor(size / 2);
  const sample = pixels[center]?.[center];
  if (sample && 'r' in sample) {
    return sample as RGB;
  }
  return { r: 128, g: 128, b: 128 };
}

/**
 * Blend two colors
 */
function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/**
 * Simple edge blending - fade edge pixels toward neighbor color
 */
function blendEdges(
  pixels: PixelGrid,
  depth: number,
  north: Tile | null,
  south: Tile | null,
  east: Tile | null,
  west: Tile | null
): PixelGrid {
  const size = pixels.length;
  const result: PixelGrid = pixels.map(row => [...row]);

  const northColor = north ? getTileAvgColor(north) : null;
  const southColor = south ? getTileAvgColor(south) : null;
  const eastColor = east ? getTileAvgColor(east) : null;
  const westColor = west ? getTileAvgColor(west) : null;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pixel = result[y]![x];
      if (!pixel || !('r' in pixel)) continue;

      let blended = pixel as RGB;
      let blendCount = 0;

      // North edge
      if (northColor && y < depth) {
        const t = 1 - y / depth;
        blended = lerpColor(blended, northColor, t * 0.5);
        blendCount++;
      }
      // South edge
      if (southColor && y >= size - depth) {
        const t = (y - (size - depth)) / depth;
        blended = lerpColor(blended, southColor, t * 0.5);
        blendCount++;
      }
      // West edge
      if (westColor && x < depth) {
        const t = 1 - x / depth;
        blended = lerpColor(blended, westColor, t * 0.5);
        blendCount++;
      }
      // East edge
      if (eastColor && x >= size - depth) {
        const t = (x - (size - depth)) / depth;
        blended = lerpColor(blended, eastColor, t * 0.5);
        blendCount++;
      }

      if (blendCount > 0) {
        result[y]![x] = blended;
      }
    }
  }

  return result;
}

/**
 * Create a placeholder sprite for players without generated sprites
 * 256x256 pixels base with all resolutions pre-computed
 */
export function createPlaceholderSprite(baseColor: RGB = { r: 100, g: 150, b: 255 }): Sprite {
  const SIZE = BASE_SIZE;

  const darkColor: RGB = {
    r: Math.floor(baseColor.r * 0.6),
    g: Math.floor(baseColor.g * 0.6),
    b: Math.floor(baseColor.b * 0.6),
  };
  const skinColor: RGB = { r: 255, g: 220, b: 180 };
  const hairColor: RGB = { r: 60, g: 40, b: 30 };

  const createFrame = (): PixelGrid => {
    const grid: PixelGrid = [];

    // Scale factors for 256x256 (original was 16x16, so 16x scale)
    const scale = SIZE / 16;

    for (let y = 0; y < SIZE; y++) {
      const row: (RGB | null)[] = [];
      // Map to original 16x16 coordinate space
      const origY = Math.floor(y / scale);
      for (let x = 0; x < SIZE; x++) {
        const origX = Math.floor(x / scale);
        let pixel: RGB | null = null;

        // Hair (top)
        if (origY >= 0 && origY < 2 && origX >= 5 && origX <= 10) {
          pixel = hairColor;
        }
        // Head
        else if (origY >= 1 && origY < 5 && origX >= 5 && origX <= 10) {
          pixel = skinColor;
        }
        // Body
        else if (origY >= 5 && origY < 10 && origX >= 4 && origX <= 11) {
          pixel = baseColor;
        }
        // Legs
        else if (origY >= 10 && origY < 15) {
          if ((origX >= 5 && origX < 7) || (origX >= 9 && origX < 11)) {
            pixel = darkColor;
          }
        }

        row.push(pixel);
      }
      grid.push(row);
    }

    return grid;
  };

  const frame = createFrame();
  const baseFrames: DirectionFrames = [frame, frame, frame, frame];

  // Generate all resolutions
  const resolutions: Record<string, {
    up: DirectionFrames;
    down: DirectionFrames;
    left: DirectionFrames;
    right: DirectionFrames;
  }> = {};

  for (const size of RESOLUTIONS) {
    const scaledFrame = downscaleGrid(frame, size);
    const scaledFrames: DirectionFrames = [scaledFrame, scaledFrame, scaledFrame, scaledFrame];
    resolutions[String(size)] = {
      up: scaledFrames,
      down: scaledFrames,
      left: scaledFrames,
      right: scaledFrames,
    };
  }

  return {
    width: SIZE,
    height: SIZE,
    frames: {
      up: baseFrames,
      down: baseFrames,
      left: baseFrames,
      right: baseFrames,
    },
    resolutions,
  };
}
