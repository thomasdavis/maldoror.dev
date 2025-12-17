import type { PixelGrid, RGB, Pixel } from '@maldoror/protocol';
import { BASE_SIZE, RESOLUTIONS } from '@maldoror/protocol';

/**
 * Advanced Procedural Tile Generator
 *
 * Creates beautiful, seamless terrain tiles with:
 * - Multi-octave noise for natural variation
 * - Domain warping for organic patterns
 * - Edge blending based on neighbor terrain types
 * - Tile-specific details (grass blades, water waves, stone cracks)
 */

// ============================================
// NOISE FUNCTIONS
// ============================================

/**
 * Fast hash function for coordinates
 */
function hash2D(x: number, y: number, seed: number = 0): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

/**
 * 2D gradient vectors for Perlin-style noise
 */
const GRADIENTS = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

function gradientAt(ix: number, iy: number, seed: number): number[] {
  const h = Math.floor(hash2D(ix, iy, seed) * GRADIENTS.length);
  return GRADIENTS[h % GRADIENTS.length]!;
}

/**
 * Quintic smoothstep for smoother interpolation
 */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Perlin-style gradient noise
 */
function gradientNoise(x: number, y: number, seed: number = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const tx = smootherstep(x - x0);
  const ty = smootherstep(y - y0);

  const g00 = gradientAt(x0, y0, seed);
  const g10 = gradientAt(x1, y0, seed);
  const g01 = gradientAt(x0, y1, seed);
  const g11 = gradientAt(x1, y1, seed);

  const d00 = (x - x0) * g00[0]! + (y - y0) * g00[1]!;
  const d10 = (x - x1) * g10[0]! + (y - y1) * g10[1]!;
  const d01 = (x - x0) * g01[0]! + (y - y1) * g01[1]!;
  const d11 = (x - x1) * g11[0]! + (y - y1) * g11[1]!;

  const ix0 = d00 + tx * (d10 - d00);
  const ix1 = d01 + tx * (d11 - d01);

  return (ix0 + ty * (ix1 - ix0)) * 0.5 + 0.5; // Normalize to [0, 1]
}

/**
 * Fractal Brownian Motion with gradient noise
 */
function fbm(
  x: number,
  y: number,
  octaves: number = 4,
  lacunarity: number = 2,
  persistence: number = 0.5,
  seed: number = 0
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * gradientNoise(x * frequency, y * frequency, seed + i * 1000);
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / maxValue;
}

/**
 * Domain warping - distorts coordinates using noise for organic patterns
 */
function warpedFbm(
  x: number,
  y: number,
  warpStrength: number = 0.5,
  octaves: number = 4,
  seed: number = 0
): number {
  // First pass of noise to warp coordinates
  const warpX = fbm(x, y, 2, 2, 0.5, seed + 100) * warpStrength;
  const warpY = fbm(x, y, 2, 2, 0.5, seed + 200) * warpStrength;

  // Second pass with warped coordinates
  return fbm(x + warpX, y + warpY, octaves, 2, 0.5, seed);
}

/**
 * Voronoi/cellular noise for stone cracks and patterns
 */
function voronoi(x: number, y: number, seed: number = 0): { dist: number; dist2: number; id: number } {
  const ix = Math.floor(x);
  const iy = Math.floor(y);

  let minDist = 999;
  let minDist2 = 999;
  let cellId = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;

      // Random point within cell
      const px = cx + hash2D(cx, cy, seed);
      const py = cy + hash2D(cx, cy, seed + 1000);

      const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);

      if (dist < minDist) {
        minDist2 = minDist;
        minDist = dist;
        cellId = Math.floor(hash2D(cx, cy, seed + 2000) * 1000);
      } else if (dist < minDist2) {
        minDist2 = dist;
      }
    }
  }

  return { dist: minDist, dist2: minDist2, id: cellId };
}

// ============================================
// COLOR UTILITIES
// ============================================

function rgb(r: number, g: number, b: number): RGB {
  return {
    r: Math.max(0, Math.min(255, Math.round(r))),
    g: Math.max(0, Math.min(255, Math.round(g))),
    b: Math.max(0, Math.min(255, Math.round(b))),
  };
}

function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return rgb(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t
  );
}

function adjustBrightness(color: RGB, factor: number): RGB {
  return rgb(color.r * factor, color.g * factor, color.b * factor);
}

// ============================================
// TILE TYPE DEFINITIONS
// ============================================

