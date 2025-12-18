import { BG_MODAL, BORDER_VISIBLE, ACCENT_GOLD, TEXT_PRIMARY, ACCENT_GREEN, ACCENT_CYAN, TEXT_SECONDARY, BORDER_ACCENT } from '@maldoror/render';

/**
 * UIOverlayManager - Handles generation of modal overlays for the game UI
 * Extracted from GameSession to reduce file size and improve maintainability
 *
 * IMPORTANT: All overlays use Maldoror brand dark colors - no system override
 */

interface PlayerInfo {
  userId: string;
  username: string;
  x: number;
  y: number;
  isOnline?: boolean;
}

export class UIOverlayManager {
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Update terminal dimensions when resize occurs
   */
  updateDimensions(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Generate the player list overlay (Tab menu) as a string
   */
  generatePlayerListOverlay(players: PlayerInfo[], currentUserId: string | null): string {
    const ESC = '\x1b';

    // Calculate overlay dimensions
    const overlayWidth = 50;
    const overlayHeight = Math.min(players.length + 4, 20);
    const startX = Math.floor((this.cols - overlayWidth) / 2);
    const startY = Math.floor((this.rows - overlayHeight) / 2);

    // Brand dark colors - Maldoror theme, no system override
    const bgColor = `${ESC}[48;2;${BG_MODAL.r};${BG_MODAL.g};${BG_MODAL.b}m`;
    const borderColor = `${ESC}[38;2;${BORDER_VISIBLE.r};${BORDER_VISIBLE.g};${BORDER_VISIBLE.b}m`;
    const headerColor = `${ESC}[38;2;${ACCENT_GOLD.r};${ACCENT_GOLD.g};${ACCENT_GOLD.b}m`;
    const textColor = `${ESC}[38;2;${TEXT_PRIMARY.r};${TEXT_PRIMARY.g};${TEXT_PRIMARY.b}m`;
    const selfColor = `${ESC}[38;2;${ACCENT_GREEN.r};${ACCENT_GREEN.g};${ACCENT_GREEN.b}m`;
    const reset = `${ESC}[0m`;

    let output = '';

    // Draw overlay box
    // Top border
    output += `${ESC}[${startY};${startX}H${bgColor}${borderColor}╔${'═'.repeat(overlayWidth - 2)}╗`;

    // Title row
    const title = ` PLAYERS ONLINE (${players.length}) `;
    const titlePad = Math.floor((overlayWidth - 2 - title.length) / 2);
    output += `${ESC}[${startY + 1};${startX}H${bgColor}${borderColor}║${' '.repeat(titlePad)}${headerColor}${title}${borderColor}${' '.repeat(overlayWidth - 2 - titlePad - title.length)}║`;

    // Separator
    output += `${ESC}[${startY + 2};${startX}H${bgColor}${borderColor}╟${'─'.repeat(overlayWidth - 2)}╢`;

    // Column headers
    const nameHeader = 'Name';
    const posHeader = 'Position';
    const pingHeader = 'Ping';
    output += `${ESC}[${startY + 3};${startX}H${bgColor}${borderColor}║ ${headerColor}${nameHeader.padEnd(20)}${posHeader.padEnd(18)}${pingHeader.padEnd(8)}${borderColor}║`;

    // Player rows
    const maxPlayers = Math.min(players.length, overlayHeight - 5);
    for (let i = 0; i < maxPlayers; i++) {
      const player = players[i]!;
      const isSelf = player.userId === currentUserId;
      const color = isSelf ? selfColor : textColor;
      const name = (isSelf ? '► ' : '  ') + player.username.slice(0, 16).padEnd(18);
      const pos = `(${player.x}, ${player.y})`.padEnd(18);
      const ping = '--ms'.padEnd(8);  // TODO: actual ping

      output += `${ESC}[${startY + 4 + i};${startX}H${bgColor}${borderColor}║${color}${name}${pos}${ping}${borderColor}║`;
    }

    // Fill remaining rows
    for (let i = maxPlayers; i < overlayHeight - 5; i++) {
      output += `${ESC}[${startY + 4 + i};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;
    }

    // Bottom border
    output += `${ESC}[${startY + overlayHeight - 1};${startX}H${bgColor}${borderColor}╚${'═'.repeat(overlayWidth - 2)}╝`;

    // Footer hint
    const hint = ' Press TAB to close ';
    output += `${ESC}[${startY + overlayHeight};${startX + Math.floor((overlayWidth - hint.length) / 2)}H${textColor}${hint}`;

    output += reset;

    return output;
  }

  /**
   * Generate the reload/reconnecting overlay
   */
  generateReloadOverlay(): string {
    const ESC = '\x1b';

    // Calculate overlay dimensions
    const overlayWidth = 40;
    const overlayHeight = 7;
    const startX = Math.floor((this.cols - overlayWidth) / 2);
    const startY = Math.floor((this.rows - overlayHeight) / 2);

    // Brand dark colors - Maldoror theme, no system override
    const bgColor = `${ESC}[48;2;${BG_MODAL.r};${BG_MODAL.g};${BG_MODAL.b}m`;
    const borderColor = `${ESC}[38;2;${BORDER_VISIBLE.r};${BORDER_VISIBLE.g};${BORDER_VISIBLE.b}m`;
    const textColor = `${ESC}[38;2;${ACCENT_GOLD.r};${ACCENT_GOLD.g};${ACCENT_GOLD.b}m`;
    const subTextColor = `${ESC}[38;2;${TEXT_SECONDARY.r};${TEXT_SECONDARY.g};${TEXT_SECONDARY.b}m`;
    const reset = `${ESC}[0m`;

    // Spinner frames
    const spinnerFrames = ['◐', '◓', '◑', '◒'];
    const spinnerFrame = spinnerFrames[Math.floor(Date.now() / 200) % spinnerFrames.length];

    let output = '';

    // Top border
    output += `${ESC}[${startY};${startX}H${bgColor}${borderColor}╔${'═'.repeat(overlayWidth - 2)}╗`;

    // Empty row
    output += `${ESC}[${startY + 1};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Main message with spinner
    const message = ` ${spinnerFrame} Updating Server... `;
    const msgPad = Math.floor((overlayWidth - 2 - message.length) / 2);
    output += `${ESC}[${startY + 2};${startX}H${bgColor}${borderColor}║${' '.repeat(msgPad)}${textColor}${message}${' '.repeat(overlayWidth - 2 - msgPad - message.length)}${borderColor}║`;

    // Empty row
    output += `${ESC}[${startY + 3};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Sub message
    const subMessage = 'Please wait...';
    const subPad = Math.floor((overlayWidth - 2 - subMessage.length) / 2);
    output += `${ESC}[${startY + 4};${startX}H${bgColor}${borderColor}║${' '.repeat(subPad)}${subTextColor}${subMessage}${' '.repeat(overlayWidth - 2 - subPad - subMessage.length)}${borderColor}║`;

    // Empty row
    output += `${ESC}[${startY + 5};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Bottom border
    output += `${ESC}[${startY + 6};${startX}H${bgColor}${borderColor}╚${'═'.repeat(overlayWidth - 2)}╝`;

    output += reset;

    return output;
  }

  /**
   * Generate the help modal overlay
   */
  generateHelpModalOverlay(): string {
    const ESC = '\x1b';

    // Help content
    const commands = [
      { key: '← ↑ → ↓ / WASD', desc: 'Move your character' },
      { key: '+ / -', desc: 'Zoom in / out' },
      { key: '[ / ]', desc: 'Rotate camera' },
      { key: 'V', desc: 'Cycle render mode (halfblock/braille/text)' },
      { key: 'C', desc: 'Toggle camera mode (follow/free)' },
      { key: 'H / Home', desc: 'Snap camera to player' },
      { key: 'Shift + Arrows', desc: 'Pan camera (in free mode)' },
      { key: 'Tab', desc: 'Show player list' },
      { key: 'R', desc: 'Edit your avatar' },
      { key: 'B', desc: 'Place a building' },
      { key: 'Q', desc: 'Quit game' },
      { key: '?', desc: 'Show this help' },
    ];

    // Calculate overlay dimensions
    const overlayWidth = 56;
    const overlayHeight = commands.length + 6;
    const startX = Math.floor((this.cols - overlayWidth) / 2);
    const startY = Math.floor((this.rows - overlayHeight) / 2);

    // Brand dark colors - Maldoror theme, no system override
    const bgColor = `${ESC}[48;2;${BG_MODAL.r};${BG_MODAL.g};${BG_MODAL.b}m`;
    const borderColor = `${ESC}[38;2;${BORDER_ACCENT.r};${BORDER_ACCENT.g};${BORDER_ACCENT.b}m`;
    const headerColor = `${ESC}[38;2;${ACCENT_GOLD.r};${ACCENT_GOLD.g};${ACCENT_GOLD.b}m`;
    const keyColor = `${ESC}[38;2;${ACCENT_CYAN.r};${ACCENT_CYAN.g};${ACCENT_CYAN.b}m`;
    const descColor = `${ESC}[38;2;${TEXT_PRIMARY.r};${TEXT_PRIMARY.g};${TEXT_PRIMARY.b}m`;
    const hintColor = `${ESC}[38;2;${TEXT_SECONDARY.r};${TEXT_SECONDARY.g};${TEXT_SECONDARY.b}m`;
    const reset = `${ESC}[0m`;

    let output = '';

    // Top border
    output += `${ESC}[${startY};${startX}H${bgColor}${borderColor}╔${'═'.repeat(overlayWidth - 2)}╗`;

    // Title row
    const title = ' ⌨ KEYBOARD CONTROLS ';
    const titlePad = Math.floor((overlayWidth - 2 - title.length) / 2);
    output += `${ESC}[${startY + 1};${startX}H${bgColor}${borderColor}║${' '.repeat(titlePad)}${headerColor}${title}${borderColor}${' '.repeat(overlayWidth - 2 - titlePad - title.length)}║`;

    // Separator
    output += `${ESC}[${startY + 2};${startX}H${bgColor}${borderColor}╟${'─'.repeat(overlayWidth - 2)}╢`;

    // Empty row
    output += `${ESC}[${startY + 3};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Command rows
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const keyPadded = cmd.key.padEnd(18);
      const descPadded = cmd.desc.padEnd(32);
      output += `${ESC}[${startY + 4 + i};${startX}H${bgColor}${borderColor}║ ${keyColor}${keyPadded}${descColor}${descPadded} ${borderColor}║`;
    }

    // Empty row
    output += `${ESC}[${startY + 4 + commands.length};${startX}H${bgColor}${borderColor}║${' '.repeat(overlayWidth - 2)}║`;

    // Bottom border
    output += `${ESC}[${startY + 5 + commands.length};${startX}H${bgColor}${borderColor}╚${'═'.repeat(overlayWidth - 2)}╝`;

    // Footer hint
    const hint = ' Press ESC to close ';
    output += `${ESC}[${startY + 6 + commands.length};${startX + Math.floor((overlayWidth - hint.length) / 2)}H${hintColor}${hint}`;

    output += reset;

    return output;
  }
}
