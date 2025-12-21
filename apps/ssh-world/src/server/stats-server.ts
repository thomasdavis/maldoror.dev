import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { db, schema } from '@maldoror/db';
import { sql, count, min, max } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkerManager } from './worker-manager.js';
import { resourceMonitor } from '../utils/resource-monitor.js';

// Asset directories
const BUILDINGS_DIR = process.env.BUILDINGS_DIR || '/app/buildings';
const SPRITES_DIR = process.env.SPRITES_DIR || '/app/sprites';

// Log capture ring buffer
const MAX_LOG_LINES = 2000;
const logBuffer: { timestamp: Date; level: string; message: string }[] = [];

function captureLog(level: string, ...args: unknown[]): void {
  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');

  logBuffer.push({ timestamp: new Date(), level, message });

  // Trim buffer if too large
  while (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }
}

// Intercept console methods
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);

console.log = (...args: unknown[]) => {
  captureLog('INFO', ...args);
  originalLog(...args);
};

console.error = (...args: unknown[]) => {
  captureLog('ERROR', ...args);
  originalError(...args);
};

console.warn = (...args: unknown[]) => {
  captureLog('WARN', ...args);
  originalWarn(...args);
};

// Export for external access
export function getLogs(): typeof logBuffer {
  return logBuffer;
}

interface TransportMetrics {
  queuedBytes: number;
  droppedFrames: number;
  drainCount: number;
  totalBytesWritten: number;
}

interface StatsServerConfig {
  port: number;
  getSessionCount: () => number;
  getTransportMetrics?: () => TransportMetrics[];  // Returns metrics from all active sessions
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
  transport?: {
    total_sessions: number;
    total_queued_bytes: number;
    total_dropped_frames: number;
    total_drain_events: number;
    total_bytes_written: number;
    peak_queued_bytes: number;
  };
}

// Cache stats for 30 seconds to avoid hammering DB
const STATS_CACHE_TTL_MS = 30000;

