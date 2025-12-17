/**
 * ANSI escape code constants
 */
export const ESC = '\x1b';
export const CSI = `${ESC}[`;
export const OSC = `${ESC}]`;

/**
 * Cursor control
 */
export const CURSOR = {
  /** Move cursor to (row, col) - 1-indexed */
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  /** Move cursor up n rows */
  up: (n: number = 1) => `${CSI}${n}A`,
  /** Move cursor down n rows */
  down: (n: number = 1) => `${CSI}${n}B`,
  /** Move cursor right n columns */
  right: (n: number = 1) => `${CSI}${n}C`,
  /** Move cursor left n columns */
  left: (n: number = 1) => `${CSI}${n}D`,
  /** Save cursor position */
  save: `${CSI}s`,
  /** Restore cursor position */
  restore: `${CSI}u`,
  /** Hide cursor */
  hide: `${CSI}?25l`,
  /** Show cursor */
  show: `${CSI}?25h`,
  /** Move to home position */
  home: `${CSI}H`,
} as const;

/**
 * Screen control
 */
export const SCREEN = {
  /** Clear entire screen */
  clear: `${CSI}2J`,
  /** Clear from cursor to end of screen */
  clearToEnd: `${CSI}0J`,
  /** Clear from cursor to beginning of screen */
  clearToStart: `${CSI}1J`,
  /** Clear entire line */
  clearLine: `${CSI}2K`,
  /** Clear from cursor to end of line */
  clearLineToEnd: `${CSI}0K`,
  /** Clear from cursor to start of line */
  clearLineToStart: `${CSI}1K`,
  /** Enter alternate screen buffer */
  enterAlt: `${CSI}?1049h`,
  /** Exit alternate screen buffer */
  exitAlt: `${CSI}?1049l`,
  /** Enable line wrapping */
  enableWrap: `${CSI}?7h`,
  /** Disable line wrapping */
  disableWrap: `${CSI}?7l`,
} as const;

/**
 * Text styling
 */
export const STYLE = {
  /** Reset all attributes */
  reset: `${CSI}0m`,
  /** Bold on */
  bold: `${CSI}1m`,
  /** Dim on */
  dim: `${CSI}2m`,
  /** Italic on */
  italic: `${CSI}3m`,
  /** Underline on */
  underline: `${CSI}4m`,
  /** Blink on */
  blink: `${CSI}5m`,
  /** Inverse on */
  inverse: `${CSI}7m`,
  /** Strikethrough on */
  strikethrough: `${CSI}9m`,
  /** Bold off */
  boldOff: `${CSI}22m`,
  /** Italic off */
  italicOff: `${CSI}23m`,
  /** Underline off */
  underlineOff: `${CSI}24m`,
  /** Blink off */
  blinkOff: `${CSI}25m`,
  /** Inverse off */
  inverseOff: `${CSI}27m`,
  /** Strikethrough off */
  strikethroughOff: `${CSI}29m`,
} as const;

/**
 * Mouse tracking
 */
export const MOUSE = {
  /** Enable basic mouse tracking */
  enableBasic: `${CSI}?1000h`,
  /** Disable basic mouse tracking */
  disableBasic: `${CSI}?1000l`,
  /** Enable button event tracking */
  enableButton: `${CSI}?1002h`,
  /** Disable button event tracking */
  disableButton: `${CSI}?1002l`,
  /** Enable any event tracking */
  enableAny: `${CSI}?1003h`,
  /** Disable any event tracking */
  disableAny: `${CSI}?1003l`,
  /** Enable SGR extended mode */
  enableSGR: `${CSI}?1006h`,
  /** Disable SGR extended mode */
  disableSGR: `${CSI}?1006l`,
} as const;
