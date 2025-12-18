/**
 * Maldoror Brand Colors
 *
 * IMPORTANT: Maldoror ALWAYS uses dark backgrounds. No component should ever
 * allow the user's system theme to override these colors. Every screen,
 * modal, and component must explicitly set its background color.
 */

const ESC = '\x1b';

// Primary dark background - near-black with purple tint
export const BG_PRIMARY = { r: 15, g: 12, b: 18 };
export const BG_PRIMARY_ANSI = `${ESC}[48;2;${BG_PRIMARY.r};${BG_PRIMARY.g};${BG_PRIMARY.b}m`;

// Secondary dark background - slightly lighter for panels
export const BG_SECONDARY = { r: 20, g: 18, b: 25 };
export const BG_SECONDARY_ANSI = `${ESC}[48;2;${BG_SECONDARY.r};${BG_SECONDARY.g};${BG_SECONDARY.b}m`;

// Tertiary background - for headers, status bars
export const BG_TERTIARY = { r: 25, g: 22, b: 32 };
export const BG_TERTIARY_ANSI = `${ESC}[48;2;${BG_TERTIARY.r};${BG_TERTIARY.g};${BG_TERTIARY.b}m`;

// Modal/overlay background
export const BG_MODAL = { r: 22, g: 20, b: 30 };
export const BG_MODAL_ANSI = `${ESC}[48;2;${BG_MODAL.r};${BG_MODAL.g};${BG_MODAL.b}m`;

// Broody crimson gradient (high contrast on dark)
export const CRIMSON_BRIGHT = { r: 180, g: 60, b: 90 };
export const CRIMSON_MID = { r: 140, g: 45, b: 70 };
export const CRIMSON_DARK = { r: 100, g: 35, b: 55 };

// Text colors (high contrast on dark backgrounds)
export const TEXT_PRIMARY = { r: 200, g: 195, b: 205 };    // Bright gray
export const TEXT_SECONDARY = { r: 140, g: 135, b: 145 };  // Muted gray
export const TEXT_DIM = { r: 90, g: 85, b: 95 };           // Very dim

// Accent colors
export const ACCENT_CYAN = { r: 120, g: 200, b: 255 };     // Bright cyan
export const ACCENT_GOLD = { r: 255, g: 200, b: 100 };     // Golden amber
export const ACCENT_GREEN = { r: 120, g: 180, b: 120 };    // Muted green
export const ACCENT_RED = { r: 180, g: 80, b: 80 };        // Visible dark red

// Border colors
export const BORDER_DIM = { r: 60, g: 50, b: 65 };
export const BORDER_VISIBLE = { r: 80, g: 70, b: 90 };
export const BORDER_ACCENT = { r: 100, g: 90, b: 120 };

/**
 * Generate foreground ANSI code
 */
export function fg(color: { r: number; g: number; b: number }): string {
  return `${ESC}[38;2;${color.r};${color.g};${color.b}m`;
}

/**
 * Generate background ANSI code
 */
export function bg(color: { r: number; g: number; b: number }): string {
  return `${ESC}[48;2;${color.r};${color.g};${color.b}m`;
}

/**
 * Reset ANSI codes
 */
export const RESET = `${ESC}[0m`;

/**
 * Fill a screen region with the brand background
 * Call this to ensure no system theme can bleed through
 */
export function fillBackground(
  write: (s: string) => void,
  cols: number,
  rows: number,
  bgAnsi: string = BG_PRIMARY_ANSI
): void {
  for (let row = 1; row <= rows; row++) {
    write(`${ESC}[${row};1H${bgAnsi}${' '.repeat(cols)}`);
  }
}