export class StatsServer {
  private server: ReturnType<typeof createServer>;
  private config: StatsServerConfig;
  private statsCache: { data: WorldStats; timestamp: number } | null = null;

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
        const stats = await this.getCachedStats();
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
    } else if (url.pathname === '/operations' || url.pathname === '/operations/') {
      // Check for active generation operations (used by deploy script)
      const activeOps = resourceMonitor.getActiveOperations();
      const hasActiveGenerations = resourceMonitor.hasActiveGenerations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        active_operations: activeOps,
        has_active_generations: hasActiveGenerations,
        safe_to_deploy: !hasActiveGenerations,
        timestamp: new Date().toISOString(),
      }));
    } else if (url.pathname === '/logs' || url.pathname === '/logs/') {
      this.serveLogsPage(req, res, url);
    } else if (url.pathname === '/files' || url.pathname === '/files/') {
      // File browser index
      this.serveFileBrowserIndex(res);
    } else if (url.pathname.startsWith('/files/buildings')) {
      // Serve buildings directory
      await this.serveAssetPath(req, res, url.pathname.replace('/files/buildings', ''), BUILDINGS_DIR, 'buildings');
    } else if (url.pathname.startsWith('/files/sprites')) {
      // Serve sprites directory
      await this.serveAssetPath(req, res, url.pathname.replace('/files/sprites', ''), SPRITES_DIR, 'sprites');
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Not found',
        endpoints: ['/stats', '/health', '/operations', '/logs', '/files', '/files/buildings', '/files/sprites']
      }));
    }
  }

  private serveLogsPage(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    // Check for JSON format
    const format = url.searchParams.get('format');
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logBuffer, null, 2));
      return;
    }

    // Check for plain text format
    if (format === 'text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const text = logBuffer.map(entry => {
        const ts = entry.timestamp.toISOString().replace('T', ' ').replace('Z', '');
        return `[${ts}] [${entry.level}] ${entry.message}`;
      }).join('\n');
      res.end(text);
      return;
    }

    // Filter by level
    const levelFilter = url.searchParams.get('level')?.toUpperCase();
    const filteredLogs = levelFilter
      ? logBuffer.filter(entry => entry.level === levelFilter)
      : logBuffer;

    // Auto-refresh interval (default 5 seconds)
    const refresh = parseInt(url.searchParams.get('refresh') || '5', 10);

    const escapeHtml = (str: string): string => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };

    const formatTimestamp = (date: Date): string => {
      return date.toISOString().replace('T', ' ').replace('Z', '');
    };

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${refresh}">
  <title>Maldoror Server Logs</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      margin: 0;
      padding: 20px;
      line-height: 1.4;
      font-size: 12px;
    }
    h1 { color: #ff9900; margin-bottom: 5px; font-size: 1.4em; }
    .subtitle { color: #666; margin-bottom: 15px; font-size: 0.9em; }
    .controls {
      display: flex;
      gap: 15px;
      margin-bottom: 15px;
      flex-wrap: wrap;
      align-items: center;
    }
    .controls a, .controls select {
      background: #1a1a25;
      color: #66aaff;
      padding: 6px 12px;
      border-radius: 4px;
      text-decoration: none;
      border: 1px solid #333;
      font-size: 0.85em;
    }
    .controls a:hover { background: #252535; }
    .controls a.active { background: #333; color: #fff; }
    .controls select { cursor: pointer; }
    .stats {
      color: #888;
      font-size: 0.85em;
    }
    .log-container {
      background: #0d0d12;
      border: 1px solid #222;
      border-radius: 8px;
      overflow: auto;
      max-height: calc(100vh - 180px);
    }
    .log-entry {
      padding: 4px 12px;
      border-bottom: 1px solid #1a1a1f;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-entry:hover { background: #151520; }
    .log-entry:last-child { border-bottom: none; }
    .log-timestamp { color: #555; margin-right: 10px; }
    .log-level {
      display: inline-block;
      width: 50px;
      font-weight: bold;
      margin-right: 10px;
    }
    .log-message { color: #ccc; }
    .level-ERROR { color: #ff6b6b; }
    .level-WARN { color: #ffd93d; }
    .level-INFO { color: #6bcb77; }
    .empty { color: #666; padding: 40px; text-align: center; }
    .scroll-bottom {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: #fff;
      padding: 10px 15px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85em;
      border: none;
    }
    .scroll-bottom:hover { background: #444; }
  </style>
</head>
<body>
  <h1>Server Logs</h1>
  <p class="subtitle">Auto-refreshes every ${refresh}s • Last ${filteredLogs.length} entries</p>

  <div class="controls">
    <a href="/logs" class="${!levelFilter ? 'active' : ''}">All</a>
    <a href="/logs?level=info" class="${levelFilter === 'INFO' ? 'active' : ''}">Info</a>
    <a href="/logs?level=warn" class="${levelFilter === 'WARN' ? 'active' : ''}">Warn</a>
    <a href="/logs?level=error" class="${levelFilter === 'ERROR' ? 'active' : ''}">Error</a>
    <span class="stats">|</span>
    <a href="/logs?format=json">JSON</a>
    <a href="/logs?format=text">Plain Text</a>
    <span class="stats">|</span>
    <span class="stats">Refresh:
      <a href="/logs?refresh=2${levelFilter ? '&level=' + levelFilter.toLowerCase() : ''}" class="${refresh === 2 ? 'active' : ''}">2s</a>
      <a href="/logs?refresh=5${levelFilter ? '&level=' + levelFilter.toLowerCase() : ''}" class="${refresh === 5 ? 'active' : ''}">5s</a>
      <a href="/logs?refresh=30${levelFilter ? '&level=' + levelFilter.toLowerCase() : ''}" class="${refresh === 30 ? 'active' : ''}">30s</a>
      <a href="/logs?refresh=0${levelFilter ? '&level=' + levelFilter.toLowerCase() : ''}" class="${refresh === 0 ? 'active' : ''}">off</a>
    </span>
  </div>

  <div class="log-container" id="logs">
    ${filteredLogs.length === 0 ? '<div class="empty">No logs yet</div>' : ''}
    ${filteredLogs.map(entry => `
      <div class="log-entry">
        <span class="log-timestamp">${formatTimestamp(entry.timestamp)}</span>
        <span class="log-level level-${entry.level}">${entry.level}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
      </div>
    `).join('')}
  </div>

  <button class="scroll-bottom" onclick="scrollToBottom()">↓ Scroll to Bottom</button>

  <script>
    function scrollToBottom() {
      const container = document.getElementById('logs');
      container.scrollTop = container.scrollHeight;
    }
    // Auto-scroll to bottom on load
    scrollToBottom();
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private serveFileBrowserIndex(res: ServerResponse): void {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Maldoror Asset Browser</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #ff9900; margin-bottom: 10px; }
    h2 { color: #66aaff; margin-top: 30px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    a { color: #66ff99; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .card {
      background: #151520;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 20px;
      margin: 10px 0;
    }
    .card h3 { margin-top: 0; color: #ff9900; }
  </style>
</head>
<body>
  <h1>Maldoror Asset Browser</h1>
  <p class="subtitle">Browse generated game assets</p>

  <div class="card">
    <h3>Buildings</h3>
    <p>AI-generated building sprites (3x3 tile grids, 4 directions each)</p>
    <a href="/files/buildings/">Browse Buildings →</a>
  </div>

  <div class="card">
    <h3>Sprites</h3>
    <p>Player avatar sprites (4 directions, 2 frames each)</p>
    <a href="/files/sprites/">Browse Sprites →</a>
  </div>

  <h2>API Endpoints</h2>
  <ul>
    <li><a href="/stats">/stats</a> - Server statistics (JSON)</li>
    <li><a href="/health">/health</a> - Health check</li>
  </ul>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private async serveAssetPath(
    _req: IncomingMessage,
    res: ServerResponse,
    subPath: string,
    baseDir: string,
    category: string
  ): Promise<void> {
    // Normalize and sanitize path
    const safePath = path.normalize(subPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(baseDir, safePath);

    // Prevent directory traversal
    if (!fullPath.startsWith(baseDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }

    try {
      const stat = await fs.promises.stat(fullPath);

      if (stat.isDirectory()) {
        await this.serveDirectoryListing(res, fullPath, `/files/${category}${safePath}`, category);
      } else if (stat.isFile()) {
        await this.serveFile(res, fullPath);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } else {
        console.error('Error serving asset:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    }
  }

  private async serveDirectoryListing(
    res: ServerResponse,
    dirPath: string,
    urlPath: string,
    _category: string
  ): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    // Get stats for all entries (dirs and files)
    const dirEntries = entries.filter(e => e.isDirectory());
    const fileEntries = entries.filter(e => e.isFile());

    // Get dir stats and sort by mtime (newest first)
    const dirInfos = await Promise.all(
      dirEntries.map(async (d) => {
        const stat = await fs.promises.stat(path.join(dirPath, d.name));
        return { name: d.name, mtime: stat.mtime };
      })
    );
    dirInfos.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    // Get file stats and sort by mtime (newest first)
    const fileInfos = await Promise.all(
      fileEntries.map(async (f) => {
        const stat = await fs.promises.stat(path.join(dirPath, f.name));
        return { name: f.name, size: stat.size, mtime: stat.mtime };
      })
    );
    fileInfos.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    const formatDate = (date: Date): string => {
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (seconds < 60) return 'just now';
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;
      if (days < 7) return `${days}d ago`;
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 365 ? 'numeric' : undefined });
    };

    // Build breadcrumb
    const pathParts = urlPath.split('/').filter(Boolean);
    let breadcrumb = '<a href="/files">files</a>';
    let buildPath = '/files';
    for (const part of pathParts.slice(1)) {
      buildPath += '/' + part;
      breadcrumb += ` / <a href="${buildPath}">${part}</a>`;
    }

    // Check for PNG preview grid
    const pngFiles = fileInfos.filter(f => f.name.endsWith('.png'));
    const showPreviewGrid = pngFiles.length > 0 && pngFiles.length <= 50;

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${urlPath} - Maldoror Assets</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #ff9900; margin-bottom: 5px; font-size: 1.2em; }
    .breadcrumb { color: #666; margin-bottom: 20px; }
    .breadcrumb a { color: #66aaff; text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    a { color: #66ff99; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .listing {
      background: #151520;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
    }
    .entry {
      padding: 10px 15px;
      border-bottom: 1px solid #222;
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 15px;
      align-items: center;
    }
    .entry:last-child { border-bottom: none; }
    .entry:hover { background: #1a1a25; }
    .dir { color: #66aaff; }
    .file { color: #66ff99; }
    .meta { color: #666; font-size: 0.85em; text-align: right; white-space: nowrap; }
    .icon { margin-right: 10px; }
    .preview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 15px;
      margin-top: 20px;
    }
    .preview-item {
      background: #151520;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 10px;
      text-align: center;
    }
    .preview-item img {
      max-width: 100%;
      height: auto;
      image-rendering: pixelated;
      background: repeating-conic-gradient(#222 0% 25%, #333 0% 50%) 50% / 10px 10px;
      border-radius: 4px;
    }
    .preview-item .name {
      font-size: 0.7em;
      color: #888;
      margin-top: 8px;
      word-break: break-all;
    }
    .section-title { color: #888; margin-top: 20px; font-size: 0.9em; }

    /* Lightbox styles */
    .lightbox {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.95);
      z-index: 1000;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .lightbox.active { display: flex; }
    .lightbox img {
      max-width: 90vw;
      max-height: 70vh;
      image-rendering: pixelated;
      background: repeating-conic-gradient(#222 0% 25%, #333 0% 50%) 50% / 10px 10px;
    }
    .lightbox-info {
      margin-top: 20px;
      text-align: center;
    }
    .lightbox-name { color: #fff; font-size: 1.1em; margin-bottom: 8px; }
    .lightbox-counter { color: #666; font-size: 0.9em; margin-bottom: 12px; }
    .lightbox-link {
      color: #66ff99;
      font-size: 0.85em;
      padding: 6px 12px;
      background: #1a1a25;
      border-radius: 4px;
      display: inline-block;
    }
    .lightbox-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      font-size: 3em;
      color: #666;
      cursor: pointer;
      padding: 20px;
      user-select: none;
    }
    .lightbox-nav:hover { color: #fff; }
    .lightbox-prev { left: 20px; }
    .lightbox-next { right: 20px; }
    .lightbox-close {
      position: absolute;
      top: 20px;
      right: 30px;
      font-size: 2em;
      color: #666;
      cursor: pointer;
    }
    .lightbox-close:hover { color: #fff; }
    .lightbox-hint {
      position: absolute;
      bottom: 20px;
      color: #444;
      font-size: 0.8em;
    }
  </style>
</head>
<body>
  <h1>Asset Browser</h1>
  <div class="breadcrumb">${breadcrumb}</div>

  <div class="listing">
    ${dirInfos.length === 0 && fileInfos.length === 0 ? '<div class="entry">Empty directory</div>' : ''}
    ${dirInfos.map(d => `
      <div class="entry">
        <span><span class="icon">📁</span><a href="${urlPath}/${d.name}" class="dir">${d.name}/</a></span>
        <span class="meta">—</span>
        <span class="meta">${formatDate(d.mtime)}</span>
      </div>
    `).join('')}
    ${fileInfos.map(f => `
      <div class="entry">
        <span><span class="icon">${f.name.endsWith('.png') ? '🖼️' : '📄'}</span><a href="${urlPath}/${f.name}" class="file">${f.name}</a></span>
        <span class="meta">${formatSize(f.size)}</span>
        <span class="meta">${formatDate(f.mtime)}</span>
      </div>
    `).join('')}
  </div>

  ${showPreviewGrid ? `
    <p class="section-title">Image Previews (click to enlarge)</p>
    <div class="preview-grid">
      ${pngFiles.map((f, i) => `
        <div class="preview-item" onclick="openLightbox(${i})" style="cursor:pointer">
          <img src="${urlPath}/${f.name}" alt="${f.name}" loading="lazy">
          <div class="name">${f.name}</div>
        </div>
      `).join('')}
    </div>

    <div class="lightbox" id="lightbox" onclick="if(event.target===this)closeLightbox()">
      <span class="lightbox-close" onclick="closeLightbox()">&times;</span>
      <span class="lightbox-nav lightbox-prev" onclick="navLightbox(-1)">&#8249;</span>
      <img id="lightbox-img" src="" alt="">
      <div class="lightbox-info">
        <div class="lightbox-name" id="lightbox-name"></div>
        <div class="lightbox-counter" id="lightbox-counter"></div>
        <a class="lightbox-link" id="lightbox-link" href="" target="_blank">Open direct link</a>
      </div>
      <span class="lightbox-nav lightbox-next" onclick="navLightbox(1)">&#8250;</span>
      <div class="lightbox-hint">← → arrow keys to navigate • ESC to close</div>
    </div>

    <script>
      const images = ${JSON.stringify(pngFiles.map(f => ({ name: f.name, url: `${urlPath}/${f.name}` })))};
      let currentIndex = 0;

      function openLightbox(index) {
        currentIndex = index;
        updateLightbox();
        document.getElementById('lightbox').classList.add('active');
      }

      function closeLightbox() {
        document.getElementById('lightbox').classList.remove('active');
      }

      function navLightbox(dir) {
        currentIndex = (currentIndex + dir + images.length) % images.length;
        updateLightbox();
      }

      function updateLightbox() {
        const img = images[currentIndex];
        document.getElementById('lightbox-img').src = img.url;
        document.getElementById('lightbox-name').textContent = img.name;
        document.getElementById('lightbox-counter').textContent = (currentIndex + 1) + ' / ' + images.length;
        document.getElementById('lightbox-link').href = img.url;
      }

      document.addEventListener('keydown', (e) => {
        const lb = document.getElementById('lightbox');
        if (!lb.classList.contains('active')) return;
        if (e.key === 'ArrowLeft') navLightbox(-1);
        if (e.key === 'ArrowRight') navLightbox(1);
        if (e.key === 'Escape') closeLightbox();
      });
    </script>
  ` : ''}
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private async serveFile(res: ServerResponse, filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.json': 'application/json',
      '.txt': 'text/plain',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    const data = await fs.promises.readFile(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(data);
  }

  /**
   * Get cached stats or refresh if stale (30s TTL)
   * Prevents DB hammering if /stats is polled frequently
   */
  private async getCachedStats(): Promise<WorldStats> {
    const now = Date.now();
    if (this.statsCache && (now - this.statsCache.timestamp) < STATS_CACHE_TTL_MS) {
      return this.statsCache.data;
    }

    const stats = await this.gatherStats();
    this.statsCache = { data: stats, timestamp: now };
    return stats;
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
      ...this.getTransportStats(),
    };
  }

  /**
   * Gather transport (SSH backpressure) metrics from all sessions
   */
  private getTransportStats(): { transport?: WorldStats['transport'] } {
    if (!this.config.getTransportMetrics) {
      return {};
    }

    const metrics = this.config.getTransportMetrics();
    if (metrics.length === 0) {
      return {};
    }

    // Aggregate metrics across all sessions
    let totalQueuedBytes = 0;
    let totalDroppedFrames = 0;
    let totalDrainEvents = 0;
    let totalBytesWritten = 0;
    let peakQueuedBytes = 0;

    for (const m of metrics) {
      totalQueuedBytes += m.queuedBytes;
      totalDroppedFrames += m.droppedFrames;
      totalDrainEvents += m.drainCount;
      totalBytesWritten += m.totalBytesWritten;
      if (m.queuedBytes > peakQueuedBytes) {
        peakQueuedBytes = m.queuedBytes;
      }
    }

    return {
      transport: {
        total_sessions: metrics.length,
        total_queued_bytes: totalQueuedBytes,
        total_dropped_frames: totalDroppedFrames,
        total_drain_events: totalDrainEvents,
        total_bytes_written: totalBytesWritten,
        peak_queued_bytes: peakQueuedBytes,
      },
    };
  }
}
