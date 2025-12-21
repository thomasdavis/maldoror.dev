/**
 * OutputPump - SSH backpressure handler for game streaming
 *
 * Handles the critical issue of stream.write() returning false when the
 * client's TCP buffer is full. Without backpressure handling, the server
 * keeps rendering frames faster than they can be sent, causing:
 * - Memory growth (queued frames accumulate)
 * - Latency explosion (old frames clog the pipe)
 * - Eventually crashes
 *
 * This class:
 * - Queues output chunks
 * - Respects drain events (only writes when socket is ready)
 * - Drops older frames when backlogged (keeps latest for responsiveness)
 * - Provides metrics for debugging
 */
export class OutputPump {
  private stream: NodeJS.WritableStream;
  private queue: string[] = [];
  private queuedBytes = 0;
  private writing = false;
  private destroyed = false;

  // Configurable limits
  private maxQueuedBytes: number;

  // Metrics
  private droppedFrames = 0;
  private drainCount = 0;
  private totalBytesWritten = 0;
  private totalFramesWritten = 0;
  private peakQueuedBytes = 0;

  // Event handlers (stored for cleanup)
  private drainHandler: () => void;
  private closeHandler: () => void;
  private errorHandler: () => void;

  constructor(stream: NodeJS.WritableStream, options?: { maxQueuedBytes?: number }) {
    this.stream = stream;
    this.maxQueuedBytes = options?.maxQueuedBytes ?? 512 * 1024; // 512KB default

    // Bind handlers so we can remove them later
    this.drainHandler = () => {
      if (this.destroyed) return;
      this.drainCount++;
      this.flush();
    };

    this.closeHandler = () => {
      this.markDestroyed();
    };

    this.errorHandler = () => {
      this.markDestroyed();
    };

    // Listen for drain events to resume writing
    this.stream.on('drain', this.drainHandler);

    // Handle stream close/error
    this.stream.on('close', this.closeHandler);
    this.stream.on('error', this.errorHandler);
  }

  /**
   * Mark pump as destroyed and clean up
   */
  private markDestroyed(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue = [];
    this.queuedBytes = 0;
  }

  /**
   * Enqueue a chunk for writing.
   * If backlogged beyond maxQueuedBytes, drops older frames (keeps latest).
   */
  enqueue(chunk: string): void {
    if (this.destroyed) return;

    const bytes = Buffer.byteLength(chunk, 'utf8');
    this.queue.push(chunk);
    this.queuedBytes += bytes;

    // Track peak for metrics
    if (this.queuedBytes > this.peakQueuedBytes) {
      this.peakQueuedBytes = this.queuedBytes;
    }

    // Drop older frames if behind (keep latest for responsiveness)
    while (this.queuedBytes > this.maxQueuedBytes && this.queue.length > 1) {
      const dropped = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(dropped, 'utf8');
      this.droppedFrames++;
    }

    this.flush();
  }

  /**
   * Write directly without queueing (for critical UI like input echo).
   * Still respects stream state but doesn't participate in frame dropping.
   */
  writeImmediate(chunk: string): boolean {
    if (this.destroyed) return false;

    const bytes = Buffer.byteLength(chunk, 'utf8');
    this.totalBytesWritten += bytes;

    return this.stream.write(chunk);
  }

  /**
   * Flush queued chunks to stream.
   * Stops when stream.write() returns false (buffer full).
   */
  private flush(): void {
    if (this.destroyed || this.writing) return;
    this.writing = true;

    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      const bytes = Buffer.byteLength(chunk, 'utf8');
      this.queuedBytes -= bytes;
      this.totalBytesWritten += bytes;
      this.totalFramesWritten++;

      const ok = this.stream.write(chunk);
      if (!ok) {
        // Buffer full - wait for drain event
        this.drainCount++;
        break;
      }
    }

    this.writing = false;
  }

  /**
   * Check if we should skip rendering this frame.
   * Returns true if backlog is too high.
   */
  shouldSkipFrame(thresholdBytes: number = 128 * 1024): boolean {
    return this.queuedBytes > thresholdBytes;
  }

  /**
   * Get current backlog in bytes.
   */
  getBacklogBytes(): number {
    return this.queuedBytes;
  }

  /**
   * Get number of frames dropped due to backpressure.
   */
  getDroppedFrames(): number {
    return this.droppedFrames;
  }

  /**
   * Get number of drain events (indicates buffer was full).
   */
  getDrainCount(): number {
    return this.drainCount;
  }

  /**
   * Get total bytes written to stream.
   */
  getTotalBytesWritten(): number {
    return this.totalBytesWritten;
  }

  /**
   * Get total frames written to stream.
   */
  getTotalFramesWritten(): number {
    return this.totalFramesWritten;
  }

  /**
   * Get peak queue size (useful for tuning maxQueuedBytes).
   */
  getPeakQueuedBytes(): number {
    return this.peakQueuedBytes;
  }

  /**
   * Get all metrics as an object (for /stats endpoint).
   */
  getMetrics(): OutputPumpMetrics {
    return {
      queuedBytes: this.queuedBytes,
      peakQueuedBytes: this.peakQueuedBytes,
      droppedFrames: this.droppedFrames,
      drainCount: this.drainCount,
      totalBytesWritten: this.totalBytesWritten,
      totalFramesWritten: this.totalFramesWritten,
      queueLength: this.queue.length,
    };
  }

  /**
   * Check if the pump is destroyed (stream closed).
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Destroy the pump, remove listeners, and clear queue.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue = [];
    this.queuedBytes = 0;

    // Remove event listeners to prevent memory leaks
    this.stream.removeListener('drain', this.drainHandler);
    this.stream.removeListener('close', this.closeHandler);
    this.stream.removeListener('error', this.errorHandler);
  }
}

export interface OutputPumpMetrics {
  queuedBytes: number;
  peakQueuedBytes: number;
  droppedFrames: number;
  drainCount: number;
  totalBytesWritten: number;
  totalFramesWritten: number;
  queueLength: number;
}