export type TerrainType = 'grass' | 'dirt' | 'stone' | 'water' | 'sand' | 'void';

interface TerrainPalette {
  base: RGB;
  light: RGB;
  dark: RGB;
  accent: RGB;
  detail?: RGB;
}

const PALETTES: Record<TerrainType, TerrainPalette> = {
  grass: {
    base: rgb(46, 125, 50),      // Rich green
    light: rgb(76, 175, 80),     // Light green
    dark: rgb(27, 94, 32),       // Dark green
    accent: rgb(104, 159, 56),   // Yellow-green
    detail: rgb(139, 195, 74),   // Bright accent for flowers
  },
  dirt: {
    base: rgb(121, 85, 72),      // Brown
    light: rgb(161, 136, 127),   // Light brown
    dark: rgb(78, 52, 46),       // Dark brown
    accent: rgb(141, 110, 99),   // Reddish brown
    detail: rgb(93, 64, 55),     // Deep brown
  },
  stone: {
    base: rgb(117, 117, 117),    // Gray
    light: rgb(158, 158, 158),   // Light gray
    dark: rgb(66, 66, 66),       // Dark gray
    accent: rgb(97, 97, 97),     // Medium gray
    detail: rgb(189, 189, 189),  // Highlights
  },
  water: {
    base: rgb(33, 150, 243),     // Blue
    light: rgb(100, 181, 246),   // Light blue
    dark: rgb(21, 101, 192),     // Deep blue
    accent: rgb(144, 202, 249),  // Foam/shimmer
    detail: rgb(255, 255, 255),  // Highlights
  },
  sand: {
    base: rgb(255, 224, 178),    // Sandy beige
    light: rgb(255, 245, 224),   // Light sand
    dark: rgb(255, 183, 77),     // Wet sand
    accent: rgb(255, 213, 79),   // Golden
    detail: rgb(188, 170, 164),  // Shells/pebbles
  },
  void: {
    base: rgb(18, 18, 24),
    light: rgb(30, 30, 40),
    dark: rgb(8, 8, 12),
    accent: rgb(40, 40, 55),
  },
};

// ============================================
// NEIGHBOR INFORMATION
// ============================================

export interface NeighborInfo {
  north?: TerrainType;
  south?: TerrainType;
  east?: TerrainType;
  west?: TerrainType;
  northEast?: TerrainType;
  northWest?: TerrainType;
  southEast?: TerrainType;
  southWest?: TerrainType;
}

// ============================================
// TILE GENERATORS
// ============================================

/**
 * Generate grass tile with blade details and natural variation
 */
function generateGrass(
  worldX: number,
  worldY: number,
  localX: number,
  localY: number,
  seed: number,
  neighbors: NeighborInfo
): RGB {
  const palette = PALETTES.grass;
  const wx = worldX + localX / BASE_SIZE;
  const wy = worldY + localY / BASE_SIZE;

  // Base terrain using warped FBM for organic look
  const baseNoise = warpedFbm(wx * 3, wy * 3, 0.4, 4, seed);

  // Individual grass blade effect
  const bladeNoise = fbm(wx * 20, wy * 20, 2, 2, 0.6, seed + 500);
  const bladePattern = Math.pow(bladeNoise, 0.7);

  // Clumping - areas of denser grass
  const clumpNoise = fbm(wx * 1.5, wy * 1.5, 3, 2, 0.5, seed + 1000);

  // Combine for final value
  let value = baseNoise * 0.4 + bladePattern * 0.4 + clumpNoise * 0.2;

  // Add occasional flowers/highlights
  const flowerNoise = hash2D(Math.floor(wx * 30), Math.floor(wy * 30), seed + 2000);
  const hasFlower = flowerNoise > 0.97;

  // Pick base color
  let color: RGB;
  if (value < 0.35) {
    color = lerpColor(palette.dark, palette.base, value / 0.35);
  } else if (value < 0.65) {
    color = lerpColor(palette.base, palette.light, (value - 0.35) / 0.3);
  } else {
    color = lerpColor(palette.light, palette.accent, (value - 0.65) / 0.35);
  }

  // Add flower highlights
  if (hasFlower && palette.detail) {
    const flowerColor = hash2D(Math.floor(wx * 30), Math.floor(wy * 30), seed + 3000);
    if (flowerColor > 0.5) {
      color = lerpColor(color, palette.detail, 0.7);
    } else {
      color = lerpColor(color, rgb(255, 235, 59), 0.6); // Yellow flowers
    }
  }

  // Apply edge blending with neighbors
  color = applyEdgeBlending(color, localX, localY, neighbors, 'grass');

  return color;
}

