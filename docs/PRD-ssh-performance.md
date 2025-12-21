# PRD: SSH Game Server Performance Optimization

## Overview

Maldoror is a terminal-based MMO game accessed via SSH. Players connect using `ssh abyss.maldoror.dev` and see a real-time rendered pixel-art world in their terminal using ANSI escape codes. The server has been experiencing crashes and slow streaming performance.

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRODUCTION SERVER                               │
│                           134.199.180.251 (Hetzner)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     Port 22      ┌──────────────────────────────────────┐ │
│  │   HAProxy   │◄────────────────►│         SSH Container                │ │
│  │  (TCP Mode) │     Port 2222    │                                      │ │
│  └─────────────┘                  │  ┌────────────────────────────────┐  │ │
│        │                          │  │        Main Process            │  │ │
│        │ Health                   │  │                                │  │ │
│        │ Checks                   │  │  ┌──────────┐ ┌─────────────┐  │  │ │
│        │ (TCP)                    │  │  │SSHServer │ │ StatsServer │  │  │ │
│        ▼                          │  │  │ :2222    │ │   :3000     │  │  │ │
│  Connects &                       │  │  └────┬─────┘ └─────────────┘  │  │ │
│  immediately                      │  │       │                        │  │ │
│  disconnects                      │  │       │ Per-connection         │  │ │
│  (causes                          │  │       ▼                        │  │ │
│  ECONNRESET)                      │  │  ┌──────────────┐              │  │ │
│                                   │  │  │ GameSession  │ ×N           │  │ │
│                                   │  │  │ - Renderer   │              │  │ │
│                                   │  │  │ - TileProvider              │  │ │
│                                   │  │  │ - InputRouter│              │  │ │
│                                   │  │  └──────┬───────┘              │  │ │
│                                   │  │         │                      │  │ │
│                                   │  │         │ IPC (MessageChannel) │  │ │
│                                   │  │         ▼                      │  │ │
│                                   │  │  ┌──────────────┐              │  │ │
│                                   │  │  │WorkerManager │              │  │ │
│                                   │  │  └──────┬───────┘              │  │ │
│                                   │  └─────────┼────────────────────┘  │ │
│                                   │            │                        │ │
│                                   │  ┌─────────┼────────────────────┐  │ │
│                                   │  │         ▼   Worker Process   │  │ │
│                                   │  │  ┌──────────────┐            │  │ │
│                                   │  │  │  GameServer  │            │  │ │
│                                   │  │  │              │            │  │ │
│                                   │  │  │ SpatialIndex │            │  │ │
│                                   │  │  │ ChunkCache   │            │  │ │
│                                   │  │  │ PlayerStates │            │  │ │
│                                   │  │  └──────┬───────┘            │  │ │
│                                   │  └─────────┼────────────────────┘  │ │
│                                   └────────────┼────────────────────────┘ │
│                                                │                          │
│  ┌─────────────────────────────────────────────┼────────────────────────┐ │
│  │                          PostgreSQL         │                        │ │
│  │                                             ▼                        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │ │
│  │  │   users     │  │  avatars    │  │  buildings  │  │player_state │ │ │
│  │  │  user_keys  │  │sprite_frames│  │building_tiles│ │   world     │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │ │
│  │                                                                      │ │
│  │  Connection Pool: 20 connections, 30s idle timeout                   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Rendering Pipeline

The game renders at ~15 FPS (67ms tick interval). Each frame:

1. **Tick starts** in `GameSession.tick()`
2. **Get visible players** - IPC call to worker process (has 5s timeout)
3. **Load sprites** - For new players entering viewport, load from disk or DB
4. **Render viewport** - `ViewportRenderer.renderToBuffer()` generates pixel grid
5. **Convert to cells** - Pixels → terminal cells (braille/halfblock/normal mode)
6. **Diff against previous** - Only emit changed cells
7. **Generate ANSI** - Build escape code string
8. **Write to stream** - `stream.write(output)` sends to SSH client

