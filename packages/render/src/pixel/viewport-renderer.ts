import type {
  PixelGrid,
  PlayerVisualState,
  NPCVisualState,
  RGB,
  WorldDataProvider,
  Direction,
  BuildingDirection
} from '@maldoror/protocol';
import { TILE_SIZE, RESOLUTIONS } from '@maldoror/protocol';
import {
  createEmptyGrid,
  renderPixelRow,
} from './pixel-renderer.js';

/**
 * Viewport configuration
 */
export interface ViewportConfig {
  widthTiles: number;   // Viewport width in tiles (used for tile count calculation)
  heightTiles: number;  // Viewport height in tiles (used for tile count calculation)
  pixelWidth?: number;  // Actual pixel width of viewport (fills screen, allows partial tiles)
  pixelHeight?: number; // Actual pixel height of viewport (fills screen, allows partial tiles)
  tileRenderSize?: number;  // Tile screen render size in pixels (default: TILE_SIZE)
  dataResolution?: number;  // Resolution to fetch from pre-computed data (default: auto-select)
}

/**
 * Text overlay to render on top of the pixel buffer
 */
export interface TextOverlay {
  text: string;
  pixelX: number;  // X position in pixels (will be converted to terminal chars)
  pixelY: number;  // Y position in pixels (will be converted to terminal rows)
  bgColor: RGB;
  fgColor: RGB;
}

/**
 * Result of rendering the viewport
 */
export interface ViewportRenderResult {
  buffer: PixelGrid;
  overlays: TextOverlay[];
}

// Re-export for convenience
export type { WorldDataProvider } from '@maldoror/protocol';

/**
 * Camera mode
 */
export type CameraMode = 'follow' | 'free';

/**
 * Camera rotation angle (90° increments)
 */
export type CameraRotation = 0 | 90 | 180 | 270;

/**
 * Direction remapping for camera rotation
 * Maps world direction → visual direction based on camera angle
 */
const DIRECTION_REMAP: Record<CameraRotation, Record<Direction, Direction>> = {
  0:   { up: 'up',    down: 'down',  left: 'left',  right: 'right' },
  90:  { up: 'right', down: 'left',  left: 'up',    right: 'down'  },
  180: { up: 'down',  down: 'up',    left: 'right', right: 'left'  },
  270: { up: 'left',  down: 'right', left: 'down',  right: 'up'    },
};

/**
 * Movement remapping for screen-relative controls
 * Maps screen direction → world direction based on camera angle
 */
export const MOVEMENT_REMAP: Record<CameraRotation, Record<Direction, Direction>> = {
  0:   { up: 'up',    down: 'down',  left: 'left',  right: 'right' },
  90:  { up: 'left',  down: 'right', left: 'down',  right: 'up'    },
  180: { up: 'down',  down: 'up',    left: 'right', right: 'left'  },
  270: { up: 'right', down: 'left',  left: 'up',    right: 'down'  },
};

/**
 * Camera rotation to building direction mapping
 * When camera rotates, we show the building from a different direction
 */
const CAMERA_TO_BUILDING_DIRECTION: Record<CameraRotation, BuildingDirection> = {
  0:   'north',
  90:  'east',
  180: 'south',
  270: 'west',
};

/**
 * Rotate a point around the origin by camera angle
 * Used to transform world coordinates to screen-relative coordinates
 */
function rotatePoint(x: number, y: number, angle: CameraRotation): { x: number; y: number } {
  switch (angle) {
    case 0:   return { x, y };
    case 90:  return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
  }
}

/**
 * Render the game viewport to ANSI strings
 */
export class ViewportRenderer {
  private config: ViewportConfig;
  // Camera center position in WORLD PIXELS (sub-tile precision)
  private cameraCenterX: number = 0;
  private cameraCenterY: number = 0;
  // Target position for smooth camera (when following player)
  private targetCenterX: number = 0;
  private targetCenterY: number = 0;
  // Camera mode
  private cameraMode: CameraMode = 'follow';
  // Camera rotation (0°, 90°, 180°, 270°)
  private cameraRotation: CameraRotation = 0;
  private pendingOverlays: TextOverlay[] = [];  // Collected during render
  private tileRenderSize: number;  // Tile screen render size in pixels
  private dataResolution: number;  // Resolution to fetch from pre-computed data
  // Performance: Cache scaled frames to avoid repeated scaling
  private scaledFrameCache: Map<string, PixelGrid> = new Map();
  private scaledFrameCacheOrder: string[] = []; // LRU order tracking
  private readonly MAX_CACHE_SIZE = 500; // Max cached frames to prevent memory explosion
  private lastCacheClearSize: number = 0;

