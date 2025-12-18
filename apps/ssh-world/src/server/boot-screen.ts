import type { Duplex } from 'stream';

const ESC = '\x1b';

interface OnlinePlayer {
  username: string;
}

/**
 * Boot screen that shows loading progress during connection
 */
export class BootScreen {
  private stream: Duplex;
  private cols: number;
  private currentStep: number = 0;
  private spinnerFrame: number = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(stream: Duplex, cols: number, _rows: number) {
    this.stream = stream;
    this.cols = cols;
  }

  // Maldoror brand colors - ALWAYS dark background, no system override
  private static readonly BG_ANSI = `${ESC}[48;2;15;12;18m`;  // Near-black with purple tint

  /**
   * Show the initial boot screen
   */
  show(): void {
    // Enter alternate screen, hide cursor
    this.stream.write(`${ESC}[?1049h${ESC}[?25l`);
    // FORCE dark background on entire screen - no system theme can override
    this.stream.write(`${BootScreen.BG_ANSI}${ESC}[2J`);
    this.fillBackground();
    this.renderLogo();
    this.renderProgressArea();
  }

  /**
   * Fill entire screen with brand dark background
   */
  private fillBackground(): void {
    // Fill every cell with our dark background to prevent any light bleed
    for (let row = 1; row <= 50; row++) {
      this.stream.write(`${ESC}[${row};1H${BootScreen.BG_ANSI}${' '.repeat(this.cols)}`);
    }
  }

  private renderLogo(): void {
    const color = (r: number, g: number, b: number) => `${ESC}[38;2;${r};${g};${b}m`;
    const reset = `${ESC}[0m`;

    const logo = [
      '███╗   ███╗ █████╗ ██╗     ██████╗  ██████╗ ██████╗  ██████╗ ██████╗ ',
      '████╗ ████║██╔══██╗██║     ██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗██╔══██╗',
      '██╔████╔██║███████║██║     ██║  ██║██║   ██║██████╔╝██║   ██║██████╔╝',
      '██║╚██╔╝██║██╔══██║██║     ██║  ██║██║   ██║██╔══██╗██║   ██║██╔══██╗',
      '██║ ╚═╝ ██║██║  ██║███████╗██████╔╝╚██████╔╝██║  ██║╚██████╔╝██║  ██║',
      '╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝',
    ];

    const logoWidth = logo[0]!.length;
    const startX = Math.max(1, Math.floor((this.cols - logoWidth) / 2));
    const startY = 3;

    // Broody color gradient - visible crimson to deep burgundy (high contrast on dark bg)
    const colors = [
      [180, 60, 90],   // Bright crimson (top - most visible)
      [160, 50, 80],   // Rose crimson
      [140, 45, 70],   // Deep rose
      [120, 40, 65],   // Wine
      [100, 35, 55],   // Burgundy
      [85, 30, 50],    // Dark plum (bottom - still visible)
    ];

    for (let i = 0; i < logo.length; i++) {
      const [r, g, b] = colors[i]!;
      this.stream.write(`${ESC}[${startY + i};${startX}H${color(r!, g!, b!)}${logo[i]}${reset}`);
    }

    // Subtitle in visible muted purple-gray
    const subtitle = 'T E R M I N A L   M M O';
    const subX = Math.floor((this.cols - subtitle.length) / 2);
    this.stream.write(`${ESC}[${startY + 8};${subX}H${color(120, 100, 115)}${subtitle}${reset}`);
  }

