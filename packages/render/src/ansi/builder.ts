import { CURSOR, SCREEN, STYLE } from './codes.js';
import { fgColor, bgColor } from './colors.js';
import type { Color, TextAttributes, Cell } from '@maldoror/protocol';

/**
 * Fluent ANSI escape sequence builder
 */
export class ANSIBuilder {
  private output: string = '';

  // Cursor movement
  moveTo(x: number, y: number): this {
    this.output += CURSOR.moveTo(y + 1, x + 1); // Convert 0-indexed to 1-indexed
    return this;
  }

  moveUp(n: number = 1): this {
    this.output += CURSOR.up(n);
    return this;
  }

  moveDown(n: number = 1): this {
    this.output += CURSOR.down(n);
    return this;
  }

  moveRight(n: number = 1): this {
    this.output += CURSOR.right(n);
    return this;
  }

  moveLeft(n: number = 1): this {
    this.output += CURSOR.left(n);
    return this;
  }

  saveCursor(): this {
    this.output += CURSOR.save;
    return this;
  }

  restoreCursor(): this {
    this.output += CURSOR.restore;
    return this;
  }

  hideCursor(): this {
    this.output += CURSOR.hide;
    return this;
  }

  showCursor(): this {
    this.output += CURSOR.show;
    return this;
  }

  // Screen control
  clearScreen(): this {
    this.output += SCREEN.clear;
    return this;
  }

  clearLine(): this {
    this.output += SCREEN.clearLine;
    return this;
  }

  enterAlternateScreen(): this {
    this.output += SCREEN.enterAlt;
    return this;
  }

  exitAlternateScreen(): this {
    this.output += SCREEN.exitAlt;
    return this;
  }

  disableLineWrap(): this {
    this.output += SCREEN.disableWrap;
    return this;
  }

  enableLineWrap(): this {
    this.output += SCREEN.enableWrap;
    return this;
  }

  // Colors
  setForeground(color: Color): this {
    this.output += fgColor(color);
    return this;
  }

  setBackground(color: Color): this {
    this.output += bgColor(color);
    return this;
  }

  // Attributes
  setAttributes(attrs: TextAttributes): this {
    if (attrs.bold) this.output += STYLE.bold;
    if (attrs.dim) this.output += STYLE.dim;
    if (attrs.italic) this.output += STYLE.italic;
    if (attrs.underline) this.output += STYLE.underline;
    if (attrs.blink) this.output += STYLE.blink;
    if (attrs.inverse) this.output += STYLE.inverse;
    if (attrs.strikethrough) this.output += STYLE.strikethrough;
    return this;
  }

  resetAttributes(): this {
    this.output += STYLE.reset;
    return this;
  }

  // Text output
  write(text: string): this {
    this.output += text;
    return this;
  }

  // Write a styled cell
  writeCell(cell: Cell): this {
    this.resetAttributes()
      .setForeground(cell.fg)
      .setBackground(cell.bg)
      .setAttributes(cell.attrs)
      .write(cell.char);
    return this;
  }

  // Write multiple cells at once (optimized)
  writeCells(cells: Cell[], startX: number, y: number): this {
    if (cells.length === 0) return this;

    this.moveTo(startX, y);

    let lastFg: Color | null = null;
    let lastBg: Color | null = null;

    for (const cell of cells) {
      // Only emit color codes when they change
      const fgChanged = !lastFg || !this.colorsEqual(lastFg, cell.fg);
      const bgChanged = !lastBg || !this.colorsEqual(lastBg, cell.bg);

      if (fgChanged || bgChanged) {
        this.resetAttributes();
        this.setForeground(cell.fg);
        this.setBackground(cell.bg);
        this.setAttributes(cell.attrs);
        lastFg = cell.fg;
        lastBg = cell.bg;
      }

      this.write(cell.char);
    }

    return this;
  }

  private colorsEqual(a: Color, b: Color): boolean {
    if (a.type !== b.type) return false;
    if (a.type === 'default') return true;
    if (a.type === 'rgb' && b.type === 'rgb') {
      const av = a.value as [number, number, number];
      const bv = b.value as [number, number, number];
      return av[0] === bv[0] && av[1] === bv[1] && av[2] === bv[2];
    }
    return a.value === b.value;
  }

  // Build and clear
  build(): string {
    const result = this.output;
    this.output = '';
    return result;
  }

  // Build without clearing (for inspection)
  peek(): string {
    return this.output;
  }

  // Clear without building
  clear(): this {
    this.output = '';
    return this;
  }

  // Get current length
  get length(): number {
    return this.output.length;
  }
}
