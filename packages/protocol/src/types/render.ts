/**
 * Color representation for terminal rendering
 */
export interface Color {
  type: 'default' | '16' | '256' | 'rgb';
  value?: number | [number, number, number];
}

/**
 * Text attributes for terminal rendering
 */
export interface TextAttributes {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

/**
 * Default text attributes (all false)
 */
export const DEFAULT_ATTRIBUTES: TextAttributes = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  strikethrough: false,
};

/**
 * Single terminal cell
 */
export interface Cell {
  char: string;
  fg: Color;
  bg: Color;
  attrs: TextAttributes;
}

/**
 * Default cell (space with default colors)
 */
export const DEFAULT_CELL: Cell = {
  char: ' ',
  fg: { type: 'default' },
  bg: { type: 'default' },
  attrs: DEFAULT_ATTRIBUTES,
};

/**
 * Input modes for terminal
 */
export type InputMode = 'game' | 'chat' | 'menu' | 'dialog';

/**
 * Key event from terminal input
 */
export interface KeyEvent {
  type: 'key' | 'mouse' | 'resize' | 'unknown';
  key?: string;
  char?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  mouse?: {
    button: number;
    x: number;
    y: number;
    action: 'press' | 'release' | 'move';
  };
}

/**
 * Panel configuration
 */
export interface PanelConfig {
  id: string;
  zIndex: number;
  visible: boolean;
}
