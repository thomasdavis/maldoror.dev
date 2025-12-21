/**
 * Resource Monitor - Tracks memory, connections, and other resources
 * Logs verbose information for debugging memory leaks and crashes
 */

interface ResourceSnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
}

interface ConnectionInfo {
  id: string;
  userId?: string;
  startTime: number;
  lastActivity: number;
}

class ResourceMonitor {
  private connections: Map<string, ConnectionInfo> = new Map();
  private lastSnapshot: ResourceSnapshot | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private operationStack: string[] = [];
  private peakHeap: number = 0;
  private startTime: number = Date.now();

  /**
   * Start periodic monitoring
   */
  start(intervalMs: number = 30000): void {
    this.log('ResourceMonitor started');
    this.logMemory('STARTUP');

    this.intervalId = setInterval(() => {
      this.logMemory('PERIODIC');
      this.logConnections();
      this.checkForLeaks();
    }, intervalMs);

    // Also log on GC if available
    if (typeof global.gc === 'function') {
      this.log('Manual GC available (--expose-gc enabled)');
    } else {
      this.log('WARNING: Manual GC not available. Run with --expose-gc for better memory management');
    }
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Log current memory usage with context
   */
  logMemory(context: string): ResourceSnapshot {
    const mem = process.memoryUsage();
    const snapshot: ResourceSnapshot = {
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      rss: mem.rss,
      arrayBuffers: mem.arrayBuffers,
    };

    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    const externalMB = (mem.external / 1024 / 1024).toFixed(1);
    const arrayBuffersMB = (mem.arrayBuffers / 1024 / 1024).toFixed(1);

    // Track peak
    if (mem.heapUsed > this.peakHeap) {
      this.peakHeap = mem.heapUsed;
    }
    const peakMB = (this.peakHeap / 1024 / 1024).toFixed(1);

    // Calculate delta if we have a previous snapshot
    let delta = '';
    if (this.lastSnapshot) {
      const heapDelta = mem.heapUsed - this.lastSnapshot.heapUsed;
      const sign = heapDelta >= 0 ? '+' : '';
      delta = ` (${sign}${(heapDelta / 1024 / 1024).toFixed(1)}MB)`;
    }

    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const uptimeStr = `${Math.floor(uptime / 60)}m${uptime % 60}s`;

    this.log(
      `[MEMORY:${context}] heap=${heapMB}/${heapTotalMB}MB${delta} rss=${rssMB}MB ext=${externalMB}MB arr=${arrayBuffersMB}MB peak=${peakMB}MB uptime=${uptimeStr}`
    );

    // Warn if heap is getting high
    const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;
    if (heapPercent > 80) {
      this.log(`[MEMORY:WARNING] Heap usage at ${heapPercent.toFixed(0)}% - potential memory pressure`);
    }

    // Warn if approaching limit (assuming 4GB limit)
    const heapLimitMB = 4096;
    const usedMB = mem.heapUsed / 1024 / 1024;
    if (usedMB > heapLimitMB * 0.75) {
      this.log(`[MEMORY:CRITICAL] Heap at ${usedMB.toFixed(0)}MB of ${heapLimitMB}MB limit (${((usedMB / heapLimitMB) * 100).toFixed(0)}%)`);
      this.forceGC();
    }

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Force garbage collection if available
   */
  forceGC(): void {
    if (typeof global.gc === 'function') {
      const before = process.memoryUsage().heapUsed;
      global.gc();
      const after = process.memoryUsage().heapUsed;
      const freed = (before - after) / 1024 / 1024;
      this.log(`[GC] Forced GC freed ${freed.toFixed(1)}MB`);
    }
  }

  /**
   * Track a connection
   */
  trackConnection(id: string, userId?: string): void {
    this.connections.set(id, {
      id,
      userId,
      startTime: Date.now(),
      lastActivity: Date.now(),
    });
    this.log(`[CONN:OPEN] id=${id} user=${userId || 'unknown'} total=${this.connections.size}`);
    this.logMemory('CONN_OPEN');
  }

  /**
   * Update connection activity
   */
  updateConnection(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.lastActivity = Date.now();
    }
  }

  /**
   * Untrack a connection
   */
  untrackConnection(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      const duration = Math.floor((Date.now() - conn.startTime) / 1000);
      this.log(`[CONN:CLOSE] id=${id} user=${conn.userId || 'unknown'} duration=${duration}s remaining=${this.connections.size - 1}`);
    }
    this.connections.delete(id);
    this.logMemory('CONN_CLOSE');
  }

  /**
   * Log all active connections
   */
  logConnections(): void {
    if (this.connections.size === 0) {
      this.log('[CONN:STATUS] No active connections');
      return;
    }

    const now = Date.now();
    const connList = Array.from(this.connections.values()).map(c => {
      const age = Math.floor((now - c.startTime) / 1000);
      const idle = Math.floor((now - c.lastActivity) / 1000);
      return `${c.userId || c.id.slice(0, 8)}(age=${age}s,idle=${idle}s)`;
    });

    this.log(`[CONN:STATUS] ${this.connections.size} active: ${connList.join(', ')}`);
  }

  /**
   * Start tracking an operation
   */
  startOperation(name: string): void {
    this.operationStack.push(name);
    this.log(`[OP:START] ${name} (stack depth: ${this.operationStack.length})`);
    this.logMemory(`OP_START:${name}`);
  }

  /**
   * End tracking an operation
   */
  endOperation(name: string): void {
    const idx = this.operationStack.lastIndexOf(name);
    if (idx >= 0) {
      this.operationStack.splice(idx, 1);
    }
    this.log(`[OP:END] ${name} (stack depth: ${this.operationStack.length})`);
    this.logMemory(`OP_END:${name}`);
    this.forceGC();
  }

  /**
   * Check for potential memory leaks
   */
  private checkForLeaks(): void {
    const mem = process.memoryUsage();
    const heapMB = mem.heapUsed / 1024 / 1024;

    // If heap keeps growing without connections, that's suspicious
    if (this.connections.size === 0 && heapMB > 500) {
      this.log(`[LEAK:SUSPECT] High heap (${heapMB.toFixed(0)}MB) with no active connections`);
    }

    // Check for stale connections (idle > 5 minutes)
    const now = Date.now();
    for (const [id, conn] of this.connections) {
      const idle = (now - conn.lastActivity) / 1000;
      if (idle > 300) {
        this.log(`[CONN:STALE] Connection ${id} idle for ${Math.floor(idle)}s`);
      }
    }
  }

  /**
   * Get current stats
   */
  getStats(): {
    connections: number;
    heapUsedMB: number;
    heapTotalMB: number;
    peakHeapMB: number;
    uptimeSeconds: number;
    activeOperations: string[];
  } {
    const mem = process.memoryUsage();
    return {
      connections: this.connections.size,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      peakHeapMB: Math.round(this.peakHeap / 1024 / 1024),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      activeOperations: [...this.operationStack],
    };
  }

  /**
   * Check if any generation operations are in progress
   */
  hasActiveGenerations(): boolean {
    return this.operationStack.some(op =>
      op.includes('GENERATE') || op.includes('AVATAR') || op.includes('BUILDING') || op.includes('NPC')
    );
  }

  /**
   * Get active operations
   */
  getActiveOperations(): string[] {
    return [...this.operationStack];
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} ${message}`);
  }
}

// Singleton instance
export const resourceMonitor = new ResourceMonitor();

// Also export the class for testing
export { ResourceMonitor };