### Render Modes
- **Braille**: 2 pixels/char width, 4 pixels/row (highest resolution)
- **Halfblock**: 1 pixel/char width, 2 pixels/row (balanced)
- **Normal**: 2 chars/pixel width, 1 pixel/row (lowest resolution)

### Frame Output Size
- Typical frame: 5-50KB of ANSI codes
- Full redraw: 100-200KB
- Incremental (no movement): <1KB

## Identified Performance Bottlenecks

### CRITICAL - Fixed in Latest Deploy

#### 1. String Concatenation in Render Loop
**File:** `packages/render/src/pixel/pixel-game-renderer.ts`
**Lines:** 608-643, 649-696

**Problem:**
```typescript
// OLD - Created new string object per iteration
let output = '';
for (let y = 0; y < cells.length; y++) {
  for (let x = 0; x < row.length; x++) {
    output += fgColor(cell.fgColor);  // String allocation
    output += bgColor(cell.bgColor);  // String allocation
    output += cell.char;               // String allocation
  }
}
```

**Frequency:** Every frame (15/sec) × every cell (80×30 = 2,400 cells)
**Impact:** ~7,200 string allocations per frame, 108,000 per second

**Fix Applied:**
```typescript
// NEW - Single allocation at end
const chunks: string[] = [];
for (let y = 0; y < cells.length; y++) {
  for (let x = 0; x < row.length; x++) {
    chunks.push(fgColor(cell.fgColor));
    chunks.push(bgColor(cell.bgColor));
    chunks.push(cell.char);
  }
}
return chunks.join('');
```

#### 2. Deep Copy of Cell Buffer Every Frame
**File:** `packages/render/src/pixel/pixel-game-renderer.ts`
**Line:** 602

**Problem:**
```typescript
// OLD - Deep cloned entire grid every frame
this.previousCells = viewportCells.map(row => row.map(cell => ({ ...cell })));
```

**Frequency:** Every frame (15/sec)
**Impact:** 80×30 = 2,400 object spreads = 36,000 allocations/second

**Fix Applied:**
```typescript
// NEW - Reference swap (viewportCells is freshly created each frame)
this.previousCells = viewportCells;
```

#### 3. N+1 Avatar Database Queries
**File:** `apps/ssh-world/src/server/game-session.ts`
**Lines:** 859-910

**Problem:**
```typescript
// OLD - Individual query per player
await Promise.all(playerIds.map(async (playerId) => {
  const avatar = await db.query.avatars.findFirst({
    where: eq(schema.avatars.userId, playerId),
  });
}));
```

**Frequency:** Every 45 ticks (~3 sec) when viewport refreshes, or when players enter viewport
**Impact:** If 20 players visible, that's 20 separate DB round-trips

**Fix Applied:**
```typescript
// NEW - Single batched query
const avatars = await db.select({
  userId: schema.avatars.userId,
  spriteJson: schema.avatars.spriteJson,
})
  .from(schema.avatars)
  .where(inArray(schema.avatars.userId, needsDbLookup));

const avatarMap = new Map(avatars.map(a => [a.userId, a]));
```

#### 4. Building Save: 360 Individual INSERT Queries
**File:** `apps/ssh-world/src/utils/building-storage.ts`
**Lines:** 23-117

**Problem:**
```typescript
// OLD - Insert per tile/resolution/direction
for (const direction of directions) {        // 4 directions
  for (let tileY = 0; tileY < 3; tileY++) {  // 3 rows
    for (let tileX = 0; tileX < 3; tileX++) { // 3 cols
      for (const resolution of RESOLUTIONS) { // 10 resolutions
        await db.insert(schema.buildingTiles).values({...});
      }
    }
  }
}
// = 4 × 3 × 3 × 10 = 360 INSERT statements
```

**Frequency:** Every time a player places a building
**Impact:** 360 DB round-trips, ~5-10 seconds to save a building

**Fix Applied:**
```typescript
// NEW - Collect all rows, single batched insert
const dbRows = [];
// ... collect all rows in loop ...

await db.insert(schema.buildingTiles)
  .values(dbRows)
  .onConflictDoUpdate({...});
// = 1 INSERT statement with 360 rows
```