/**
 * Generate dirt tile with rich earthy texture
 */
function generateDirt(
  worldX: number,
  worldY: number,
  localX: number,
  localY: number,
  seed: number,
  neighbors: NeighborInfo
): RGB {
  const palette = PALETTES.dirt;
  const wx = worldX + localX / BASE_SIZE;
  const wy = worldY + localY / BASE_SIZE;

  // Base terrain
  const baseNoise = warpedFbm(wx * 4, wy * 4, 0.3, 4, seed);

  // Pebble/detail noise
  const pebbleNoise = voronoi(wx * 15, wy * 15, seed + 100);
  const hasPebble = pebbleNoise.dist < 0.08;

  // Cracks and grooves
  const crackNoise = 1 - Math.abs(pebbleNoise.dist2 - pebbleNoise.dist);
  const crackValue = Math.pow(crackNoise, 3);

  // Root-like patterns
  const rootNoise = fbm(wx * 8, wy * 8, 3, 2.5, 0.4, seed + 500);

  let value = baseNoise * 0.5 + crackValue * 0.2 + rootNoise * 0.3;

  let color: RGB;
  if (value < 0.4) {
    color = lerpColor(palette.dark, palette.base, value / 0.4);
  } else if (value < 0.7) {
    color = lerpColor(palette.base, palette.light, (value - 0.4) / 0.3);
  } else {
    color = lerpColor(palette.light, palette.accent, (value - 0.7) / 0.3);
  }

  // Pebble highlights
  if (hasPebble && palette.detail) {
    const pebbleShade = hash2D(pebbleNoise.id, 0, seed);
    color = lerpColor(color, palette.detail, 0.4 + pebbleShade * 0.3);
  }

  color = applyEdgeBlending(color, localX, localY, neighbors, 'dirt');

  return color;
}

/**
 * Generate stone tile with cracks and depth
 */
function generateStone(
  worldX: number,
  worldY: number,
  localX: number,
  localY: number,
  seed: number,
  neighbors: NeighborInfo
): RGB {
  const palette = PALETTES.stone;
  const wx = worldX + localX / BASE_SIZE;
  const wy = worldY + localY / BASE_SIZE;

  // Voronoi for stone blocks
  const stoneVoronoi = voronoi(wx * 4, wy * 4, seed);

  // Cracks between stones
  const crackWidth = stoneVoronoi.dist2 - stoneVoronoi.dist;
  const isCrack = crackWidth < 0.05;

  // Surface detail
  const surfaceNoise = warpedFbm(wx * 6, wy * 6, 0.2, 3, seed + 100);

  // Moss/lichen in cracks
  const mossNoise = fbm(wx * 2, wy * 2, 2, 2, 0.5, seed + 500);
  const hasMoss = mossNoise > 0.7 && crackWidth < 0.15;

  // Stone shade based on cell ID
  const stoneShade = hash2D(stoneVoronoi.id, 0, seed + 200);

  let color: RGB;
  if (isCrack) {
    color = palette.dark;
    if (hasMoss) {
      color = lerpColor(color, rgb(60, 80, 50), 0.5);
    }
  } else {
    const baseValue = surfaceNoise * 0.3 + stoneShade * 0.4 + 0.3;
    if (baseValue < 0.4) {
      color = lerpColor(palette.dark, palette.accent, baseValue / 0.4);
    } else if (baseValue < 0.7) {
      color = lerpColor(palette.accent, palette.base, (baseValue - 0.4) / 0.3);
    } else {
      color = lerpColor(palette.base, palette.light, (baseValue - 0.7) / 0.3);
    }

    // Highlight on one edge (pseudo-3D)
    const highlight = fbm(wx * 4 + 0.2, wy * 4 + 0.2, 2, 2, 0.5, seed);
    if (highlight > surfaceNoise + 0.15 && palette.detail) {
      color = lerpColor(color, palette.detail, 0.2);
    }
  }

  color = applyEdgeBlending(color, localX, localY, neighbors, 'stone');

  return color;
}

/**
 * Generate water tile with waves and depth
 */
