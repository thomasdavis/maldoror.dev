/**
 * Server version info - generated at build time
 * Run scripts/generate-version.sh to update
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

interface VersionInfo {
  hash: string;
  buildTime: string;
  version: string;
}

let cachedVersion: VersionInfo | null = null;

/**
 * Clear the cached version (call before getVersion to force re-read)
 */
export function refreshVersion(): void {
  cachedVersion = null;
}

export function getVersion(): VersionInfo {
  if (cachedVersion) return cachedVersion;

  try {
    // Try to read from version.json (in src dir during dev, or copied during deploy)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // Try multiple locations
    const locations = [
      path.join(__dirname, 'version.json'),           // dist/version.json
      path.join(__dirname, '../src/version.json'),    // src/version.json (dev)
      path.join(__dirname, '../../src/version.json'), // from dist/server/
    ];

    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        const content = fs.readFileSync(loc, 'utf-8');
        cachedVersion = JSON.parse(content);
        return cachedVersion!;
      }
    }
  } catch (error) {
    console.warn('Failed to read version.json:', error);
  }

  // Fallback
  cachedVersion = {
    hash: 'dev',
    buildTime: new Date().toISOString(),
    version: 'vdev',
  };
  return cachedVersion;
}