### HIGH PRIORITY - Not Yet Fixed

#### 5. Visible Players IPC Call Every 45 Ticks
**File:** `apps/ssh-world/src/server/game-session.ts`
**Lines:** 321-337

**Problem:**
```typescript
const periodicRefresh = this.tickCounter % 45 === 0;  // Every ~3 seconds
if (positionChanged || periodicRefresh) {
  this.cachedVisiblePlayers = await this.workerManager.getVisiblePlayers(
    this.playerX, this.playerY, this.cols, this.rows, this.userId!
  );
}
```

**Details:**
- IPC call to worker process has 5 second timeout
- `await` blocks the entire tick while waiting
- Worker queries SpatialIndex (in-memory, fast) but IPC overhead adds latency

**Suggested Fix:**
- Cache visible players locally with TTL
- Use event-driven updates (subscribe to player enter/leave events)
- Don't await in render tick - fire and forget, use stale data until response

#### 6. Blocking Sprite Loads in Render Tick
**File:** `apps/ssh-world/src/server/game-session.ts`
**Lines:** 340-365

**Problem:**
```typescript
// Inside tick() - blocks rendering while loading sprites
if (spriteIdsToLoad.length > 0) {
  await this.batchLoadPlayerSprites(spriteIdsToLoad);  // BLOCKS
}
```

**Details:**
- First time a new player enters viewport, their sprite must load
- Loads from disk (PNG files) or falls back to database
- Entire frame rendering waits for I/O

**Suggested Fix:**
- Use placeholder sprite immediately
- Load real sprite in background (fire and forget)
- Update sprite when loaded (will show on next frame)

#### 7. Stats Bar Rebuilding Every Frame
**File:** `packages/render/src/pixel/pixel-game-renderer.ts`
**Lines:** 475-540

**Problem:**
```typescript
// Called every frame, even when skipping render
const statsBar = this.renderStatsBar();
```

**Details:**
- Stats bar includes: username, position, zoom, FPS, frame bytes, tile size
- Only FPS counter actually changes frequently
- Rebuilds entire formatted string every frame

**Suggested Fix:**
- Cache stats bar string
- Only rebuild when values actually change
- Or only update FPS portion

#### 8. Building Tile Rotation Per Frame
**File:** `packages/world/src/tiles/tile-provider.ts`
**Lines:** 9-33

**Problem:**
```typescript
function rotateGrid90(grid: PixelGrid): PixelGrid {
  const result: PixelGrid = [];
  for (let x = 0; x < width; x++) {
    const row: Pixel[] = [];
    for (let y = height - 1; y >= 0; y--) {
      row.push(grid[y]?.[x] ?? null);
    }
    result.push(row);
  }
  return result;
}
```

**Details:**
- When camera is rotated (90°, 180°, 270°), building sprites must rotate
- This happens at render time, not load time
- 256×256 pixel rotation = 65,536 array operations per building

**Suggested Fix:**
- Pre-rotate all building sprites to all 4 directions at load time
- Store rotated versions in memory cache
- Select correct pre-rotated version at render time

#### 9. Full Screen Background Fill on Resize
**File:** `packages/render/src/pixel/pixel-game-renderer.ts`
**Lines:** 257-262

