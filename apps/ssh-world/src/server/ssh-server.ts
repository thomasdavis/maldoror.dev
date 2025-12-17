import ssh2 from 'ssh2';
const { Server } = ssh2;
type Connection = ssh2.Connection;
type Session = ssh2.Session;
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { GameSession } from './game-session.js';
import { GameServer } from '../game/game-server.js';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';

interface SSHServerConfig {
  port: number;
  hostKeyPath: string;
  banner?: string;
  gameServer: GameServer;
  worldSeed: bigint;
}

interface ClientContext {
  fingerprint: string;
  username: string;
  remoteAddress: string;
  connectedAt: Date;
  userId?: string;
}

export class SSHServer {
  private server: InstanceType<typeof Server>;
  private sessions: Map<string, GameSession> = new Map();
  private config: SSHServerConfig;

  constructor(config: SSHServerConfig) {
    this.config = config;

    // Check for host key
    if (!existsSync(config.hostKeyPath)) {
      console.error(`Host key not found at ${config.hostKeyPath}`);
      console.error('Generate one with: ssh-keygen -t ed25519 -f keys/host.key -N ""');
      process.exit(1);
    }

    this.server = new Server(
      {
        hostKeys: [readFileSync(config.hostKeyPath)],
        banner: config.banner,
      },
      this.handleConnection.bind(this)
    );
  }

  start(): void {
    this.server.listen(this.config.port, '0.0.0.0', () => {
      console.log(`SSH server started on port ${this.config.port}`);
    });
  }

  stop(): void {
    this.server.close();
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }

  private handleConnection(client: Connection, info: { ip: string; port: number }): void {
    const context: Partial<ClientContext> = {
      remoteAddress: info.ip,
      connectedAt: new Date(),
    };

    console.log(`New connection from ${info.ip}`);

    client.on('authentication', async (ctx) => {
      if (ctx.method === 'publickey') {
        // Extract fingerprint
        const fingerprint = this.extractFingerprint(ctx.key);
        context.fingerprint = fingerprint;
        context.username = ctx.username;

        // Look up user by fingerprint
        const userKey = await db.query.userKeys.findFirst({
          where: eq(schema.userKeys.fingerprintSha256, fingerprint),
          with: { user: true },
        });

        if (userKey) {
          context.userId = userKey.userId;
          // Update last used
          await db
            .update(schema.userKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(schema.userKeys.id, userKey.id));
        }

        ctx.accept();
      } else if (ctx.method === 'none') {
        // Reject none auth - require public key
        ctx.reject(['publickey']);
      } else {
        ctx.reject(['publickey']);
      }
    });

    client.on('ready', () => {
      console.log(`Client authenticated: ${context.fingerprint?.slice(0, 16)}...`);

      client.on('session', (accept, _reject) => {
        const session = accept();
        this.handleSession(session, context as ClientContext, client);
      });
    });

    client.on('error', (err) => {
      console.error('Client error:', err.message);
    });

    client.on('end', () => {
      console.log(`Client disconnected: ${context.fingerprint?.slice(0, 16)}...`);
      if (context.fingerprint) {
        this.handleDisconnect(context.fingerprint);
      }
    });
  }

  private extractFingerprint(key: { algo: string; data: Buffer }): string {
    return createHash('sha256')
      .update(key.data)
      .digest('base64')
      .replace(/=+$/, '');
  }

  private handleSession(
    session: Session,
    context: ClientContext,
    _client: Connection
  ): void {
    let ptyInfo: { cols: number; rows: number } | null = null;

    session.on('pty', (accept, _reject, info) => {
      ptyInfo = { cols: info.cols, rows: info.rows };
      accept?.();
    });

    session.on('shell', async (accept, _reject) => {
      if (!ptyInfo) {
        // Default terminal size
        ptyInfo = { cols: 80, rows: 24 };
      }

      const stream = accept();

      // Create game session
      const gameSession = new GameSession({
        stream,
        fingerprint: context.fingerprint,
        username: context.username,
        userId: context.userId,
        cols: ptyInfo.cols,
        rows: ptyInfo.rows,
        gameServer: this.config.gameServer,
        worldSeed: this.config.worldSeed,
      });

      this.sessions.set(context.fingerprint, gameSession);
      await gameSession.start();
    });

    session.on('window-change', (accept, _reject, info) => {
      const gameSession = this.sessions.get(context.fingerprint);
      if (gameSession) {
        gameSession.resize(info.cols, info.rows);
      }
      accept?.();
    });
  }

  private async handleDisconnect(fingerprint: string): Promise<void> {
    const session = this.sessions.get(fingerprint);
    if (session) {
      await session.destroy();
      this.sessions.delete(fingerprint);
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