  constructor(config: ViewportConfig) {
    this.config = config;
    this.tileRenderSize = config.tileRenderSize ?? TILE_SIZE;
    this.dataResolution = config.dataResolution ?? this.getBestResolution(this.tileRenderSize);
  }

  /**
   * Get current tile render size
   */
  getTileRenderSize(): number {
    return this.tileRenderSize;
  }

  /**
   * Set tile render size and auto-select data resolution
   */
  setTileRenderSize(size: number): void {
    const oldSize = this.tileRenderSize;
    this.tileRenderSize = size;
    this.dataResolution = this.getBestResolution(size);
    // Scale camera position to maintain world position when tile size changes
    if (oldSize > 0) {
      const scale = size / oldSize;
      this.cameraCenterX *= scale;
      this.cameraCenterY *= scale;
      this.targetCenterX *= scale;
      this.targetCenterY *= scale;
    }
  }

  /**
   * Get current data resolution being used
   */
  getDataResolution(): number {
    return this.dataResolution;
  }

  /**
   * Get camera mode
   */
  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  /**
   * Set camera mode
   */
  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
  }

  /**
   * Toggle between follow and free camera modes
   */
  toggleCameraMode(): CameraMode {
    this.cameraMode = this.cameraMode === 'follow' ? 'free' : 'follow';
    return this.cameraMode;
  }

  /**
   * Get camera rotation
   */
  getCameraRotation(): CameraRotation {
    return this.cameraRotation;
  }

  /**
   * Rotate camera clockwise by 90°
   */
  rotateCameraClockwise(): CameraRotation {
    this.cameraRotation = ((this.cameraRotation + 90) % 360) as CameraRotation;
    return this.cameraRotation;
  }

  /**
   * Rotate camera counter-clockwise by 90°
   */
  rotateCameraCounterClockwise(): CameraRotation {
    this.cameraRotation = ((this.cameraRotation + 270) % 360) as CameraRotation;
    return this.cameraRotation;
  }

  /**
   * Get the visual direction for a world direction based on camera rotation
   */
  getVisualDirection(worldDirection: Direction): Direction {
    return DIRECTION_REMAP[this.cameraRotation][worldDirection];
  }

  /**
   * Get the world direction for a screen direction based on camera rotation
   * Used for screen-relative movement controls
   */
  getWorldDirection(screenDirection: Direction): Direction {
    return MOVEMENT_REMAP[this.cameraRotation][screenDirection];
  }

  /**
   * Get the building direction for current camera rotation
   * Used to select which building sprite rotation to render
   */
  getBuildingDirection(): BuildingDirection {
    return CAMERA_TO_BUILDING_DIRECTION[this.cameraRotation];
  }

  /**
   * Transform world pixel coordinates to screen pixel coordinates
   * Applies camera rotation around the camera center point
   */
  private worldToScreen(worldX: number, worldY: number, cameraX: number, cameraY: number): { x: number; y: number } {
    // Get offset from camera center in world coordinates
    const offsetX = worldX - cameraX;
    const offsetY = worldY - cameraY;
    // Rotate the offset
    const rotated = rotatePoint(offsetX, offsetY, this.cameraRotation);
    return rotated;  // Returns offset from screen center
  }

  /**
   * Set camera to center on a tile position (used when following player)
   * Camera tracks the CENTER of the given tile in world pixels
   */
  setCamera(tileX: number, tileY: number): void {
    // Target is the CENTER of the player's tile (in world pixels)
    this.targetCenterX = (tileX + 0.5) * this.tileRenderSize;
    this.targetCenterY = (tileY + 0.5) * this.tileRenderSize;

    // In follow mode, snap to target (or could lerp for smooth follow)
    if (this.cameraMode === 'follow') {
      this.cameraCenterX = this.targetCenterX;
      this.cameraCenterY = this.targetCenterY;
    }
  }

  /**
   * Pan the camera by pixel offset (for free camera mode)
   */
  panCamera(deltaX: number, deltaY: number): void {
    this.cameraCenterX += deltaX;
    this.cameraCenterY += deltaY;
  }

  /**
   * Pan the camera by tile offset
   */
  panCameraByTiles(deltaTilesX: number, deltaTilesY: number): void {
    this.cameraCenterX += deltaTilesX * this.tileRenderSize;
    this.cameraCenterY += deltaTilesY * this.tileRenderSize;
  }

  /**
   * Snap camera back to follow target (player position)
   */
  snapToTarget(): void {
    this.cameraCenterX = this.targetCenterX;
    this.cameraCenterY = this.targetCenterY;
  }

  /**
   * Get camera center in world pixels
   */
  getCameraCenter(): { x: number; y: number } {
    return { x: this.cameraCenterX, y: this.cameraCenterY };
  }

  /**
   * Get camera center in tile coordinates
   */
  getCameraTilePosition(): { x: number; y: number } {
    return {
      x: this.cameraCenterX / this.tileRenderSize - 0.5,
      y: this.cameraCenterY / this.tileRenderSize - 0.5,
    };
  }

  /**
   * Get the top-left world pixel coordinate of the viewport
   */
  private getViewportOrigin(): { x: number; y: number } {
    // Use explicit pixel dimensions if set, otherwise calculate from tiles
    const viewportPixelWidth = this.config.pixelWidth ?? (this.config.widthTiles * this.tileRenderSize);
    const viewportPixelHeight = this.config.pixelHeight ?? (this.config.heightTiles * this.tileRenderSize);
    return {
      x: this.cameraCenterX - viewportPixelWidth / 2,
      y: this.cameraCenterY - viewportPixelHeight / 2,
    };
  }

  /**
   * Render the viewport and return array of ANSI strings (one per terminal row)
   */
  render(world: WorldDataProvider, tick: number): string[] {
    const result = this.renderToBuffer(world, tick);
    return this.bufferToAnsi(result.buffer);
  }

  /**
   * Render the viewport to a raw pixel buffer with text overlays
   */
  renderToBuffer(world: WorldDataProvider, tick: number): ViewportRenderResult {
    // Reset overlays for this frame
    this.pendingOverlays = [];

    // Use explicit pixel dimensions if set, otherwise calculate from tiles
    // This allows filling the entire screen with partial tiles at edges
    const pixelWidth = this.config.pixelWidth ?? (this.config.widthTiles * this.tileRenderSize);
    const pixelHeight = this.config.pixelHeight ?? (this.config.heightTiles * this.tileRenderSize);

    // Create the pixel buffer
    const buffer = createEmptyGrid(pixelWidth, pixelHeight);

    // Get viewport origin in world pixels
    const origin = this.getViewportOrigin();

    // 1. Render terrain tiles with sub-pixel offset
    this.renderTiles(buffer, world, tick, origin);

    // 2. Render road tiles on top of terrain (with transparency)
    this.renderRoads(buffer, world, origin);

    // 3. Render building tiles on top of roads (with transparency)
    this.renderBuildings(buffer, world, origin);

    // 4. Render players and NPCs together (sorted by Y for proper overlap)
    this.renderEntities(buffer, world, tick, origin);

    return {
      buffer,
      overlays: this.pendingOverlays,
    };
  }

  /**
   * Render tiles to buffer with sub-pixel camera positioning and camera rotation
   */
  private renderTiles(buffer: PixelGrid, world: WorldDataProvider, tick: number, _origin: { x: number; y: number }): void {
    // Use the pre-selected data resolution
    const resKey = String(this.dataResolution);

    // Screen center in buffer coordinates
    const screenCenterX = buffer[0]!.length / 2;
    const screenCenterY = buffer.length / 2;

    // Calculate the world bounds we need to sample (larger area to cover rotated viewport)
    const viewportRadius = Math.max(buffer[0]!.length, buffer.length) / this.tileRenderSize + 2;
    const cameraTileX = Math.floor(this.cameraCenterX / this.tileRenderSize);
    const cameraTileY = Math.floor(this.cameraCenterY / this.tileRenderSize);

    const startTileX = cameraTileX - Math.ceil(viewportRadius);
    const startTileY = cameraTileY - Math.ceil(viewportRadius);
    const endTileX = cameraTileX + Math.ceil(viewportRadius);
    const endTileY = cameraTileY + Math.ceil(viewportRadius);

    for (let worldTileY = startTileY; worldTileY <= endTileY; worldTileY++) {
      for (let worldTileX = startTileX; worldTileX <= endTileX; worldTileX++) {
        const tile = world.getTile(worldTileX, worldTileY);

        if (tile) {
          // Get the right frame for animated tiles, using pre-computed resolution if available
          let tilePixels: PixelGrid;
          if (tile.animated && tile.animationFrames) {
            const frameIndex = Math.floor(tick / 15) % tile.animationFrames.length;
            // Try animation resolutions first
            if (tile.animationResolutions?.[resKey]) {
              tilePixels = tile.animationResolutions[resKey][frameIndex] ?? tile.pixels;
            } else {
              tilePixels = tile.animationFrames[frameIndex] ?? tile.pixels;
            }
          } else {
            // Use pre-computed resolution if available
            tilePixels = tile.resolutions?.[resKey] ?? tile.pixels;
          }

          // Scale to exact tile render size if needed (with caching)
          const frameId = tile.animated
            ? `tile:${tile.id}:${Math.floor(tick / 15) % (tile.animationFrames?.length ?? 1)}`
            : `tile:${tile.id}`;
          const scaledPixels = this.scaleFrame(tilePixels, this.tileRenderSize, this.tileRenderSize, frameId);

          // Calculate screen position with rotation
          // World pixel position of tile center
          const worldPixelX = (worldTileX + 0.5) * this.tileRenderSize;
          const worldPixelY = (worldTileY + 0.5) * this.tileRenderSize;
          // Transform to screen coordinates (offset from screen center)
          const screenOffset = this.worldToScreen(worldPixelX, worldPixelY, this.cameraCenterX, this.cameraCenterY);
          // Convert to buffer coordinates (top-left of tile)
          // Use Math.floor for consistent alignment of adjacent tiles
          const screenX = Math.floor(screenCenterX + screenOffset.x - this.tileRenderSize / 2);
          const screenY = Math.floor(screenCenterY + screenOffset.y - this.tileRenderSize / 2);

          // Copy tile pixels to buffer (handling partial tiles at edges)
          for (let py = 0; py < scaledPixels.length; py++) {
            const tileRow = scaledPixels[py];
            if (!tileRow) continue;

            const bufferY = screenY + py;
            if (bufferY < 0 || bufferY >= buffer.length) continue;

            for (let px = 0; px < tileRow.length; px++) {
              const bufferX = screenX + px;
              if (bufferX < 0 || bufferX >= buffer[bufferY]!.length) continue;

              const pixel = tileRow[px];
              if (pixel) {
                buffer[bufferY]![bufferX] = pixel;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Render road tiles on top of terrain (with transparency support and camera rotation)
   */
  private renderRoads(buffer: PixelGrid, world: WorldDataProvider, _origin: { x: number; y: number }): void {
    // Skip if world doesn't support roads
    if (!world.getRoadTileAt) return;

    const resKey = String(this.dataResolution);

    // Screen center in buffer coordinates
    const screenCenterX = buffer[0]!.length / 2;
    const screenCenterY = buffer.length / 2;

    // Calculate the world bounds we need to sample (larger area to cover rotated viewport)
    const viewportRadius = Math.max(buffer[0]!.length, buffer.length) / this.tileRenderSize + 2;
    const cameraTileX = Math.floor(this.cameraCenterX / this.tileRenderSize);
    const cameraTileY = Math.floor(this.cameraCenterY / this.tileRenderSize);

    const startTileX = cameraTileX - Math.ceil(viewportRadius);
    const startTileY = cameraTileY - Math.ceil(viewportRadius);
    const endTileX = cameraTileX + Math.ceil(viewportRadius);
    const endTileY = cameraTileY + Math.ceil(viewportRadius);

    for (let worldTileY = startTileY; worldTileY <= endTileY; worldTileY++) {
      for (let worldTileX = startTileX; worldTileX <= endTileX; worldTileX++) {
        const roadTile = world.getRoadTileAt(worldTileX, worldTileY);
        if (!roadTile) continue;

        // Get the appropriate resolution
        const tilePixels = roadTile.resolutions?.[resKey] ?? roadTile.pixels;

        // Scale to exact tile render size if needed (with caching by position)
        const frameId = `road:${worldTileX},${worldTileY}`;
        const scaledPixels = this.scaleFrame(tilePixels, this.tileRenderSize, this.tileRenderSize, frameId);

        // Calculate screen position with rotation
        // World pixel position of tile center
        const worldPixelX = (worldTileX + 0.5) * this.tileRenderSize;
        const worldPixelY = (worldTileY + 0.5) * this.tileRenderSize;
        // Transform to screen coordinates (offset from screen center)
        const screenOffset = this.worldToScreen(worldPixelX, worldPixelY, this.cameraCenterX, this.cameraCenterY);
        // Convert to buffer coordinates (top-left of tile)
        // Use Math.floor for consistent alignment of adjacent tiles
        const screenX = Math.floor(screenCenterX + screenOffset.x - this.tileRenderSize / 2);
        const screenY = Math.floor(screenCenterY + screenOffset.y - this.tileRenderSize / 2);

        // Copy road pixels to buffer (only non-transparent pixels)
        for (let py = 0; py < scaledPixels.length; py++) {
          const tileRow = scaledPixels[py];
          if (!tileRow) continue;

          const bufferY = screenY + py;
          if (bufferY < 0 || bufferY >= buffer.length) continue;

          for (let px = 0; px < tileRow.length; px++) {
            const bufferX = screenX + px;
            if (bufferX < 0 || bufferX >= buffer[bufferY]!.length) continue;

            const pixel = tileRow[px];
            if (pixel) {
              // Only overwrite if pixel is not transparent
              buffer[bufferY]![bufferX] = pixel;
            }
          }
        }
      }
    }
  }

  /**
   * Render building tiles on top of terrain (with transparency support and camera rotation)
   */
  private renderBuildings(buffer: PixelGrid, world: WorldDataProvider, _origin: { x: number; y: number }): void {
    // Skip if world doesn't support buildings
    if (!world.getBuildingTileAt) return;

    const resKey = String(this.dataResolution);
    const buildingDirection = this.getBuildingDirection();

    // Screen center in buffer coordinates
    const screenCenterX = buffer[0]!.length / 2;
    const screenCenterY = buffer.length / 2;

    // Calculate the world bounds we need to sample (larger area to cover rotated viewport)
    const viewportRadius = Math.max(buffer[0]!.length, buffer.length) / this.tileRenderSize + 2;
    const cameraTileX = Math.floor(this.cameraCenterX / this.tileRenderSize);
    const cameraTileY = Math.floor(this.cameraCenterY / this.tileRenderSize);

    const startTileX = cameraTileX - Math.ceil(viewportRadius);
    const startTileY = cameraTileY - Math.ceil(viewportRadius);
    const endTileX = cameraTileX + Math.ceil(viewportRadius);
    const endTileY = cameraTileY + Math.ceil(viewportRadius);

    for (let worldTileY = startTileY; worldTileY <= endTileY; worldTileY++) {
      for (let worldTileX = startTileX; worldTileX <= endTileX; worldTileX++) {
        const buildingTile = world.getBuildingTileAt(worldTileX, worldTileY, buildingDirection);
        if (!buildingTile) continue;

        // Get the appropriate resolution
        const tilePixels = buildingTile.resolutions?.[resKey] ?? buildingTile.pixels;

        // Scale to exact tile render size if needed (with caching by position)
        const frameId = `building:${worldTileX},${worldTileY}:${buildingDirection}`;
        const scaledPixels = this.scaleFrame(tilePixels, this.tileRenderSize, this.tileRenderSize, frameId);

        // Calculate screen position with rotation
        // World pixel position of tile center
        const worldPixelX = (worldTileX + 0.5) * this.tileRenderSize;
        const worldPixelY = (worldTileY + 0.5) * this.tileRenderSize;
        // Transform to screen coordinates (offset from screen center)
        const screenOffset = this.worldToScreen(worldPixelX, worldPixelY, this.cameraCenterX, this.cameraCenterY);
        // Convert to buffer coordinates (top-left of tile)
        // Use Math.floor for consistent alignment of adjacent tiles
        const screenX = Math.floor(screenCenterX + screenOffset.x - this.tileRenderSize / 2);
        const screenY = Math.floor(screenCenterY + screenOffset.y - this.tileRenderSize / 2);

        // Copy building pixels to buffer (only non-transparent pixels)
        for (let py = 0; py < scaledPixels.length; py++) {
          const tileRow = scaledPixels[py];
          if (!tileRow) continue;

          const bufferY = screenY + py;
          if (bufferY < 0 || bufferY >= buffer.length) continue;

          for (let px = 0; px < tileRow.length; px++) {
            const bufferX = screenX + px;
            if (bufferX < 0 || bufferX >= buffer[bufferY]!.length) continue;

            const pixel = tileRow[px];
            if (pixel) {
              // Only overwrite if pixel is not transparent
              buffer[bufferY]![bufferX] = pixel;
            }
          }
        }
      }
    }
  }

  /**
   * Get the best resolution size for the current render size
   */
  private getBestResolution(targetSize: number): number {
    // Find the closest resolution that is >= targetSize
    for (const res of RESOLUTIONS) {
      if (res >= targetSize) return res;
    }
    // If target is larger than max, return max
    return RESOLUTIONS[RESOLUTIONS.length - 1] ?? 256;
  }

  /**
   * Scale a sprite frame to target size using nearest-neighbor sampling
   * Uses caching when frameId is provided for performance
   */
  private scaleFrame(frame: PixelGrid, targetWidth: number, targetHeight: number, frameId?: string): PixelGrid {
    const srcHeight = frame.length;
    const srcWidth = frame[0]?.length ?? 0;

    // If already correct size, return as-is
    if (srcWidth === targetWidth && srcHeight === targetHeight) {
      return frame;
    }

    // Clear cache if tile size changed
    if (this.lastCacheClearSize !== this.tileRenderSize) {
      this.scaledFrameCache.clear();
      this.scaledFrameCacheOrder = [];
      this.lastCacheClearSize = this.tileRenderSize;
    }

    // Check cache if we have an ID
    if (frameId) {
      const cacheKey = `${frameId}:${targetWidth}x${targetHeight}`;
      const cached = this.scaledFrameCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Evict oldest entries if cache is full
      while (this.scaledFrameCacheOrder.length >= this.MAX_CACHE_SIZE) {
        const oldestKey = this.scaledFrameCacheOrder.shift();
        if (oldestKey) {
          this.scaledFrameCache.delete(oldestKey);
        }
      }

      // Scale and cache
      const result = this.scaleFrameUncached(frame, targetWidth, targetHeight);
      this.scaledFrameCache.set(cacheKey, result);
      this.scaledFrameCacheOrder.push(cacheKey);
      return result;
    }

    // No ID, scale without caching
    return this.scaleFrameUncached(frame, targetWidth, targetHeight);
  }

  /**
   * Scale a frame without caching (internal helper)
   */
  private scaleFrameUncached(frame: PixelGrid, targetWidth: number, targetHeight: number): PixelGrid {
    const srcHeight = frame.length;
    const srcWidth = frame[0]?.length ?? 0;

    const result: PixelGrid = [];
    for (let y = 0; y < targetHeight; y++) {
      const row: (RGB | null)[] = [];
      const srcY = Math.floor(y * srcHeight / targetHeight);
      for (let x = 0; x < targetWidth; x++) {
        const srcX = Math.floor(x * srcWidth / targetWidth);
        row.push(frame[srcY]?.[srcX] ?? null);
      }
      result.push(row);
    }
    return result;
  }

  /**
   * Entity type union for combined player/NPC rendering
   */
  private isPlayer(entity: PlayerVisualState | NPCVisualState): entity is PlayerVisualState {
    return 'userId' in entity;
  }

  /**
   * Render players and NPCs to buffer with sub-pixel camera positioning and camera rotation
   * Both entity types are combined and Y-sorted for proper overlap rendering
   */
  private renderEntities(buffer: PixelGrid, world: WorldDataProvider, _tick: number, _origin: { x: number; y: number }): void {
    const players = world.getPlayers();
    const npcs = world.getNPCs?.() ?? [];
    const localId = world.getLocalPlayerId();

    // Screen center in buffer coordinates
    const screenCenterX = buffer[0]!.length / 2;
    const screenCenterY = buffer.length / 2;

    // Combine players and NPCs into a single array for proper Y-sorting
    const entities: (PlayerVisualState | NPCVisualState)[] = [...players, ...npcs];

    // Sort by Y position for proper layering (lower Y drawn first)
    // When camera is rotated, we need to sort by the rotated Y position
    const sortedEntities = entities.sort((a, b) => {
      const aWorld = { x: a.x * this.tileRenderSize, y: a.y * this.tileRenderSize };
      const bWorld = { x: b.x * this.tileRenderSize, y: b.y * this.tileRenderSize };
      const aScreen = this.worldToScreen(aWorld.x, aWorld.y, this.cameraCenterX, this.cameraCenterY);
      const bScreen = this.worldToScreen(bWorld.x, bWorld.y, this.cameraCenterX, this.cameraCenterY);
      return aScreen.y - bScreen.y;
    });

    for (const entity of sortedEntities) {
      const isPlayerEntity = this.isPlayer(entity);
      const entityId = isPlayerEntity ? entity.userId : entity.npcId;
      const entityName = isPlayerEntity ? entity.username : entity.name;

      // Get sprite based on entity type
      const sprite = isPlayerEntity
        ? world.getPlayerSprite(entity.userId)
        : world.getNPCSprite?.(entity.npcId);

      if (!sprite) {
        // Render placeholder if no sprite
        if (isPlayerEntity) {
          this.renderPlaceholderPlayer(buffer, entity, screenCenterX, screenCenterY);
        } else {
          this.renderPlaceholderNPC(buffer, entity, screenCenterX, screenCenterY);
        }
        continue;
      }

      // Use the pre-selected data resolution
      const resKey = String(this.dataResolution);

      // Remap direction based on camera rotation (world direction → visual direction)
      const visualDirection = this.getVisualDirection(entity.direction);

      // Try to get pre-computed resolution, fall back to base frames
      let directionFrames = sprite.resolutions?.[resKey]?.[visualDirection];
      if (!directionFrames) {
        directionFrames = sprite.frames[visualDirection];
      }

      const rawFrame = directionFrames[entity.animationFrame];
      if (!rawFrame) continue;

      // Scale to exact tile render size if needed (with caching)
      // Use visual direction in cache key since same world direction shows different sprite when rotated
      const entityType = isPlayerEntity ? 'player' : 'npc';
      const frameId = `${entityType}:${entityId}:${visualDirection}:${entity.animationFrame}`;
      const frame = this.scaleFrame(rawFrame, this.tileRenderSize, this.tileRenderSize, frameId);

      // Calculate screen position with rotation
      // World pixel position of entity (center of their tile)
      const worldPixelX = (entity.x + 0.5) * this.tileRenderSize;
      const worldPixelY = (entity.y + 0.5) * this.tileRenderSize;
      // Transform to screen coordinates (offset from screen center)
      const screenOffset = this.worldToScreen(worldPixelX, worldPixelY, this.cameraCenterX, this.cameraCenterY);
      // Convert to buffer coordinates (top-left of sprite)
      // Use Math.floor for consistent alignment with terrain tiles
      const screenX = Math.floor(screenCenterX + screenOffset.x - this.tileRenderSize / 2);
      const screenY = Math.floor(screenCenterY + screenOffset.y - this.tileRenderSize / 2);

      // Composite sprite onto buffer
      for (let py = 0; py < frame.length; py++) {
        const spriteRow = frame[py];
        if (!spriteRow) continue;

        const targetY = screenY + py;
        if (targetY < 0 || targetY >= buffer.length) continue;

        for (let px = 0; px < spriteRow.length; px++) {
          const pixel = spriteRow[px];
          if (pixel === null || pixel === undefined) continue;  // Transparent or undefined

          const targetX = screenX + px;
          if (targetX < 0 || targetX >= (buffer[targetY]?.length ?? 0)) continue;

          buffer[targetY]![targetX] = pixel;
        }
      }

      // Add name overlay above sprite
      // For players: show username for other players (not self)
      // For NPCs: always show name
      const showOverlay = isPlayerEntity ? entity.userId !== localId : true;
      if (showOverlay) {
        // Center the name above the sprite
        const namePixelX = screenX + Math.floor(this.tileRenderSize / 2);
        const namePixelY = screenY - Math.max(6, Math.floor(this.tileRenderSize / 10));  // Scale overlay offset

        // NPCs get a slightly different color scheme (amber/gold text)
        const overlayColors = isPlayerEntity
          ? { bgColor: { r: 40, g: 40, b: 60 }, fgColor: { r: 255, g: 255, b: 255 } }  // Players: blue-gray bg, white text
          : { bgColor: { r: 60, g: 50, b: 30 }, fgColor: { r: 255, g: 200, b: 100 } }; // NPCs: brown bg, gold text

        this.pendingOverlays.push({
          text: entityName,
          pixelX: namePixelX,
          pixelY: namePixelY,
          ...overlayColors,
        });
      }
    }
  }

  /**
   * Render a placeholder for players without sprites
   * This is a small fallback marker - the actual placeholder sprite is generated separately
   */
  private renderPlaceholderPlayer(buffer: PixelGrid, player: PlayerVisualState, screenCenterX: number, screenCenterY: number): void {
    // Calculate screen position with rotation
    const worldPixelX = (player.x + 0.5) * this.tileRenderSize;
    const worldPixelY = (player.y + 0.5) * this.tileRenderSize;
    const screenOffset = this.worldToScreen(worldPixelX, worldPixelY, this.cameraCenterX, this.cameraCenterY);
    // Use Math.floor for consistent alignment with terrain tiles
    const screenX = Math.floor(screenCenterX + screenOffset.x - this.tileRenderSize / 2);
    const screenY = Math.floor(screenCenterY + screenOffset.y - this.tileRenderSize / 2);

    // Marker is same size as current tile render size
    const markerSize = this.tileRenderSize;

    // Simple colored square placeholder
    const placeholderColor: RGB = { r: 255, g: 200, b: 50 };
    for (let py = 0; py < markerSize; py++) {
      for (let px = 0; px < markerSize; px++) {
        const targetY = screenY + py;
        const targetX = screenX + px;
        if (targetY >= 0 && targetY < buffer.length &&
            targetX >= 0 && targetX < (buffer[targetY]?.length ?? 0)) {
          buffer[targetY]![targetX] = placeholderColor;
        }
      }
    }
  }

  /**
   * Render a placeholder for NPCs without sprites
   * Uses a different color scheme to distinguish from players
   */
  private renderPlaceholderNPC(buffer: PixelGrid, npc: NPCVisualState, screenCenterX: number, screenCenterY: number): void {
    // Calculate screen position with rotation
    const worldPixelX = (npc.x + 0.5) * this.tileRenderSize;
    const worldPixelY = (npc.y + 0.5) * this.tileRenderSize;
    const screenOffset = this.worldToScreen(worldPixelX, worldPixelY, this.cameraCenterX, this.cameraCenterY);
    // Use Math.floor for consistent alignment with terrain tiles
    const screenX = Math.floor(screenCenterX + screenOffset.x - this.tileRenderSize / 2);
    const screenY = Math.floor(screenCenterY + screenOffset.y - this.tileRenderSize / 2);

    // Marker is same size as current tile render size
    const markerSize = this.tileRenderSize;

    // NPC placeholder color (amber/orange to distinguish from yellow player)
    const placeholderColor: RGB = { r: 255, g: 150, b: 50 };
    for (let py = 0; py < markerSize; py++) {
      for (let px = 0; px < markerSize; px++) {
        const targetY = screenY + py;
        const targetX = screenX + px;
        if (targetY >= 0 && targetY < buffer.length &&
            targetX >= 0 && targetX < (buffer[targetY]?.length ?? 0)) {
          buffer[targetY]![targetX] = placeholderColor;
        }
      }
    }
  }

  /**
   * Convert pixel buffer to ANSI strings
   */
  private bufferToAnsi(buffer: PixelGrid): string[] {
    return buffer.map(row => renderPixelRow(row));
  }

  /**
   * Get viewport dimensions in terminal characters
   */
  getTerminalDimensions(): { width: number; height: number } {
    return {
      width: this.config.widthTiles * this.tileRenderSize * 2,  // 2 chars per pixel
      height: this.config.heightTiles * this.tileRenderSize,     // 1 char per pixel row
    };
  }

  /**
   * Resize viewport (tile-based)
   */
  resize(widthTiles: number, heightTiles: number): void {
    this.config.widthTiles = widthTiles;
    this.config.heightTiles = heightTiles;
  }

  /**
   * Set exact pixel dimensions for the viewport
   * This allows filling the entire screen with partial tiles at edges
   */
  setPixelDimensions(pixelWidth: number, pixelHeight: number): void {
    this.config.pixelWidth = pixelWidth;
    this.config.pixelHeight = pixelHeight;
  }

  /**
   * Get current pixel dimensions
   */
  getPixelDimensions(): { width: number; height: number } {
    return {
      width: this.config.pixelWidth ?? (this.config.widthTiles * this.tileRenderSize),
      height: this.config.pixelHeight ?? (this.config.heightTiles * this.tileRenderSize),
    };
  }
}
