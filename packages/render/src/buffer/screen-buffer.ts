import type { Cell, Rect } from '@maldoror/protocol';
import { createCell, cellsEqual, cloneCell } from './cell.js';

/**
 * Double-buffered screen buffer with damage tracking
 */
export class ScreenBuffer {
  private cells: Cell[][];
  private dirty: boolean[][];
  public readonly width: number;
  public readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = this.createGrid(width, height);
    this.dirty = this.createDirtyGrid(width, height, true);
  }

  private createGrid(width: number, height: number): Cell[][] {
    return Array.from({ length: height }, () =>
      Array.from({ length: width }, () => createCell())
    );
  }

  private createDirtyGrid(width: number, height: number, initial: boolean): boolean[][] {
    return Array.from({ length: height }, () =>
      Array.from({ length: width }, () => initial)
    );
  }

  /**
   * Get cell at position (returns null if out of bounds)
   */
  getCell(x: number, y: number): Cell | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    return this.cells[y]![x]!;
  }

  /**
   * Set cell at position (no-op if out of bounds)
   */
  setCell(x: number, y: number, cell: Partial<Cell>): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }

    const current = this.cells[y]![x]!;
    const newCell = createCell({ ...current, ...cell });

    // Only mark dirty if actually changed
    if (!cellsEqual(current, newCell)) {
      this.cells[y]![x] = newCell;
      this.dirty[y]![x] = true;
    }
  }

  /**
   * Write text starting at position
   */
  writeText(x: number, y: number, text: string, fg?: Cell['fg'], bg?: Cell['bg']): void {
    for (let i = 0; i < text.length && x + i < this.width; i++) {
      const char = text[i];
      if (char !== undefined) {
        this.setCell(x + i, y, { char, ...(fg && { fg }), ...(bg && { bg }) });
      }
    }
  }

  /**
   * Fill a rectangle with a cell
   */
  fillRect(rect: Rect, cell: Partial<Cell>): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        this.setCell(x, y, cell);
      }
    }
  }

  /**
   * Clear the buffer (fill with spaces)
   */
  clear(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.setCell(x, y, createCell());
      }
    }
  }

  /**
   * Check if a cell is dirty
   */
  isDirty(x: number, y: number): boolean {
    return this.dirty[y]?.[x] ?? false;
  }

  /**
   * Mark all cells as dirty (forces full redraw)
   */
  markAllDirty(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.dirty[y]![x] = true;
      }
    }
  }

  /**
   * Clear all dirty flags
   */
  clearDirty(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.dirty[y]![x] = false;
      }
    }
  }

  /**
   * Get all dirty cells as array of {x, y, cell}
   */
  getDirtyCells(): Array<{ x: number; y: number; cell: Cell }> {
    const result: Array<{ x: number; y: number; cell: Cell }> = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.dirty[y]![x]) {
          result.push({ x, y, cell: this.cells[y]![x]! });
        }
      }
    }
    return result;
  }

  /**
   * Get dirty rows (for line-based rendering optimization)
   */
  getDirtyRows(): Array<{ y: number; cells: Array<{ x: number; cell: Cell }> }> {
    const rows: Array<{ y: number; cells: Array<{ x: number; cell: Cell }> }> = [];

    for (let y = 0; y < this.height; y++) {
      const rowCells: Array<{ x: number; cell: Cell }> = [];
      for (let x = 0; x < this.width; x++) {
        if (this.dirty[y]![x]) {
          rowCells.push({ x, cell: this.cells[y]![x]! });
        }
      }
      if (rowCells.length > 0) {
        rows.push({ y, cells: rowCells });
      }
    }

    return rows;
  }

  /**
   * Copy another buffer onto this one at an offset
   */
  blit(source: ScreenBuffer, destX: number, destY: number): void {
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const cell = source.getCell(x, y);
        if (cell) {
          this.setCell(destX + x, destY + y, cell);
        }
      }
    }
  }

  /**
   * Copy region from another buffer
   */
  blitRegion(
    source: ScreenBuffer,
    srcRect: Rect,
    destX: number,
    destY: number
  ): void {
    for (let y = 0; y < srcRect.height; y++) {
      for (let x = 0; x < srcRect.width; x++) {
        const cell = source.getCell(srcRect.x + x, srcRect.y + y);
        if (cell) {
          this.setCell(destX + x, destY + y, cell);
        }
      }
    }
  }

  /**
   * Clone this buffer
   */
  clone(): ScreenBuffer {
    const buffer = new ScreenBuffer(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        buffer.cells[y]![x] = cloneCell(this.cells[y]![x]!);
        buffer.dirty[y]![x] = this.dirty[y]![x]!;
      }
    }
    return buffer;
  }
}
