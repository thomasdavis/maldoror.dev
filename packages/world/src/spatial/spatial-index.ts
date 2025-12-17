import { HASH_CELL_SIZE } from '../chunk/constants.js';

/**
 * Convert world coordinates to hash grid cell
 */
export function worldToCell(x: number, y: number): { cellX: number; cellY: number } {
  return {
    cellX: x >= 0 ? Math.floor(x / HASH_CELL_SIZE) : Math.floor((x - HASH_CELL_SIZE + 1) / HASH_CELL_SIZE),
    cellY: y >= 0 ? Math.floor(y / HASH_CELL_SIZE) : Math.floor((y - HASH_CELL_SIZE + 1) / HASH_CELL_SIZE),
  };
}

/**
 * Get cell key for map storage
 */
export function cellKey(cellX: number, cellY: number): string {
  return `${cellX},${cellY}`;
}

/**
 * Player position tracking
 */
interface PlayerPosition {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

/**
 * In-memory spatial index for player positions
 */
export class SpatialIndex {
  // Player ID -> position
  private playerPositions: Map<string, PlayerPosition> = new Map();
  // Cell key -> Set of player IDs
  private cellPlayers: Map<string, Set<string>> = new Map();

  /**
   * Add or update a player's position
   */
  updatePlayer(playerId: string, x: number, y: number): { oldCell: string | null; newCell: string } {
    const { cellX, cellY } = worldToCell(x, y);
    const newCellKey = cellKey(cellX, cellY);

    const oldPosition = this.playerPositions.get(playerId);
    let oldCellKey: string | null = null;

    if (oldPosition) {
      oldCellKey = cellKey(oldPosition.cellX, oldPosition.cellY);

      // Remove from old cell if changed
      if (oldCellKey !== newCellKey) {
        const oldSet = this.cellPlayers.get(oldCellKey);
        if (oldSet) {
          oldSet.delete(playerId);
          if (oldSet.size === 0) {
            this.cellPlayers.delete(oldCellKey);
          }
        }
      }
    }

    // Update player position
    this.playerPositions.set(playerId, { x, y, cellX, cellY });

    // Add to new cell
    let cellSet = this.cellPlayers.get(newCellKey);
    if (!cellSet) {
      cellSet = new Set();
      this.cellPlayers.set(newCellKey, cellSet);
    }
    cellSet.add(playerId);

    return { oldCell: oldCellKey, newCell: newCellKey };
  }

  /**
   * Remove a player from the index
   */
  removePlayer(playerId: string): void {
    const position = this.playerPositions.get(playerId);
    if (position) {
      const key = cellKey(position.cellX, position.cellY);
      const cellSet = this.cellPlayers.get(key);
      if (cellSet) {
        cellSet.delete(playerId);
        if (cellSet.size === 0) {
          this.cellPlayers.delete(key);
        }
      }
      this.playerPositions.delete(playerId);
    }
  }

  /**
   * Get player position
   */
  getPlayerPosition(playerId: string): PlayerPosition | undefined {
    return this.playerPositions.get(playerId);
  }

  /**
   * Get all players in a cell
   */
  getPlayersInCell(cellX: number, cellY: number): Set<string> {
    return this.cellPlayers.get(cellKey(cellX, cellY)) || new Set();
  }

  /**
   * Get all players in neighboring cells (3x3 grid)
   */
  getPlayersInNeighborhood(cellX: number, cellY: number, excludeId?: string): Set<string> {
    const result = new Set<string>();

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cellSet = this.cellPlayers.get(cellKey(cellX + dx, cellY + dy));
        if (cellSet) {
          for (const id of cellSet) {
            if (id !== excludeId) {
              result.add(id);
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Get all players within a rectangular viewport
   */
  getPlayersInViewport(
    viewportX: number,
    viewportY: number,
    viewportWidth: number,
    viewportHeight: number,
    excludeId?: string
  ): Array<{ playerId: string; x: number; y: number }> {
    const result: Array<{ playerId: string; x: number; y: number }> = [];

    // Get cell range
    const { cellX: minCellX, cellY: minCellY } = worldToCell(viewportX, viewportY);
    const { cellX: maxCellX, cellY: maxCellY } = worldToCell(
      viewportX + viewportWidth,
      viewportY + viewportHeight
    );

    // Check all cells in range
    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        const cellSet = this.cellPlayers.get(cellKey(cx, cy));
        if (cellSet) {
          for (const playerId of cellSet) {
            if (playerId === excludeId) continue;

            const pos = this.playerPositions.get(playerId);
            if (
              pos &&
              pos.x >= viewportX &&
              pos.x < viewportX + viewportWidth &&
              pos.y >= viewportY &&
              pos.y < viewportY + viewportHeight
            ) {
              result.push({ playerId, x: pos.x, y: pos.y });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Get total player count
   */
  getPlayerCount(): number {
    return this.playerPositions.size;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.playerPositions.clear();
    this.cellPlayers.clear();
  }
}