  private renderProgressArea(): void {
    const boxWidth = 50;
    const boxHeight = 8;
    const startX = Math.floor((this.cols - boxWidth) / 2);
    const startY = 14;

    // Visible broody border color (not too dim)
    const border = `${ESC}[38;2;80;60;70m`;
    const reset = `${ESC}[0m`;

    // Box with explicit background
    this.stream.write(`${ESC}[${startY};${startX}H${border}┌${'─'.repeat(boxWidth - 2)}┐${reset}`);
    for (let i = 1; i < boxHeight - 1; i++) {
      this.stream.write(`${ESC}[${startY + i};${startX}H${border}│${BootScreen.BG_ANSI}${' '.repeat(boxWidth - 2)}${reset}${border}│${reset}`);
    }
    this.stream.write(`${ESC}[${startY + boxHeight - 1};${startX}H${border}└${'─'.repeat(boxWidth - 2)}┘${reset}`);
  }

  /**
   * Update loading step with progress message
   */
  updateStep(message: string, status: 'loading' | 'done' | 'error' = 'loading'): void {
    this.currentStep++;
    const y = 15 + this.currentStep;
    const x = Math.floor((this.cols - 46) / 2) + 2;

    // Broody status colors with good contrast
    const statusIcon = status === 'done' ? `${ESC}[38;2;120;180;120m✓${ESC}[0m`     // Visible muted green
                     : status === 'error' ? `${ESC}[38;2;180;80;80m✗${ESC}[0m`      // Visible dark red
                     : `${ESC}[38;2;180;140;100m◦${ESC}[0m`;                         // Visible amber

    const textColor = status === 'done' ? `${ESC}[38;2;100;95;100m`                 // Completed gray
                    : status === 'error' ? `${ESC}[38;2;180;80;80m`                  // Error red
                    : `${ESC}[38;2;160;150;155m`;                                    // Active text

    const text = message.padEnd(40);
    this.stream.write(`${ESC}[${y};${x}H  ${statusIcon} ${textColor}${text}${ESC}[0m`);
  }

  /**
   * Mark the previous step as done
   */
  markPreviousDone(): void {
    if (this.currentStep > 0) {
      const y = 15 + this.currentStep;
      const x = Math.floor((this.cols - 46) / 2) + 2;
      // Muted green checkmark
      this.stream.write(`${ESC}[${y};${x}H  ${ESC}[38;2;100;140;100m✓${ESC}[0m`);
    }
  }

  /**
   * Render the honourable mentions footer with online players
   */
  renderHonourableMentions(players: OnlinePlayer[]): void {
    const startY = 24;
    const color = (r: number, g: number, b: number) => `${ESC}[38;2;${r};${g};${b}m`;
    const reset = `${ESC}[0m`;

    // Header with visible broody color
    const header = '─── Honourable Mentions ───';
    const headerX = Math.floor((this.cols - header.length) / 2);
    this.stream.write(`${ESC}[${startY};${headerX}H${color(100, 80, 90)}${header}${reset}`);

    if (players.length === 0) {
      const empty = 'No wanderers currently in the abyss';
      const emptyX = Math.floor((this.cols - empty.length) / 2);
      this.stream.write(`${ESC}[${startY + 2};${emptyX}H${color(90, 75, 85)}${empty}${reset}`);
    } else {
      // Show online players with visible text
      const names = players.map(p => p.username).join('  ·  ');
      const truncated = names.length > this.cols - 10 ? names.slice(0, this.cols - 13) + '...' : names;
      const namesX = Math.floor((this.cols - truncated.length) / 2);
      this.stream.write(`${ESC}[${startY + 2};${namesX}H${color(140, 110, 125)}${truncated}${reset}`);
    }
  }

  /**
   * Start the spinner animation for current step
   */
  startSpinner(): void {
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % spinnerChars.length;
      const y = 15 + this.currentStep;
      const x = Math.floor((this.cols - 46) / 2) + 4;
      // Visible amber spinner
      this.stream.write(`${ESC}[${y};${x}H${ESC}[38;2;200;160;100m${spinnerChars[this.spinnerFrame]}${ESC}[0m`);
    }, 80);
  }

  /**
   * Stop the spinner
   */
  stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  /**
   * Hide the boot screen and transition to game
   */
  hide(): void {
    this.stopSpinner();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopSpinner();
  }
}
