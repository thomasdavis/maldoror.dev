import type { Duplex } from 'stream';
import { ANSIBuilder } from '@maldoror/render';
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

  async run(): Promise<OnboardingResult | null> {
    // Enter alternate screen
    this.stream.write(
      this.ansi
        .enterAlternateScreen()
        .hideCursor()
        .clearScreen()
        .build()
    );

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
    const lines = [
      '',
      '    ╔══════════════════════════════════════════════════════════╗',
      '    ║                                                          ║',
      '    ║     ███╗   ███╗ █████╗ ██╗     ██████╗  ██████╗ ██████╗  ║',
      '    ║     ████╗ ████║██╔══██╗██║     ██╔══██╗██╔═══██╗██╔══██╗ ║',
      '    ║     ██╔████╔██║███████║██║     ██║  ██║██║   ██║██████╔╝ ║',
      '    ║     ██║╚██╔╝██║██╔══██║██║     ██║  ██║██║   ██║██╔══██╗ ║',
      '    ║     ██║ ╚═╝ ██║██║  ██║███████╗██████╔╝╚██████╔╝██║  ██║ ║',
      '    ║     ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ║',
      '    ║                                                          ║',
      '    ║              Welcome to the Abyss, Wanderer              ║',
      '    ║                                                          ║',
      '    ╚══════════════════════════════════════════════════════════╝',
      '',
      '',
      '    Your SSH key is not recognized. You appear to be new here.',
      '',
    ];

    this.stream.write(
      this.ansi
        .moveTo(0, 0)
        .setForeground({ type: 'rgb', value: [180, 100, 255] })
        .build()
    );

    for (let i = 0; i < lines.length; i++) {
      this.stream.write(
        this.ansi
          .moveTo(0, i)
          .write(lines[i] || '')
          .build()
      );
    }

    this.stream.write(this.ansi.resetAttributes().build());
  }

  private async getUsernameInput(): Promise<string | null> {
    const promptY = 18;

    while (true) {
      // Show prompt
      this.stream.write(
        this.ansi
          .moveTo(4, promptY)
          .setForeground({ type: 'rgb', value: [100, 255, 100] })
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
        // Show error
        this.stream.write(
          this.ansi
            .moveTo(4, promptY + 2)
            .setForeground({ type: 'rgb', value: [255, 100, 100] })
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
            .setForeground({ type: 'rgb', value: [255, 100, 100] })
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
