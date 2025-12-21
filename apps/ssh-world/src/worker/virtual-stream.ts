/**
 * VirtualStream - IPC-backed stream for worker-based GameSession
 *
 * This stream acts as a Duplex but instead of real I/O:
 * - write() sends data back to main process via IPC
 * - Input is pushed via pushInput() from worker message handler
 *
 * This allows GameSession to run in the worker process unchanged,
 * while the main process holds the real SSH connection.
 */

import { Duplex, DuplexOptions } from 'stream';

export type SendOutputFn = (sessionId: string, output: string) => void;

export class VirtualStream extends Duplex {
  private sessionId: string;
  private sendOutput: SendOutputFn;
  private _isDestroyed: boolean = false;

  constructor(
    sessionId: string,
    sendOutput: SendOutputFn,
    options?: DuplexOptions
  ) {
    super({
      ...options,
      // Use object mode for the readable side to handle input chunks
      readableObjectMode: false,
      writableObjectMode: false,
    });
    this.sessionId = sessionId;
    this.sendOutput = sendOutput;
  }

  /**
   * Called by GameSession when it writes render output
   * We forward this to the main process via IPC
   */
  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (this._isDestroyed) {
      callback(new Error('Stream destroyed'));
      return;
    }

    try {
      const output = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.sendOutput(this.sessionId, output);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Required by Duplex - returns data when read() is called
   * We use push() instead, so this is a no-op
   */
  _read(_size: number): void {
    // Input is pushed via pushInput(), not pulled
  }

  /**
   * Push input data received from main process
   * This emits 'data' event on the stream
   */
  pushInput(data: Buffer): void {
    if (this._isDestroyed) return;
    this.push(data);
  }

  /**
   * Override destroy to mark as destroyed
   */
  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this._isDestroyed = true;
    callback(error);
  }

  /**
   * Override end to clean up
   */
  _final(callback: (error?: Error | null) => void): void {
    this._isDestroyed = true;
    callback();
  }

  /**
   * Check if stream is destroyed
   */
  isStreamDestroyed(): boolean {
    return this._isDestroyed;
  }
}