function generateWater(
  worldX: number,
  worldY: number,
  localX: number,
  localY: number,
  seed: number,
  neighbors: NeighborInfo,
  tick: number = 0
): RGB {
  const palette = PALETTES.water;
  const wx = worldX + localX / BASE_SIZE;
  const wy = worldY + localY / BASE_SIZE;

  // Animated offset for waves
  const timeOffset = tick * 0.02;

  // Large wave patterns
  const wave1 = Math.sin((wx * 3 + timeOffset) * Math.PI * 2) * 0.5 + 0.5;
  const wave2 = Math.sin((wy * 2.5 - timeOffset * 0.7) * Math.PI * 2) * 0.5 + 0.5;

  // Smaller ripples
  const ripple = fbm(wx * 8 + timeOffset, wy * 8 - timeOffset * 0.5, 3, 2, 0.5, seed);

  // Depth variation
  const depth = warpedFbm(wx * 2, wy * 2, 0.3, 3, seed + 100);

  // Combine
  const waveValue = wave1 * 0.3 + wave2 * 0.3 + ripple * 0.25 + depth * 0.15;

  let color: RGB;
  if (depth < 0.3) {
    // Deep water
    color = lerpColor(palette.dark, palette.base, waveValue);
  } else if (depth < 0.6) {
    color = lerpColor(palette.base, palette.light, waveValue);
  } else {
    color = lerpColor(palette.light, palette.accent, waveValue);
  }

  // Foam/shimmer highlights
  const shimmer = fbm(wx * 15 + timeOffset * 2, wy * 15 - timeOffset, 2, 2, 0.6, seed + 500);
  if (shimmer > 0.8 && palette.detail) {
    color = lerpColor(color, palette.detail, (shimmer - 0.8) * 3);
  }

  // Shore foam near non-water neighbors
  const shoreBlend = getShoreBlend(localX, localY, neighbors);
  if (shoreBlend > 0 && palette.accent) {
    const foamNoise = fbm(wx * 20 + timeOffset, wy * 20, 2, 2, 0.7, seed + 800);
    if (foamNoise > 0.5) {
      color = lerpColor(color, palette.accent, shoreBlend * 0.6);
    }
  }

  return color;
}

/**
 * Generate sand tile with ripples and shells
 */
function generateSand(
  worldX: number,
  worldY: number,
  localX: number,
  localY: number,
  seed: number,
  neighbors: NeighborInfo
): RGB {
  const palette = PALETTES.sand;
  const wx = worldX + localX / BASE_SIZE;
  const wy = worldY + localY / BASE_SIZE;

  // Wind ripple pattern
  const rippleAngle = fbm(wx * 0.5, wy * 0.5, 2, 2, 0.5, seed) * Math.PI;
  const rippleX = wx * Math.cos(rippleAngle) + wy * Math.sin(rippleAngle);
  const ripple = Math.sin(rippleX * 15) * 0.5 + 0.5;

  // Base variation
  const baseNoise = warpedFbm(wx * 3, wy * 3, 0.2, 3, seed + 100);

  // Combine
  let value = baseNoise * 0.5 + ripple * 0.4 + 0.1;

  // Shells and pebbles
  const shellNoise = hash2D(Math.floor(wx * 40), Math.floor(wy * 40), seed + 500);
  const hasShell = shellNoise > 0.98;

  let color: RGB;
  if (value < 0.4) {
    color = lerpColor(palette.dark, palette.base, value / 0.4);
  } else if (value < 0.7) {
    color = lerpColor(palette.base, palette.light, (value - 0.4) / 0.3);
  } else {
    color = lerpColor(palette.light, palette.accent, (value - 0.7) / 0.3);
  }

  // Shell detail
  if (hasShell && palette.detail) {
    color = lerpColor(color, palette.detail, 0.5);
  }

  // Wet sand near water
  const waterBlend = getWaterBlend(localX, localY, neighbors);
  if (waterBlend > 0) {
    color = lerpColor(color, adjustBrightness(palette.dark, 0.8), waterBlend * 0.5);
  }

  color = applyEdgeBlending(color, localX, localY, neighbors, 'sand');

  return color;
}

/**
 * Generate void tile
 */
function generateVoid(
  worldX: number,
  worldY: number,
  localX: number,
  localY: number,
  seed: number
): RGB {
  const palette = PALETTES.void;
  const wx = worldX + localX / BASE_SIZE;
  const wy = worldY + localY / BASE_SIZE;

  const noise = fbm(wx * 2, wy * 2, 3, 2, 0.5, seed);

  if (noise < 0.4) {
    return lerpColor(palette.dark, palette.base, noise / 0.4);
  } else {
    return lerpColor(palette.base, palette.accent, (noise - 0.4) / 0.6);
  }
}

