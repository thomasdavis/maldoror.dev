import ssh2 from 'ssh2';
const { Server } = ssh2;
type Connection = ssh2.Connection;
type Session = ssh2.Session;
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { SessionProxy } from './session-proxy.js';
import { WorkerManager } from './worker-manager.js';
import { db, schema } from '@maldoror/db';
import { eq } from 'drizzle-orm';
import type { SessionRestoredState } from './worker-manager.js';

export interface AcceptanceSSHSession {
  userId: string;
  username: string;
  restoredState: SessionRestoredState;
}

export interface SSHServerConfig {
  port: number;
  host?: string;
  hostKeyPath: string;
  banner?: string;
  workerManager: WorkerManager;
  /** `required` removes the uncompressed SSH transport from negotiation. The
   * delayed OpenSSH zlib variant starts only after authentication. */
  compression?: 'optional' | 'required';
  /**
   * Explicit acceptance-fixture lane. It is intentionally constructor-only,
   * has no production environment switch, and is rejected unless the server
   * binds to loopback. Unlisted keys never reach onboarding.
   */
  acceptance?: {
    resolveSession(fingerprint: string): AcceptanceSSHSession | null;
  };
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
  private sessions: Map<string, SessionProxy> = new Map();
  private config: SSHServerConfig;

