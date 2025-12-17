import { CSI } from './codes.js';
import type { Color } from '@maldoror/protocol';

/**
 * 16-color palette names
 */
export const COLORS_16 = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,
} as const;

/**
 * Generate foreground color code
 */
export function fgColor(color: Color): string {
  switch (color.type) {
    case 'default':
      return `${CSI}39m`;
    case '16':
      const idx = color.value as number;
      return idx < 8 ? `${CSI}${30 + idx}m` : `${CSI}${90 + idx - 8}m`;
    case '256':
      return `${CSI}38;5;${color.value}m`;
    case 'rgb':
      const [r, g, b] = color.value as [number, number, number];
      return `${CSI}38;2;${r};${g};${b}m`;
  }
}

/**
 * Generate background color code
 */
export function bgColor(color: Color): string {
  switch (color.type) {
    case 'default':
      return `${CSI}49m`;
    case '16':
      const idx = color.value as number;
      return idx < 8 ? `${CSI}${40 + idx}m` : `${CSI}${100 + idx - 8}m`;
    case '256':
      return `${CSI}48;5;${color.value}m`;
    case 'rgb':
      const [r, g, b] = color.value as [number, number, number];
      return `${CSI}48;2;${r};${g};${b}m`;
  }
}

/**
 * Parse hex color to RGB tuple
 */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * Create RGB color from hex string
 */
export function rgb(hex: string): Color {
  return { type: 'rgb', value: hexToRgb(hex) };
}

/**
 * Create 256-color from index
 */
export function color256(index: number): Color {
  return { type: '256', value: Math.max(0, Math.min(255, index)) };
}

/**
 * Create 16-color from name or index
 */
export function color16(nameOrIndex: keyof typeof COLORS_16 | number): Color {
  const value = typeof nameOrIndex === 'string' ? COLORS_16[nameOrIndex] : nameOrIndex;
  return { type: '16', value };
}

/**
 * Default foreground color
 */
export const DEFAULT_FG: Color = { type: 'default' };

/**
 * Default background color
 */
export const DEFAULT_BG: Color = { type: 'default' };

/**
 * Compare two colors for equality
 */
export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'default') return true;
  if (a.type === 'rgb' && b.type === 'rgb') {
    const av = a.value as [number, number, number];
    const bv = b.value as [number, number, number];
    return av[0] === bv[0] && av[1] === bv[1] && av[2] === bv[2];
  }
  return a.value === b.value;
}