// ============================================
// EDGE BLENDING
// ============================================

/**
 * Calculate blend factor for edges based on local position
 */
function getEdgeBlendFactor(localX: number, localY: number, edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'): number {
  const blendWidth = BASE_SIZE * 0.15; // 15% blend zone
  const cornerBlendWidth = BASE_SIZE * 0.12;

  let factor = 0;

  switch (edge) {
    case 'n':
      factor = localY < blendWidth ? 1 - localY / blendWidth : 0;
      break;
    case 's':
      factor = localY > BASE_SIZE - blendWidth ? (localY - (BASE_SIZE - blendWidth)) / blendWidth : 0;
      break;
    case 'e':
      factor = localX > BASE_SIZE - blendWidth ? (localX - (BASE_SIZE - blendWidth)) / blendWidth : 0;
      break;
    case 'w':
      factor = localX < blendWidth ? 1 - localX / blendWidth : 0;
      break;
    case 'ne':
      if (localX > BASE_SIZE - cornerBlendWidth && localY < cornerBlendWidth) {
        const dx = (localX - (BASE_SIZE - cornerBlendWidth)) / cornerBlendWidth;
        const dy = 1 - localY / cornerBlendWidth;
        factor = Math.min(dx, dy);
      }
      break;
    case 'nw':
      if (localX < cornerBlendWidth && localY < cornerBlendWidth) {
        const dx = 1 - localX / cornerBlendWidth;
        const dy = 1 - localY / cornerBlendWidth;
        factor = Math.min(dx, dy);
      }
      break;
    case 'se':
      if (localX > BASE_SIZE - cornerBlendWidth && localY > BASE_SIZE - cornerBlendWidth) {
        const dx = (localX - (BASE_SIZE - cornerBlendWidth)) / cornerBlendWidth;
        const dy = (localY - (BASE_SIZE - cornerBlendWidth)) / cornerBlendWidth;
        factor = Math.min(dx, dy);
      }
      break;
    case 'sw':
      if (localX < cornerBlendWidth && localY > BASE_SIZE - cornerBlendWidth) {
        const dx = 1 - localX / cornerBlendWidth;
        const dy = (localY - (BASE_SIZE - cornerBlendWidth)) / cornerBlendWidth;
        factor = Math.min(dx, dy);
      }
      break;
  }

  // Smooth the blend
  return smootherstep(Math.max(0, Math.min(1, factor)));
}

/**
 * Apply edge blending with neighboring tiles
 */
function applyEdgeBlending(
  color: RGB,
  localX: number,
  localY: number,
  neighbors: NeighborInfo,
  currentType: TerrainType
): RGB {
  let result = color;

  // Cardinal directions
  if (neighbors.north && neighbors.north !== currentType) {
    const factor = getEdgeBlendFactor(localX, localY, 'n');
    if (factor > 0) {
      result = lerpColor(result, PALETTES[neighbors.north].base, factor * 0.5);
    }
  }
  if (neighbors.south && neighbors.south !== currentType) {
    const factor = getEdgeBlendFactor(localX, localY, 's');
    if (factor > 0) {
      result = lerpColor(result, PALETTES[neighbors.south].base, factor * 0.5);
    }
  }
  if (neighbors.east && neighbors.east !== currentType) {
    const factor = getEdgeBlendFactor(localX, localY, 'e');
    if (factor > 0) {
      result = lerpColor(result, PALETTES[neighbors.east].base, factor * 0.5);
    }
  }
  if (neighbors.west && neighbors.west !== currentType) {
    const factor = getEdgeBlendFactor(localX, localY, 'w');
    if (factor > 0) {
      result = lerpColor(result, PALETTES[neighbors.west].base, factor * 0.5);
    }
  }

  return result;
}

/**
 * Get shore blend factor for water near land
 */
function getShoreBlend(localX: number, localY: number, neighbors: NeighborInfo): number {
  const landTypes: TerrainType[] = ['grass', 'dirt', 'stone', 'sand'];
  let maxBlend = 0;

  const checkNeighbor = (neighbor: TerrainType | undefined, edge: 'n' | 's' | 'e' | 'w') => {
    if (neighbor && landTypes.includes(neighbor)) {
      maxBlend = Math.max(maxBlend, getEdgeBlendFactor(localX, localY, edge));
    }
  };

  checkNeighbor(neighbors.north, 'n');
  checkNeighbor(neighbors.south, 's');
  checkNeighbor(neighbors.east, 'e');
  checkNeighbor(neighbors.west, 'w');

  return maxBlend;
}

