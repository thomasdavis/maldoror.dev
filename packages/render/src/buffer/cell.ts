import type { Cell, TextAttributes } from '@maldoror/protocol';
import { DEFAULT_ATTRIBUTES } from '@maldoror/protocol';
import { colorsEqual, DEFAULT_FG, DEFAULT_BG } from '../ansi/colors.js';

/**
 * Create a new cell with default values
 */
export function createCell(partial?: Partial<Cell>): Cell {
  return {
    char: partial?.char ?? ' ',
    fg: partial?.fg ?? { ...DEFAULT_FG },
    bg: partial?.bg ?? { ...DEFAULT_BG },
    attrs: partial?.attrs ?? { ...DEFAULT_ATTRIBUTES },
  };
}

/**
 * Clone a cell (deep copy)
 */
export function cloneCell(cell: Cell): Cell {
  return {
    char: cell.char,
    fg: { ...cell.fg },
    bg: { ...cell.bg },
    attrs: { ...cell.attrs },
  };
}

/**
 * Compare two cells for equality
 */
export function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg) &&
    attrsEqual(a.attrs, b.attrs)
  );
}

/**
 * Compare text attributes for equality
 */
export function attrsEqual(a: TextAttributes, b: TextAttributes): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough
  );
}