**Problem:**
```typescript
private fillScreenBackground(): void {
  for (let row = 1; row <= this.rows; row++) {
    this.stream.write(`${ESC}[${row};1H${brandBg}${' '.repeat(this.cols)}`);
  }
}
```

**Details:**
- 24-40 individual `stream.write()` calls
- Each write has syscall overhead
- Could be batched into single write

**Suggested Fix:**
```typescript
const lines = [];
for (let row = 1; row <= this.rows; row++) {
  lines.push(`${ESC}[${row};1H${brandBg}${' '.repeat(this.cols)}`);
}
this.stream.write(lines.join(''));
```

### MEDIUM PRIORITY - Monitoring Needed

#### 10. Scaled Frame Cache Size
**File:** `packages/render/src/pixel/viewport-renderer.ts`
**Lines:** 124-127

**Current:**
```typescript
private scaledFrameCache: Map<string, PixelGrid> = new Map();
private readonly MAX_CACHE_SIZE = 500;
```

**Details:**
- Caches scaled sprite frames (player animations at different zoom levels)
- 500 entries × 256×256 pixels × 4 bytes = potentially 128MB
- No monitoring of hit rate or eviction frequency

**Suggested Fix:**
- Add cache hit/miss counters
- Log cache stats periodically
- Consider LRU eviction based on access time, not just count

#### 11. Chunk Cache Stats Not Monitored
**File:** `packages/world/src/chunk/chunk-cache.ts`

**Details:**
- Has `getStats()` method but it's never called
- No visibility into cache hit rate
- Could be thrashing without anyone knowing

**Suggested Fix:**
- Log cache stats every 60 seconds
- Alert if hit rate drops below threshold

## Database Schema (Relevant Tables)

```sql
-- Users and authentication
users (id, username, created_at, last_seen_at)
user_keys (id, user_id, fingerprint_sha256, last_used_at)

-- Player state
player_state (id, user_id, x, y, direction, created_at, updated_at)

-- Avatar sprites (AI-generated)
avatars (id, user_id, prompt, sprite_json, generation_status, created_at)
sprite_frames (id, user_id, direction, frame_num, resolution, file_path, width, height)

-- Buildings (AI-generated)
buildings (id, user_id, anchor_x, anchor_y, prompt, width, height, created_at)
building_tiles (id, building_id, tile_x, tile_y, resolution, direction, file_path)

-- World
world (id, seed, name, created_at)
```

## Current Performance Metrics

After latest deploy:
- **Baseline memory**: 55MB heap
- **Tick interval**: 67ms (15 FPS target)
- **Frame size**: 5-50KB typical, 200KB max
- **DB connections**: 20 pool, 30s idle timeout

## File Locations

| Component | File Path |
|-----------|-----------|
| SSH Server | `apps/ssh-world/src/server/ssh-server.ts` |
| Game Session | `apps/ssh-world/src/server/game-session.ts` |
| Stats Server | `apps/ssh-world/src/server/stats-server.ts` |
| Worker Manager | `apps/ssh-world/src/server/worker-manager.ts` |
| Game Worker | `apps/ssh-world/src/worker/game-worker.ts` |
| Pixel Renderer | `packages/render/src/pixel/pixel-game-renderer.ts` |
| Viewport Renderer | `packages/render/src/pixel/viewport-renderer.ts` |
| Tile Provider | `packages/world/src/tiles/tile-provider.ts` |
| Chunk Cache | `packages/world/src/chunk/chunk-cache.ts` |
| Building Storage | `apps/ssh-world/src/utils/building-storage.ts` |
| Sprite Storage | `apps/ssh-world/src/utils/sprite-storage.ts` |

## Endpoints

- **SSH Game**: `ssh abyss.maldoror.dev` (port 22)
- **Health**: `https://abyss.maldoror.dev/health`
- **Stats**: `https://abyss.maldoror.dev/stats`
- **Logs**: `https://abyss.maldoror.dev/logs`
- **HAProxy Stats**: `http://134.199.180.251:8404/stats`

## Technologies

- **Runtime**: Node.js 20 (ESM)
- **SSH**: ssh2 library
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Build**: TypeScript, Turbo monorepo, pnpm
- **Deploy**: Docker Compose on Hetzner VPS
- **SSL**: Caddy (auto HTTPS)
- **Load Balancer**: HAProxy (TCP mode for SSH)

## Success Metrics

1. **Frame latency**: < 50ms per frame (currently unknown)
2. **Memory stability**: No growth over 24h session
3. **No crashes**: 24h+ uptime without restart
4. **Smooth streaming**: No visible stutter when moving
5. **Multi-player**: 20+ concurrent players without degradation