/**
 * Get water blend factor for sand near water
 */
function getWaterBlend(localX: number, localY: number, neighbors: NeighborInfo): number {
  let maxBlend = 0;

  const checkNeighbor = (neighbor: TerrainType | undefined, edge: 'n' | 's' | 'e' | 'w') => {
    if (neighbor === 'water') {
      maxBlend = Math.max(maxBlend, getEdgeBlendFactor(localX, localY, edge));
    }
  };

  checkNeighbor(neighbors.north, 'n');
  checkNeighbor(neighbors.south, 's');
  checkNeighbor(neighbors.east, 'e');
  checkNeighbor(neighbors.west, 'w');

  return maxBlend;
}

// ============================================
// MAIN GENERATOR
// ============================================

/**
 * Generate a single pixel for a terrain tile
 */
export function generateTerrainPixel(
  terrainType: TerrainType,
  worldTileX: number,
  worldTileY: number,
  localX: number,
  localY: number,
  seed: number,
  neighbors: NeighborInfo,
  tick: number = 0
): RGB {
  switch (terrainType) {
    case 'grass':
      return generateGrass(worldTileX, worldTileY, localX, localY, seed, neighbors);
    case 'dirt':
      return generateDirt(worldTileX, worldTileY, localX, localY, seed, neighbors);
    case 'stone':
      return generateStone(worldTileX, worldTileY, localX, localY, seed, neighbors);
    case 'water':
      return generateWater(worldTileX, worldTileY, localX, localY, seed, neighbors, tick);
    case 'sand':
      return generateSand(worldTileX, worldTileY, localX, localY, seed, neighbors);
    case 'void':
    default:
      return generateVoid(worldTileX, worldTileY, localX, localY, seed);
  }
}

/**
 * Generate a complete terrain tile
 */
export function generateProceduralTile(
  terrainType: TerrainType,
  worldTileX: number,
  worldTileY: number,
  seed: number,
  neighbors: NeighborInfo,
  tick: number = 0
): PixelGrid {
  const grid: PixelGrid = [];

  for (let y = 0; y < BASE_SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < BASE_SIZE; x++) {
      row.push(generateTerrainPixel(terrainType, worldTileX, worldTileY, x, y, seed, neighbors, tick));
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Downscale a pixel grid using area averaging for better quality
 */
function downscaleGrid(grid: PixelGrid, targetSize: number): PixelGrid {
  const srcSize = grid.length;
  if (srcSize === targetSize) return grid;

  const scale = srcSize / targetSize;
  const result: PixelGrid = [];

  for (let y = 0; y < targetSize; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < targetSize; x++) {
      // Area averaging for better downscale quality
      let r = 0, g = 0, b = 0, count = 0;

      const srcX0 = Math.floor(x * scale);
      const srcY0 = Math.floor(y * scale);
      const srcX1 = Math.min(srcSize - 1, Math.floor((x + 1) * scale));
      const srcY1 = Math.min(srcSize - 1, Math.floor((y + 1) * scale));

      for (let sy = srcY0; sy <= srcY1; sy++) {
        for (let sx = srcX0; sx <= srcX1; sx++) {
          const pixel = grid[sy]?.[sx];
          if (pixel) {
            r += pixel.r;
            g += pixel.g;
            b += pixel.b;
            count++;
          }
        }
      }

      if (count > 0) {
        row.push(rgb(r / count, g / count, b / count));
      } else {
        row.push(null);
      }
    }
    result.push(row);
  }

  return result;
}

/**
 * Generate all resolutions for a tile
 */
export function generateAllResolutions(grid: PixelGrid): Record<string, PixelGrid> {
  const resolutions: Record<string, PixelGrid> = {};
  for (const size of RESOLUTIONS) {
    resolutions[String(size)] = downscaleGrid(grid, size);
  }
  return resolutions;
}

/**
 * Generate water animation frames
 */
export function generateWaterAnimationFrames(
  worldTileX: number,
  worldTileY: number,
  seed: number,
  neighbors: NeighborInfo,
  frameCount: number = 4
): PixelGrid[] {
  const frames: PixelGrid[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    const tick = frame * 15; // Spread frames across animation cycle
    frames.push(generateProceduralTile('water', worldTileX, worldTileY, seed, neighbors, tick));
  }

  return frames;
}
