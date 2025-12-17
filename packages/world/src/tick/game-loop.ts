import { EventEmitter } from 'events';

/**
 * Game loop configuration
 */
export interface GameLoopConfig {
  tickRate: number;      // Target ticks per second
  maxDeltaTime: number;  // Maximum delta time (ms)
  catchUpLimit: number;  // Maximum ticks to catch up
}

/**
 * Context passed to tick handlers
 */
export interface TickContext {
  tick: number;
  deltaTime: number;
  timestamp: number;
  lag: number;
}

type TickHandler = (ctx: TickContext) => void | Promise<void>;

/**
 * Fixed timestep game loop with lag compensation
 */
export class GameLoop extends EventEmitter {
  private config: GameLoopConfig;
  private running: boolean = false;
  private tick: number = 0;
  private lastTime: number = 0;
  private accumulator: number = 0;
  private tickInterval: number;
  private timer: NodeJS.Timeout | null = null;

  private preTickHandlers: TickHandler[] = [];
  private tickHandlers: TickHandler[] = [];
  private postTickHandlers: TickHandler[] = [];

  constructor(config: Partial<GameLoopConfig> = {}) {
    super();
    this.config = {
      tickRate: 15,
      maxDeltaTime: 250,
      catchUpLimit: 5,
      ...config,
    };
    this.tickInterval = 1000 / this.config.tickRate;
  }

  /**
   * Register handler for pre-tick phase (input gathering)
   */
  onPreTick(handler: TickHandler): void {
    this.preTickHandlers.push(handler);
  }

  /**
   * Register handler for tick phase (game logic)
   */
  onTick(handler: TickHandler): void {
    this.tickHandlers.push(handler);
  }

  /**
   * Register handler for post-tick phase (state broadcast)
   */
  onPostTick(handler: TickHandler): void {
    this.postTickHandlers.push(handler);
  }

  /**
   * Start the game loop
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.lastTime = Date.now();
    this.accumulator = 0;
    this.tick = 0;

    this.emit('start');
    this.scheduleNextFrame();
  }

  /**
   * Stop the game loop
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.emit('stop');
  }

  /**
   * Schedule next frame
   */
  private scheduleNextFrame(): void {
    if (!this.running) return;

    const now = Date.now();
    const elapsed = now - this.lastTime;
    const nextTickIn = Math.max(0, this.tickInterval - elapsed);

    this.timer = setTimeout(() => this.frame(), nextTickIn);
  }

  /**
   * Execute one frame (may contain multiple ticks)
   */
  private async frame(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    let deltaTime = now - this.lastTime;
    this.lastTime = now;

    // Clamp delta time
    if (deltaTime > this.config.maxDeltaTime) {
      deltaTime = this.config.maxDeltaTime;
    }

    this.accumulator += deltaTime;

    // Process fixed timestep ticks
    let ticksProcessed = 0;
    while (this.accumulator >= this.tickInterval && ticksProcessed < this.config.catchUpLimit) {
      const ctx: TickContext = {
        tick: this.tick,
        deltaTime: this.tickInterval,
        timestamp: now,
        lag: this.accumulator,
      };

      await this.processTick(ctx);

      this.accumulator -= this.tickInterval;
      this.tick++;
      ticksProcessed++;
    }

    // Drop accumulated time if we hit catch-up limit
    if (this.accumulator >= this.tickInterval) {
      this.emit('lagWarning', { droppedTime: this.accumulator - this.tickInterval });
      this.accumulator = this.accumulator % this.tickInterval;
    }

    this.scheduleNextFrame();
  }

  /**
   * Process a single tick
   */
  private async processTick(ctx: TickContext): Promise<void> {
    const startTime = Date.now();

    try {
      // Pre-tick phase
      for (const handler of this.preTickHandlers) {
        await handler(ctx);
      }

      // Tick phase
      for (const handler of this.tickHandlers) {
        await handler(ctx);
      }

      // Post-tick phase
      for (const handler of this.postTickHandlers) {
        await handler(ctx);
      }

      const tickTime = Date.now() - startTime;
      this.emit('tickComplete', { tick: ctx.tick, duration: tickTime });

      if (tickTime > this.tickInterval * 0.8) {
        this.emit('tickSlow', {
          tick: ctx.tick,
          duration: tickTime,
          budget: this.tickInterval,
        });
      }
    } catch (error) {
      this.emit('tickError', { tick: ctx.tick, error });
    }
  }

  /**
   * Get current stats
   */
  getStats(): { tick: number; tickRate: number; running: boolean } {
    return {
      tick: this.tick,
      tickRate: this.config.tickRate,
      running: this.running,
    };
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current tick
   */
  getCurrentTick(): number {
    return this.tick;
  }
}
