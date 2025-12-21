/**
 * SessionProxy - Thin SSH connection handler in main process
 *
 * The actual game logic runs in the worker process. This proxy:
 * 1. Receives SSH input and forwards to worker
 * 2. Receives render output from worker and writes to SSH stream
 * 3. Handles the "Updating..." screen during hot-reload
 * 4. Survives worker restarts without disconnecting the user
 */

import type { Duplex } from 'stream';
import type { WorkerManager, ReloadState } from './worker-manager.js';
import { resourceMonitor } from '../utils/resource-monitor.js';

const ESC = '\x1b';

// Dark purple background for update screen
const UPDATE_BG = `${ESC}[48;2;25;20;35m`;
const UPDATE_FG = `${ESC}[38;2;180;140;255m`;
const RESET = `${ESC}[0m`;

export interface SessionProxyConfig {
  stream: Duplex;
  fingerprint: string;
  username: string;
  userId: string | null;
  cols: number;
  rows: number;
  workerManager: WorkerManager;
}

export interface SessionState {
  sessionId: string;
  fingerprint: string;
  username: string;
  userId: string;
  cols: number;
  rows: number;
  playerX: number;
  playerY: number;
  playerDirection: string;
  zoomLevel: number;
  renderMode: string;
}

export class SessionProxy {
  private stream: Duplex;
  private fingerprint: string;
  private username: string;
  private userId: string | null;
  private cols: number;
  private rows: number;
  private workerManager: WorkerManager;
  private sessionId: string;
  private destroyed: boolean = false;
  private isUpdating: boolean = false;
  private updateAnimationFrame: number = 0;
  private updateAnimationInterval: NodeJS.Timeout | null = null;
  private unsubscribeReload: (() => void) | null = null;

  constructor(config: SessionProxyConfig) {
    this.stream = config.stream;
    this.fingerprint = config.fingerprint;
    this.username = config.username;
    this.userId = config.userId;
    this.cols = config.cols;
    this.rows = config.rows;
    this.workerManager = config.workerManager;
    this.sessionId = crypto.randomUUID();
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get user ID
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Set user ID (after onboarding completes in worker)
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * Handle terminal resize
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;

    if (!this.destroyed) {
      this.workerManager.sendSessionResize(this.sessionId, cols, rows);
    }
  }

  /**
   * Forward input data to worker
   */
  handleInput(data: Buffer): void {
    if (this.destroyed || this.isUpdating) return;

    this.workerManager.sendSessionInput(this.sessionId, data);
  }

  /**
   * Receive render output from worker and write to SSH stream
   */
  handleOutput(output: string): void {
    if (this.destroyed || this.isUpdating) return;

    try {
      this.stream.write(output);
    } catch (err) {
      console.error(`[SessionProxy] Write error for ${this.sessionId}:`, err);
    }
  }

  /**
   * Show the "Updating Server..." screen during hot-reload
   */
  showUpdateScreen(): void {
    if (this.destroyed) return;

    this.isUpdating = true;
    this.renderUpdateScreen();

    // Animate the loading spinner
    this.updateAnimationInterval = setInterval(() => {
      this.updateAnimationFrame = (this.updateAnimationFrame + 1) % 8;
      this.renderUpdateScreen();
    }, 100);
  }

  /**
   * Hide the update screen and resume normal rendering
   */
  hideUpdateScreen(): void {
    this.isUpdating = false;

    if (this.updateAnimationInterval) {
      clearInterval(this.updateAnimationInterval);
      this.updateAnimationInterval = null;
    }

    // Force full redraw by clearing screen
    if (!this.destroyed) {
      this.stream.write(`${ESC}[2J${ESC}[H`);
    }
  }

