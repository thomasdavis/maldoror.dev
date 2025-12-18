import type { Duplex } from 'stream';
import { ANSIBuilder, BG_PRIMARY, CRIMSON_BRIGHT, CRIMSON_MID, ACCENT_GREEN, ACCENT_RED, fg, bg } from '@maldoror/render';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';
import { USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH, USERNAME_PATTERN } from '@maldoror/protocol';

interface OnboardingResult {
  userId: string;
  username: string;
}

/**
 * Handles new user onboarding (username creation)
 */
export class OnboardingFlow {
  private stream: Duplex;
  private fingerprint: string;
  private ansi: ANSIBuilder;
  private inputBuffer: string = '';

  constructor(stream: Duplex, fingerprint: string) {
    this.stream = stream;
    this.fingerprint = fingerprint;
    this.ansi = new ANSIBuilder();
  }

  /**
   * Fill entire screen with brand dark background
   * IMPORTANT: Prevents any system theme from bleeding through
   */
  private fillBackground(): void {
    const bgAnsi = bg(BG_PRIMARY);
    for (let y = 0; y < 40; y++) {
      this.stream.write(`\x1b[${y + 1};1H${bgAnsi}${' '.repeat(100)}`);
    }
  }

  async run(): Promise<OnboardingResult | null> {
    // Enter alternate screen with brand dark background
    // IMPORTANT: Enforces Maldoror dark theme - no system override
    this.stream.write(
      this.ansi
        .enterAlternateScreen()
        .hideCursor()
        .setBackground({ type: 'rgb', value: [BG_PRIMARY.r, BG_PRIMARY.g, BG_PRIMARY.b] })
        .clearScreen()
        .build()
    );
    this.fillBackground();

    try {
      // Show welcome screen
      await this.showWelcome();

      // Get username
      const username = await this.getUsernameInput();
      if (!username) {
        return null;
      }

      // Create user
      const userId = await this.createUser(username);

      return { userId, username };
    } catch (error) {
      console.error('Onboarding error:', error);
      return null;
    }
  }

  private async showWelcome(): Promise<void> {
    // Use brand crimson colors for the logo
    const logoColor = fg(CRIMSON_BRIGHT);
    const borderColor = fg(CRIMSON_MID);
    const reset = '\x1b[0m';

    const lines = [
      '',
      `${borderColor}    ╔══════════════════════════════════════════════════════════╗${reset}`,
      `${borderColor}    ║${reset}                                                          ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}     ${logoColor}███╗   ███╗ █████╗ ██╗     ██████╗  ██████╗ ██████╗ ${reset} ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}     ${logoColor}████╗ ████║██╔══██╗██║     ██╔══██╗██╔═══██╗██╔══██╗${reset} ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}     ${logoColor}██╔████╔██║███████║██║     ██║  ██║██║   ██║██████╔╝${reset} ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}     ${logoColor}██║╚██╔╝██║██╔══██║██║     ██║  ██║██║   ██║██╔══██╗${reset} ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}     ${logoColor}██║ ╚═╝ ██║██║  ██║███████╗██████╔╝╚██████╔╝██║  ██║${reset} ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}     ${logoColor}╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝${reset} ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}                                                          ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}              Welcome to the Abyss, Wanderer              ${borderColor}║${reset}`,
      `${borderColor}    ║${reset}                                                          ${borderColor}║${reset}`,
      `${borderColor}    ╚══════════════════════════════════════════════════════════╝${reset}`,
      '',
      '',
      '    Your SSH key is not recognized. You appear to be new here.',
      '',
    ];

    // Write with brand background
    const bgAnsi = bg(BG_PRIMARY);
    for (let i = 0; i < lines.length; i++) {
      this.stream.write(`\x1b[${i + 1};1H${bgAnsi}${lines[i] || ''}`);
    }

    this.stream.write(this.ansi.resetAttributes().build());
  }