  constructor(config: SSHServerConfig) {
    this.config = config;

    if (config.acceptance && !isLoopbackHost(config.host ?? '0.0.0.0')) {
      throw new Error('Acceptance SSH sessions require an explicit loopback bind');
    }

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
        algorithms: config.compression === 'required'
          ? { compress: ['zlib@openssh.com'] }
          : undefined,
      },
      this.handleConnection.bind(this)
    );
  }

  start(): Promise<void> {
    const host = this.config.host ?? '0.0.0.0';
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.config.port, host, () => {
        this.server.off('error', onError);
        console.log(`SSH server started on ${host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop accepting new connections but keep existing sessions alive
   */
  stopAccepting(): void {
    this.server.close();
    console.log('SSH server stopped accepting new connections');
  }

  /**
   * Force stop all sessions and clean up
   */
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
    let didAttemptAuth = false;
    const connectionSessionIds = new Set<string>();
    let connectionClosed = false;

    const closeConnectionSessions = () => {
      if (connectionClosed) return;
      connectionClosed = true;

      for (const sessionId of connectionSessionIds) {
        void this.handleDisconnect(sessionId);
      }
      connectionSessionIds.clear();
    };

    // Don't log connection here - wait to see if it's a real auth attempt
    // (HAProxy health checks connect and immediately disconnect)

    client.on('authentication', async (ctx) => {
      didAttemptAuth = true;

      if (ctx.method === 'publickey') {
        // Default: extract fingerprint directly from the SSH key
        let fingerprint = this.extractFingerprint(ctx.key);
        let isProxied = false;

        if (this.config.acceptance) {
          const fixture = this.config.acceptance.resolveSession(fingerprint);
          if (!fixture) {
            ctx.reject(['publickey']);
            return;
          }
          context.fingerprint = fingerprint;
          context.userId = fixture.userId;
          context.username = fixture.username;
        } else {
          // Look up user by direct key fingerprint first
          let userKey = await db.query.userKeys.findFirst({
            where: eq(schema.userKeys.fingerprintSha256, fingerprint),
            with: { user: true },
          });

          // Fallback: check if fingerprint is passed via username from sshpiper proxy
          // Format: "fp:FINGERPRINT.originaluser" where FINGERPRINT is base64 SHA256
          if (!userKey) {
            const proxyMatch = ctx.username.match(/^fp:([A-Za-z0-9_+/=]+)\./);
            if (proxyMatch && proxyMatch[1]) {
              // Proxied connection - fingerprint is in username
              // Convert from base64 to SHA256:base64 format to match our storage
              fingerprint = `SHA256:${proxyMatch[1].replace(/_/g, '/')}`;
              isProxied = true;

              // Look up user by proxied fingerprint
              userKey = await db.query.userKeys.findFirst({
                where: eq(schema.userKeys.fingerprintSha256, fingerprint),
                with: { user: true },
              });
            }
          }

          if (isProxied) {
            console.log(`Proxied auth from ${info.ip} (fingerprint in username: ${fingerprint.slice(0, 20)}...)`);
          } else {
            console.log(`Direct auth from ${info.ip} (key: ${fingerprint.slice(0, 16)}...)`);
          }

          context.fingerprint = fingerprint;
          // Don't use ctx.username - that's the computer's username (or proxy format)
          // Username will be set from database for returning users, or onboarding for new users
          context.username = '';

          if (userKey && userKey.user) {
            context.userId = userKey.userId;
            // Get the actual username from the database
            context.username = userKey.user.username;
            // Update last used
            await db
              .update(schema.userKeys)
              .set({ lastUsedAt: new Date() })
              .where(eq(schema.userKeys.id, userKey.id));
          }
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
        this.handleSession(session, context as ClientContext, connectionSessionIds);
      });
    });

    client.on('error', (err) => {
      // Ignore ECONNRESET from HAProxy health checks (they connect and immediately close)
      if (err.message === 'read ECONNRESET' && !didAttemptAuth) {
        return; // Silently ignore health check disconnects
      }
      // Only log real errors from authenticated clients
      if (didAttemptAuth) {
        console.error('Client error:', err.message);
      }
      closeConnectionSessions();
    });

    client.on('end', () => {
      // Only log disconnects for clients that actually tried to auth
      // (Silently ignore HAProxy health check disconnects)
      if (didAttemptAuth && context.fingerprint) {
        console.log(`Client disconnected: ${context.fingerprint.slice(0, 16)}...`);
      }
      closeConnectionSessions();
    });

    // Abrupt network loss can emit `close` without a preceding `end`.
    // Keep cleanup idempotent because ssh2 may emit both events.
    client.on('close', closeConnectionSessions);
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
    connectionSessionIds: Set<string>
  ): void {
    let ptyInfo: { cols: number; rows: number; term?: string } | null = null;
    let sessionProxy: SessionProxy | null = null;

    session.on('pty', (accept, _reject, info) => {
      // info.term = the client's TERM (e.g. xterm-ghostty, xterm-kitty) —
      // used to auto-select the octant render mode on capable terminals.
      ptyInfo = { cols: info.cols, rows: info.rows, term: (info as { term?: string }).term };
      accept?.();
    });

    session.on('shell', async (accept, _reject) => {
      if (!ptyInfo) {
        // Default terminal size
        ptyInfo = { cols: 80, rows: 24 };
      }

      const stream = accept();
      const acceptanceSession = this.config.acceptance?.resolveSession(context.fingerprint);

      // The key was already checked during authentication. Refuse a session if
      // a mutable test manifest changed between auth and shell creation.
      if (this.config.acceptance && !acceptanceSession) {
        stream.end();
        return;
      }

      // Create session proxy (thin layer - game logic runs in worker)
      const proxy = new SessionProxy({
        stream,
        fingerprint: context.fingerprint,
        username: context.username,
        userId: context.userId || null,
        cols: ptyInfo.cols,
        rows: ptyInfo.rows,
        term: ptyInfo.term,
        workerManager: this.config.workerManager,
        restoredState: acceptanceSession?.restoredState,
      });
      sessionProxy = proxy;

      const sessionId = proxy.getSessionId();
      this.sessions.set(sessionId, proxy);
      connectionSessionIds.add(sessionId);

      // Set up input forwarding
      stream.on('data', (data: Buffer) => {
        proxy.handleInput(data);
      });

      stream.on('close', () => {
        connectionSessionIds.delete(sessionId);
        void this.handleDisconnect(sessionId);
      });

      stream.on('end', () => {
        connectionSessionIds.delete(sessionId);
        void this.handleDisconnect(sessionId);
      });

      stream.on('error', () => {
        connectionSessionIds.delete(sessionId);
        void this.handleDisconnect(sessionId);
      });

      try {
        await proxy.start();
      } catch (error) {
        connectionSessionIds.delete(sessionId);
        await this.handleDisconnect(sessionId);
        console.error('Failed to start SSH game session:', error);
        stream.end();
      }
    });

    session.on('window-change', (accept, _reject, info) => {
      if (sessionProxy) {
        sessionProxy.resize(info.cols, info.rows);
      }
      accept?.();
    });
  }

  private async handleDisconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.destroy();
      this.sessions.delete(sessionId);
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get transport metrics from all active sessions
   * Used by stats server to report backpressure stats
   *
   * SessionProxy owns the latency-bounded writer in the main process, so its
   * counters are authoritative for bytes accepted by the SSH stream.
   */
  getTransportMetrics(): Array<{
    queuedBytes: number;
    droppedFrames: number;
    drainCount: number;
    totalBytesWritten: number;
    peakQueuedBytes: number;
    totalFramesWritten: number;
    keyframesAccepted: number;
    recoveryKeyframesAccepted: number;
    recoveryRequests: number;
  }> {
    return Array.from(this.sessions.values(), (session) => {
      const metrics = session.getTransportMetrics();
      return {
        queuedBytes: metrics.queuedBytes,
        droppedFrames: metrics.droppedFrames,
        drainCount: metrics.drainCount,
        totalBytesWritten: metrics.totalBytesWritten,
        peakQueuedBytes: metrics.peakQueuedBytes,
        totalFramesWritten: metrics.totalFramesWritten,
        keyframesAccepted: metrics.keyframesAccepted,
        recoveryKeyframesAccepted: metrics.recoveryKeyframesAccepted,
        recoveryRequests: metrics.recoveryRequests,
      };
    });
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
