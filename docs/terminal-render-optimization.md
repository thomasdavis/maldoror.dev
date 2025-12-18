# Terminal Rendering Optimization Analysis

## The Fundamental Problem

SSH terminals are **stream-based, not frame-based**. When we send bytes:
- They arrive in order
- The terminal renders them as they arrive
- There's no concept of "wait for full frame then display"

At high resolutions, this causes a visible "wipe-down" effect as the screen redraws progressively from top to bottom.

## Current Codebase Status

### What We Already Have

| Optimization | Status | Location |
|-------------|--------|----------|
| Line-level diffing | **YES** | `pixel-game-renderer.ts:431-439` |
| Color code deduplication | **YES** | `pixel-renderer.ts:77-84` |
| Single write per frame | **YES** | `outputFrame()` concatenates to string |
| Cursor hidden | **YES** | `initialize()` sends `ESC[?25l` |
| Line wrap disabled | **YES** | `initialize()` sends `ESC[?7l` |
| Pre-computed resolutions | **YES** | Tiles/sprites have `resolutions` map |
| No full screen clear | **YES** | Uses cursor positioning, not `ESC[2J` |

### What's Missing

| Optimization | Status | Impact |
|-------------|--------|--------|
| Cell-level diffing | **NO** | High - currently compares entire line strings |
| Dirty region tracking | **NO** | High - redraws entire viewport on any change |
| Zoom-adaptive FPS | **NO** | Medium - high zoom sends huge frames at same rate |
| Reduced color depth | **NO** | Medium - still 24-bit color at all zoom levels |
| Output size tracking | **NO** | Low - no visibility into bytes/frame |

## Realistic Optimization Roadmap

### Phase 1: Measure First (Low Effort, High Value)

Add metrics to understand the problem:

```typescript
// In outputFrame():
const frameBytes = output.length;
const frameKB = (frameBytes / 1024).toFixed(1);
// Display in stats bar: "45KB/frame"
```

This tells us if we're sending 5KB or 500KB per frame.

### Phase 2: Cell-Level Diffing (Medium Effort, High Value)

Current code compares entire line strings:
```typescript
if (lines[y] !== this.previousOutput[y]) {
  // Redraw entire line
}
```

Better approach - compare at cell/segment level:
```typescript
// Track previous frame as structured data, not strings
previousFrame: { cells: RGB[][], dirty: boolean[][] }

// Only emit ANSI for changed cells
for each cell:
  if (cell !== previousCell) {
    moveCursor(x, y)
    emitColor(cell)
    emitChar()
```

**Estimated improvement**: 50-80% bandwidth reduction when only player moves

### Phase 3: Dirty Region Tracking (Medium Effort, High Value)

Track what actually changed:
- Player moved: mark old and new tile positions dirty
- Camera panned: mark edge regions dirty
- Nothing changed: skip frame entirely

```typescript
interface DirtyTracker {
  regions: Set<string>;  // "x,y" of dirty tiles
  fullRedraw: boolean;

  markDirty(x: number, y: number): void;
  markFullRedraw(): void;
  getDirtyRegions(): { x: number, y: number }[];
  clear(): void;
}
```

**Estimated improvement**: 70-90% bandwidth when player is stationary

### Phase 4: Zoom-Adaptive Frame Rate (Low Effort, Medium Value)

Cap FPS based on zoom level:

| Zoom | Approx Pixels | Target FPS |
|------|---------------|------------|
| 0-30% | ~50K | 15 fps |
| 40-60% | ~100K | 10 fps |
| 70-100% | ~200K+ | 5-8 fps |

```typescript
private getTargetFPS(): number {
  if (this.zoomLevel <= 30) return 15;
  if (this.zoomLevel <= 60) return 10;
  return 6;
}
```

### Phase 5: Reduced Color Precision (Low Effort, Low-Medium Value)

At high zoom, reduce from 24-bit to 8-bit or 16-color:

```typescript
function quantizeColor(color: RGB, bits: number): RGB {
  const mask = 256 - (1 << (8 - bits));
  return {
    r: color.r & mask,
    g: color.g & mask,
    b: color.b & mask,
  };
}
```

Fewer unique colors = more repeated ANSI codes = better deduplication.

## What We Cannot Fix

These are fundamental terminal/SSH limitations:

1. **No atomic frame buffer** - Terminal renders bytes as they arrive
2. **No vsync** - Can't sync to display refresh
3. **Progressive paint** - Top rows always appear before bottom
4. **SSH overhead** - Encryption, packetization, network latency

## Recommended Implementation Order

1. **Add byte metrics** (1 hour) - Understand the problem
2. **Zoom-adaptive FPS** (2 hours) - Quick win, easy to implement
3. **Dirty region tracking** (4-8 hours) - Biggest bandwidth savings
4. **Cell-level diffing** (8-16 hours) - Complex but very effective

## Performance Targets

| Scenario | Current (est) | Target |
|----------|---------------|--------|
| Stationary @ 0% zoom | ~20 KB/frame | <5 KB/frame |
| Stationary @ 100% zoom | ~200 KB/frame | <10 KB/frame |
| Moving @ 0% zoom | ~20 KB/frame | ~15 KB/frame |
| Moving @ 100% zoom | ~200 KB/frame | ~50 KB/frame |

## Quick Win: Skip Unchanged Frames

Simplest optimization - if nothing changed, don't render:

```typescript
render(world: WorldDataProvider): void {
  // Hash current state
  const stateHash = this.computeStateHash(world);
  if (stateHash === this.lastStateHash && !this.forceRedraw) {
    return; // Skip this frame entirely
  }
  this.lastStateHash = stateHash;

  // ... rest of render
}
```

## Conclusion

The "wipe-down" effect at high zoom is **expected terminal behavior**, not a bug. We can mitigate it significantly through:

1. Sending fewer bytes (dirty tracking, diffing)
2. Sending them less often (adaptive FPS)
3. Measuring what we send (metrics)

But we cannot eliminate it entirely - that would require a different display technology (GUI, not terminal).
