/**
 * Performance Statistics Tracker for Render Optimizations
 *
 * Tracks metrics for each optimization to help debug performance issues.
 * Stats are logged at 10-second intervals when enabled.
 */

export interface PerfStats {
  // CRLE (Chromatic Run-Length Encoding)
  crle: {
    enabled: boolean;
    colorGroupsPerFrame: number;
    bytesSaved: number;
    totalBytesWithout: number;
    totalBytesWith: number;
  };

  // Foveated Temporal Rendering
  foveated: {
    enabled: boolean;
    zoneAUpdates: number;  // Foveal (60Hz)
    zoneBUpdates: number;  // Parafoveal (10Hz)
    zoneCUpdates: number;  // Peripheral (4Hz)
    cellsSkipped: number;
  };

  // Cell Diffing
  cellDiff: {
    enabled: boolean;
    cellsChanged: number;
    cellsTotal: number;
    diffRatio: number;  // cellsChanged / cellsTotal
  };

  // Pre-computed Brightness
  brightness: {
    enabled: boolean;
    cacheHits: number;
    cacheMisses: number;
    variantsGenerated: number;
  };

  // Probabilistic Pre-Rendering
  prediction: {
    enabled: boolean;
    predictionsCorrect: number;
    predictionsMissed: number;
    hitRate: number;
    preRenderedFrames: number;
  };

  // Overall
  frameCount: number;
  avgBytesPerFrame: number;
  avgRenderTimeMs: number;
}

const DEFAULT_STATS: PerfStats = {
  crle: {
    enabled: false,
    colorGroupsPerFrame: 0,
    bytesSaved: 0,
    totalBytesWithout: 0,
    totalBytesWith: 0,
  },
  foveated: {
    enabled: false,
    zoneAUpdates: 0,
    zoneBUpdates: 0,
    zoneCUpdates: 0,
    cellsSkipped: 0,
  },
  cellDiff: {
    enabled: true,  // Already implemented
    cellsChanged: 0,
    cellsTotal: 0,
    diffRatio: 0,
  },
  brightness: {
    enabled: false,
    cacheHits: 0,
    cacheMisses: 0,
    variantsGenerated: 0,
  },
  prediction: {
    enabled: false,
    predictionsCorrect: 0,
    predictionsMissed: 0,
    hitRate: 0,
    preRenderedFrames: 0,
  },
  frameCount: 0,
  avgBytesPerFrame: 0,
  avgRenderTimeMs: 0,
};

class PerfStatsTracker {
  private stats: PerfStats = { ...DEFAULT_STATS };
  private enabled: boolean = false;
  private logInterval: ReturnType<typeof setInterval> | null = null;
  private totalBytes: number = 0;
  private totalRenderTime: number = 0;
  private lastLogTime: number = Date.now();

  /**
   * Enable performance tracking with optional logging
   */
  enable(logIntervalMs: number = 10000): void {
    this.enabled = true;
    if (this.logInterval) {
      clearInterval(this.logInterval);
    }
    this.logInterval = setInterval(() => this.logStats(), logIntervalMs);
  }

  /**
   * Disable performance tracking
   */
  disable(): void {
    this.enabled = false;
    if (this.logInterval) {
      clearInterval(this.logInterval);
      this.logInterval = null;
    }
  }

  /**
   * Check if tracking is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Record a frame render
   */
  recordFrame(bytes: number, renderTimeMs: number): void {
    if (!this.enabled) return;
    this.stats.frameCount++;
    this.totalBytes += bytes;
    this.totalRenderTime += renderTimeMs;
    this.stats.avgBytesPerFrame = this.totalBytes / this.stats.frameCount;
    this.stats.avgRenderTimeMs = this.totalRenderTime / this.stats.frameCount;
  }

  /**
   * Record CRLE stats
   */
  recordCRLE(colorGroups: number, bytesWithout: number, bytesWith: number): void {
    if (!this.enabled) return;
    this.stats.crle.enabled = true;
    this.stats.crle.colorGroupsPerFrame = colorGroups;
    this.stats.crle.totalBytesWithout += bytesWithout;
    this.stats.crle.totalBytesWith += bytesWith;
    this.stats.crle.bytesSaved = this.stats.crle.totalBytesWithout - this.stats.crle.totalBytesWith;
  }