  private async getUsernameInput(): Promise<string | null> {
    const promptY = 18;

    while (true) {
      // Show prompt with brand colors
      this.stream.write(
        this.ansi
          .moveTo(4, promptY)
          .setForeground({ type: 'rgb', value: [ACCENT_GREEN.r, ACCENT_GREEN.g, ACCENT_GREEN.b] })
          .write('Choose a name: ')
          .setForeground({ type: 'rgb', value: [255, 255, 255] })
          .showCursor()
          .build()
      );

      // Clear previous input
      this.inputBuffer = '';
      this.stream.write(
        this.ansi
          .moveTo(19, promptY)
          .write(' '.repeat(30))
          .moveTo(19, promptY)
          .build()
      );

      // Read input
      const input = await this.readLine();

      if (input === null) {
        // User pressed Ctrl+C or similar
        return null;
      }

      // Validate
      const validation = this.validateUsername(input);
      if (!validation.valid) {
        // Show error with brand colors
        this.stream.write(
          this.ansi
            .moveTo(4, promptY + 2)
            .setForeground({ type: 'rgb', value: [ACCENT_RED.r, ACCENT_RED.g, ACCENT_RED.b] })
            .write(' '.repeat(60))
            .moveTo(4, promptY + 2)
            .write(`Error: ${validation.error}`)
            .resetAttributes()
            .build()
        );
        continue;
      }

      // Check uniqueness
      const existing = await db.query.users.findFirst({
        where: eq(schema.users.username, input.toLowerCase()),
      });

      if (existing) {
        this.stream.write(
          this.ansi
            .moveTo(4, promptY + 2)
            .setForeground({ type: 'rgb', value: [ACCENT_RED.r, ACCENT_RED.g, ACCENT_RED.b] })
            .write(' '.repeat(60))
            .moveTo(4, promptY + 2)
            .write('Error: That name is already taken.')
            .resetAttributes()
            .build()
        );
        continue;
      }

      // Clear error and return
      this.stream.write(
        this.ansi
          .moveTo(4, promptY + 2)
          .write(' '.repeat(60))
          .hideCursor()
          .build()
      );

      return input.toLowerCase();
    }
  }

  private validateUsername(username: string): { valid: boolean; error?: string } {
    if (username.length < USERNAME_MIN_LENGTH) {
      return { valid: false, error: `Name must be at least ${USERNAME_MIN_LENGTH} characters.` };
    }
    if (username.length > USERNAME_MAX_LENGTH) {
      return { valid: false, error: `Name must be at most ${USERNAME_MAX_LENGTH} characters.` };
    }
    if (!USERNAME_PATTERN.test(username)) {
      return { valid: false, error: 'Name can only contain lowercase letters, numbers, and underscores.' };
    }
    return { valid: true };
  }

  private readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      const onData = (data: Buffer) => {
        for (const byte of data) {
          if (byte === 0x03 || byte === 0x04) {
            // Ctrl+C or Ctrl+D
            this.stream.removeListener('data', onData);
            resolve(null);
            return;
          }

          if (byte === 0x0d || byte === 0x0a) {
            // Enter
            this.stream.removeListener('data', onData);
            resolve(this.inputBuffer);
            return;
          }

          if (byte === 0x7f || byte === 0x08) {
            // Backspace
            if (this.inputBuffer.length > 0) {
              this.inputBuffer = this.inputBuffer.slice(0, -1);
              this.stream.write('\b \b');
            }
            continue;
          }

          if (byte === 0x1b) {
            // ESC - could be escape sequence, skip for now
            continue;
          }

          if (byte >= 0x20 && byte < 0x7f) {
            // Printable character
            if (this.inputBuffer.length < USERNAME_MAX_LENGTH + 5) {
              const char = String.fromCharCode(byte);
              this.inputBuffer += char;
              this.stream.write(char);
            }
          }
        }
      };

      this.stream.on('data', onData);
    });
  }

  private async createUser(username: string): Promise<string> {
    // Create user
    const [user] = await db
      .insert(schema.users)
      .values({ username })
      .returning();

    // Create user key
    await db.insert(schema.userKeys).values({
      userId: user!.id,
      fingerprintSha256: this.fingerprint,
      publicKey: '', // We don't have the full key, just fingerprint
    });

    // Create initial avatar record
    await db.insert(schema.avatars).values({
      userId: user!.id,
      prompt: 'A mysterious wanderer', // Default prompt
      generationStatus: 'pending',
    });

    return user!.id;
  }
}