  /**
   * Render the update screen with animated spinner
   */
  private renderUpdateScreen(): void {
    if (this.destroyed) return;

    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
    const spinner = spinnerChars[this.updateAnimationFrame] || '⠋';

    const title = 'UPDATING SERVER';
    const subtitle = 'Please wait...';
    const version = 'Applying new version';

    // Calculate center positions
    const centerY = Math.floor(this.rows / 2);
    const titleX = Math.floor((this.cols - title.length) / 2);
    const subtitleX = Math.floor((this.cols - subtitle.length - 2) / 2);
    const versionX = Math.floor((this.cols - version.length) / 2);

    // Build the screen
    let output = '';

    // Enter alternate screen, hide cursor, set background
    output += `${ESC}[?25l`; // Hide cursor
    output += UPDATE_BG;

    // Clear and fill with background
    output += `${ESC}[2J${ESC}[H`;

    // Draw title
    output += `${ESC}[${centerY - 2};${titleX}H${UPDATE_FG}${title}`;

    // Draw spinner and subtitle
    output += `${ESC}[${centerY};${subtitleX}H${UPDATE_FG}${spinner} ${subtitle}`;

    // Draw version info
    output += `${ESC}[${centerY + 2};${versionX}H${ESC}[38;2;100;100;120m${version}`;

    // Draw decorative box
    const boxWidth = Math.max(title.length, subtitle.length + 2, version.length) + 8;
    const boxHeight = 7;
    const boxX = Math.floor((this.cols - boxWidth) / 2);
    const boxY = centerY - 4;

    output += `${ESC}[38;2;80;60;120m`; // Dim purple for box

    // Top border
    output += `${ESC}[${boxY};${boxX}H╭${'─'.repeat(boxWidth - 2)}╮`;

    // Side borders
    for (let i = 1; i < boxHeight - 1; i++) {
      output += `${ESC}[${boxY + i};${boxX}H│`;
      output += `${ESC}[${boxY + i};${boxX + boxWidth - 1}H│`;
    }

    // Bottom border
    output += `${ESC}[${boxY + boxHeight - 1};${boxX}H╰${'─'.repeat(boxWidth - 2)}╯`;

    output += RESET;

    try {
      this.stream.write(output);
    } catch (err) {
      // Ignore write errors during update
    }
  }

  /**
   * Get serializable session state for hot-reload
   */
  getState(): Partial<SessionState> {
    return {
      sessionId: this.sessionId,
      fingerprint: this.fingerprint,
      username: this.username,
      userId: this.userId || undefined,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /**
   * Start the session (tells worker to create game session)
   */
  async start(): Promise<void> {
    resourceMonitor.trackConnection(this.sessionId, this.userId || undefined);

    // Register callback for session output from worker
    this.workerManager.onSessionOutput(this.sessionId, (_sessionId, output) => {
      this.handleOutput(output);
    });

    // Register callback for userId updates (after onboarding)
    this.workerManager.onSessionUserId(this.sessionId, (_sessionId, userId) => {
      this.setUserId(userId);
    });

    // Register callback for session ended
    this.workerManager.onSessionEnded(this.sessionId, (_sessionId) => {
      if (!this.destroyed) {
        this.stream.end();
      }
    });

    // Subscribe to reload state changes for update screen
    this.unsubscribeReload = this.workerManager.onReloadState((state: ReloadState) => {
      if (state === 'reloading') {
        this.showUpdateScreen();
      } else {
        this.hideUpdateScreen();
      }
    });

    // Tell worker to create a game session for this proxy
    await this.workerManager.createWorkerSession({
      sessionId: this.sessionId,
      fingerprint: this.fingerprint,
      username: this.username,
      userId: this.userId,
      cols: this.cols,
      rows: this.rows,
    });
  }

  /**
   * Destroy the session
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.updateAnimationInterval) {
      clearInterval(this.updateAnimationInterval);
      this.updateAnimationInterval = null;
    }

    // Unsubscribe from reload state
    if (this.unsubscribeReload) {
      this.unsubscribeReload();
      this.unsubscribeReload = null;
    }

    resourceMonitor.untrackConnection(this.sessionId);

    // Tell worker to destroy the session
    await this.workerManager.destroyWorkerSession(this.sessionId);

    // Cleanup terminal
    try {
      this.stream.write(`${ESC}[?1049l${ESC}[?25h${ESC}[0m`);
    } catch {
      // Ignore errors on cleanup
    }
  }
}
