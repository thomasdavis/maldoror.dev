import type {
  PixelGrid,
  PlayerVisualState,
  RGB,
  WorldDataProvider
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
  private pendingOverlays: TextOverlay[] = [];  // Collected during render
  private tileRenderSize: number;  // Tile screen render size in pixels
  private dataResolution: number;  // Resolution to fetch from pre-computed data

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

    // 1. Render tiles with sub-pixel offset
    this.renderTiles(buffer, world, tick, origin);

    // 2. Render players (sorted by Y for proper overlap)
    this.renderPlayers(buffer, world, tick, origin);

    return {
      buffer,
      overlays: this.pendingOverlays,
    };
  }

  /**
   * Render tiles to buffer with sub-pixel camera positioning
   */
  private renderTiles(buffer: PixelGrid, world: WorldDataProvider, tick: number, origin: { x: number; y: number }): void {
    // Use the pre-selected data resolution
    const resKey = String(this.dataResolution);

    // Calculate which tiles are visible (with +1 padding for partial tiles at edges)
    const startTileX = Math.floor(origin.x / this.tileRenderSize);
    const startTileY = Math.floor(origin.y / this.tileRenderSize);
    const endTileX = Math.ceil((origin.x + buffer[0]!.length) / this.tileRenderSize);
    const endTileY = Math.ceil((origin.y + buffer.length) / this.tileRenderSize);

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

          // Scale to exact tile render size if needed
          const scaledPixels = this.scaleFrame(tilePixels, this.tileRenderSize, this.tileRenderSize);

          // Calculate screen position (world pixel position minus viewport origin)
          const screenX = Math.round(worldTileX * this.tileRenderSize - origin.x);
          const screenY = Math.round(worldTileY * this.tileRenderSize - origin.y);

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
   */
  private scaleFrame(frame: PixelGrid, targetWidth: number, targetHeight: number): PixelGrid {
    const srcHeight = frame.length;
    const srcWidth = frame[0]?.length ?? 0;

    // If already correct size, return as-is
    if (srcWidth === targetWidth && srcHeight === targetHeight) {
      return frame;
    }

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
   * Render players to buffer with sub-pixel camera positioning
   */
  private renderPlayers(buffer: PixelGrid, world: WorldDataProvider, _tick: number, origin: { x: number; y: number }): void {
    const players = world.getPlayers();
    const localId = world.getLocalPlayerId();

    // Sort by Y position for proper layering (lower Y drawn first)
    const sortedPlayers = [...players].sort((a, b) => a.y - b.y);

    for (const player of sortedPlayers) {
      const sprite = world.getPlayerSprite(player.userId);
      if (!sprite) {
        // Render placeholder if no sprite
        this.renderPlaceholderPlayer(buffer, player, origin);
        continue;
      }

      // Use the pre-selected data resolution
      const resKey = String(this.dataResolution);

      // Try to get pre-computed resolution, fall back to base frames
      let directionFrames = sprite.resolutions?.[resKey]?.[player.direction];
      if (!directionFrames) {
        directionFrames = sprite.frames[player.direction];
      }

      const rawFrame = directionFrames[player.animationFrame];
      if (!rawFrame) continue;

      // Scale to exact tile render size if needed
      const frame = this.scaleFrame(rawFrame, this.tileRenderSize, this.tileRenderSize);

      // Calculate screen position (world pixel position minus viewport origin)
      const worldPixelX = player.x * this.tileRenderSize;
      const worldPixelY = player.y * this.tileRenderSize;
      const screenX = Math.round(worldPixelX - origin.x);
      const screenY = Math.round(worldPixelY - origin.y);

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

      // Add username overlay above sprite for other players
      if (player.userId !== localId) {
        // Center the username above the sprite
        const usernamePixelX = screenX + Math.floor(this.tileRenderSize / 2);
        const usernamePixelY = screenY - Math.max(6, Math.floor(this.tileRenderSize / 10));  // Scale overlay offset

        this.pendingOverlays.push({
          text: player.username,
          pixelX: usernamePixelX,
          pixelY: usernamePixelY,
          bgColor: { r: 40, g: 40, b: 60 },    // Dark blue-gray background
          fgColor: { r: 255, g: 255, b: 255 }, // White text
        });
      }
    }
  }

  /**
   * Render a placeholder for players without sprites
   * This is a small fallback marker - the actual placeholder sprite is generated separately
   */
  private renderPlaceholderPlayer(buffer: PixelGrid, player: PlayerVisualState, origin: { x: number; y: number }): void {
    // Calculate screen position (world pixel position minus viewport origin)
    const worldPixelX = player.x * this.tileRenderSize;
    const worldPixelY = player.y * this.tileRenderSize;
    const screenX = Math.round(worldPixelX - origin.x);
    const screenY = Math.round(worldPixelY - origin.y);

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
