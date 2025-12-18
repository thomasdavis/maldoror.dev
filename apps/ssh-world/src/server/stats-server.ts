import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { db, schema } from '@maldoror/db';
import { sql, count, min, max } from 'drizzle-orm';
import type { WorkerManager } from './worker-manager.js';

interface StatsServerConfig {
  port: number;
  getSessionCount: () => number;
  workerManager: WorkerManager;
  worldSeed: bigint;
  startTime: Date;
}

interface WorldStats {
  server: {
    uptime_seconds: number;
    uptime_human: string;
    memory: {
      rss_mb: number;
      heap_used_mb: number;
      heap_total_mb: number;
      external_mb: number;
      array_buffers_mb: number;
    };
    active_sessions: number;
    node_version: string;
    started_at: string;
    pid: number;
    platform: string;
  };
  world: {
    seed: string;
    name: string;
    bounds: {
      min_x: number | null;
      max_x: number | null;
      min_y: number | null;
      max_y: number | null;
      width: number | null;
      height: number | null;
      area_tiles: number | null;
    };
  };
  players: {
    total_registered: number;
    online_now: number;
    with_avatars: number;
  };
  buildings: {
    total_placed: number;
    total_tiles: number;
  };
  sprites: {
    total_frames: number;
    unique_users_with_sprites: number;
  };
  database: {
    users: number;
    user_keys: number;
    avatars: number;
    player_states: number;
    buildings: number;
    building_tiles: number;
    sprite_frames: number;
  };
}

export class StatsServer {
  private server: ReturnType<typeof createServer>;
  private config: StatsServerConfig;

  constructor(config: StatsServerConfig) {
    this.config = config;
    this.server = createServer(this.handleRequest.bind(this));
  }

  start(): void {
    this.server.listen(this.config.port, '0.0.0.0', () => {
      console.log(`Stats server listening on http://0.0.0.0:${this.config.port}/stats`);
    });
  }

  stop(): void {
    this.server.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/stats' || url.pathname === '/stats/') {
      try {
        const stats = await this.gatherStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats, null, 2));
      } catch (error) {
        console.error('Error gathering stats:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to gather stats' }));
      }
    } else if (url.pathname === '/health' || url.pathname === '/health/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Not found',
        endpoints: ['/stats', '/health']
      }));
    }
  }

  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
  }

  private async gatherStats(): Promise<WorldStats> {
    const uptimeSeconds = (Date.now() - this.config.startTime.getTime()) / 1000;
    const memUsage = process.memoryUsage();

    // Get world info
    const worldRecord = await db.query.world.findFirst();

    // Get player position bounds (shows explored area)
    const boundsResult = await db
      .select({
        minX: min(schema.playerState.x),
        maxX: max(schema.playerState.x),
        minY: min(schema.playerState.y),
        maxY: max(schema.playerState.y),
      })
      .from(schema.playerState);
    const bounds = boundsResult[0];

    // Count queries
    const [
      usersCount,
      userKeysCount,
      avatarsCount,
      playerStatesCount,
      buildingsCount,
      buildingTilesCount,
      spriteFramesCount,
    ] = await Promise.all([
      db.select({ count: count() }).from(schema.users),
      db.select({ count: count() }).from(schema.userKeys),
      db.select({ count: count() }).from(schema.avatars),
      db.select({ count: count() }).from(schema.playerState),
      db.select({ count: count() }).from(schema.buildings),
      db.select({ count: count() }).from(schema.buildingTiles),
      db.select({ count: count() }).from(schema.spriteFrames),
    ]);

    // Get unique users with sprites
    const uniqueSpriteUsers = await db
      .select({ count: sql<number>`count(distinct ${schema.spriteFrames.userId})` })
      .from(schema.spriteFrames);

    // Get online players from worker manager
    const onlinePlayers = await this.config.workerManager.getAllPlayers();
    const onlineCount = onlinePlayers.filter(p => p.isOnline).length;

    const width = bounds?.maxX != null && bounds?.minX != null ? bounds.maxX - bounds.minX + 1 : null;
    const height = bounds?.maxY != null && bounds?.minY != null ? bounds.maxY - bounds.minY + 1 : null;

    return {
      server: {
        uptime_seconds: Math.floor(uptimeSeconds),
        uptime_human: this.formatUptime(uptimeSeconds),
        memory: {
          rss_mb: Math.round(memUsage.rss / 1024 / 1024),
          heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
          external_mb: Math.round(memUsage.external / 1024 / 1024),
          array_buffers_mb: Math.round(memUsage.arrayBuffers / 1024 / 1024),
        },
        active_sessions: this.config.getSessionCount(),
        node_version: process.version,
        started_at: this.config.startTime.toISOString(),
        pid: process.pid,
        platform: process.platform,
      },
      world: {
        seed: worldRecord?.seed?.toString() || 'unknown',
        name: worldRecord?.name || 'Maldoror',
        bounds: {
          min_x: bounds?.minX ?? null,
          max_x: bounds?.maxX ?? null,
          min_y: bounds?.minY ?? null,
          max_y: bounds?.maxY ?? null,
          width,
          height,
          area_tiles: width && height ? width * height : null,
        },
      },
      players: {
        total_registered: usersCount[0]?.count ?? 0,
        online_now: onlineCount,
        with_avatars: avatarsCount[0]?.count ?? 0,
      },
      buildings: {
        total_placed: buildingsCount[0]?.count ?? 0,
        total_tiles: buildingTilesCount[0]?.count ?? 0,
      },
      sprites: {
        total_frames: spriteFramesCount[0]?.count ?? 0,
        unique_users_with_sprites: Number(uniqueSpriteUsers[0]?.count ?? 0),
      },
      database: {
        users: usersCount[0]?.count ?? 0,
        user_keys: userKeysCount[0]?.count ?? 0,
        avatars: avatarsCount[0]?.count ?? 0,
        player_states: playerStatesCount[0]?.count ?? 0,
        buildings: buildingsCount[0]?.count ?? 0,
        building_tiles: buildingTilesCount[0]?.count ?? 0,
        sprite_frames: spriteFramesCount[0]?.count ?? 0,
      },
    };
  }
}