  /**
   * Record foveated rendering stats
   */
  recordFoveated(zoneA: number, zoneB: number, zoneC: number, skipped: number): void {
    if (!this.enabled) return;
    this.stats.foveated.enabled = true;
    this.stats.foveated.zoneAUpdates += zoneA;
    this.stats.foveated.zoneBUpdates += zoneB;
    this.stats.foveated.zoneCUpdates += zoneC;
    this.stats.foveated.cellsSkipped += skipped;
  }

  /**
   * Record cell diff stats
   */
  recordCellDiff(changed: number, total: number): void {
    if (!this.enabled) return;
    this.stats.cellDiff.enabled = true;
    this.stats.cellDiff.cellsChanged += changed;
    this.stats.cellDiff.cellsTotal += total;
    if (this.stats.cellDiff.cellsTotal > 0) {
      this.stats.cellDiff.diffRatio = this.stats.cellDiff.cellsChanged / this.stats.cellDiff.cellsTotal;
    }
  }

  /**
   * Record brightness cache stats
   */
  recordBrightness(hit: boolean, generated: number = 0): void {
    if (!this.enabled) return;
    this.stats.brightness.enabled = true;
    if (hit) {
      this.stats.brightness.cacheHits++;
    } else {
      this.stats.brightness.cacheMisses++;
    }
    this.stats.brightness.variantsGenerated += generated;
  }

  /**
   * Record prediction stats
   */
  recordPrediction(correct: boolean, preRendered: number = 0): void {
    if (!this.enabled) return;
    this.stats.prediction.enabled = true;
    if (correct) {
      this.stats.prediction.predictionsCorrect++;
    } else {
      this.stats.prediction.predictionsMissed++;
    }
    this.stats.prediction.preRenderedFrames += preRendered;
    const total = this.stats.prediction.predictionsCorrect + this.stats.prediction.predictionsMissed;
    if (total > 0) {
      this.stats.prediction.hitRate = this.stats.prediction.predictionsCorrect / total;
    }
  }

  /**
   * Get current stats
   */
  getStats(): PerfStats {
    return { ...this.stats };
  }

  /**
   * Reset all stats
   */
  reset(): void {
    this.stats = { ...DEFAULT_STATS };
    this.totalBytes = 0;
    this.totalRenderTime = 0;
  }

  /**
   * Log current stats to console
   */
  private logStats(): void {
    const elapsed = (Date.now() - this.lastLogTime) / 1000;
    this.lastLogTime = Date.now();

    const s = this.stats;
    const lines: string[] = [
      `\n[PerfStats] ${elapsed.toFixed(1)}s interval, ${s.frameCount} frames`,
      `  Avg: ${s.avgBytesPerFrame.toFixed(0)} bytes/frame, ${s.avgRenderTimeMs.toFixed(2)}ms render`,
    ];

    if (s.crle.enabled) {
      const savings = s.crle.totalBytesWithout > 0
        ? ((s.crle.bytesSaved / s.crle.totalBytesWithout) * 100).toFixed(1)
        : '0';
      lines.push(`  CRLE: ${s.crle.colorGroupsPerFrame} color groups, ${savings}% bytes saved`);
    }

    if (s.foveated.enabled) {
      lines.push(`  Foveated: A=${s.foveated.zoneAUpdates} B=${s.foveated.zoneBUpdates} C=${s.foveated.zoneCUpdates} skipped=${s.foveated.cellsSkipped}`);
    }

    if (s.cellDiff.enabled) {
      lines.push(`  CellDiff: ${(s.cellDiff.diffRatio * 100).toFixed(1)}% cells changed`);
    }

    if (s.brightness.enabled) {
      const hitRate = s.brightness.cacheHits + s.brightness.cacheMisses > 0
        ? ((s.brightness.cacheHits / (s.brightness.cacheHits + s.brightness.cacheMisses)) * 100).toFixed(1)
        : '0';
      lines.push(`  Brightness: ${hitRate}% cache hit rate, ${s.brightness.variantsGenerated} generated`);
    }

    if (s.prediction.enabled) {
      lines.push(`  Prediction: ${(s.prediction.hitRate * 100).toFixed(1)}% hit rate, ${s.prediction.preRenderedFrames} pre-rendered`);
    }

    console.log(lines.join('\n'));

    // Reset for next interval
    this.reset();
  }
}

// Singleton instance
export const perfStats = new PerfStatsTracker();
