# Landscape Tiling & Rendering System

## Comprehensive Analysis & Path to Photorealism

---

## Part 1: Current State

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        WORLD GENERATION                          │
├─────────────────────────────────────────────────────────────────┤
│  World Seed (bigint)                                            │
│       ↓                                                         │
│  ChunkGenerator                                                 │
│       ├── Terrain Noise (0.02 freq, 4-octave FBM)              │
│       ├── Moisture Noise (0.024 freq, 3-octave FBM)            │
│       └── Detail Noise (0.1 freq)                               │
│       ↓                                                         │
│  Chunk Cache (LRU, 64 chunks × 16×16 tiles)                    │
│       ↓                                                         │
│  TileProvider → Tile Selection Logic                            │
│       ↓                                                         │
│  Base Tiles (256×256 → pre-scaled to 10 resolutions)           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                        RENDERING PIPELINE                        │
├─────────────────────────────────────────────────────────────────┤
│  ViewportRenderer                                                │
│       ├── 1. Terrain Tiles (base layer)                         │
│       ├── 2. Road Tiles (overlay)                               │
│       ├── 3. Building Tiles (overlay)                           │
│       └── 4. Entities (players/NPCs, Y-sorted)                  │
│       ↓                                                         │
│  PixelGameRenderer                                               │
│       ├── Mode: Normal (2×1) | Halfblock (1×2) | Braille (2×4) │
│       ├── Color Quantization (zoom-dependent)                   │
│       └── Cell Diffing (only changed cells output)              │
│       ↓                                                         │
│  ANSI Escape Codes → SSH Stream                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Terrain Generation Algorithm

**Current Implementation: Value Noise + FBM**

```typescript
// Biome selection from two noise channels
const elevation = noise.sample(worldX * 0.05, worldY * 0.05);
const moisture = noise.sample(worldX * 0.03 + 1000, worldY * 0.03 + 1000);

// Hard thresholds determine tile type
if (elevation < 0.30) return WATER;
if (elevation < 0.35) return SAND;
if (elevation > 0.75) return STONE;
if (moisture < 0.35) return DIRT;
return GRASS;
```

**Problems with Current Approach:**
1. Hard threshold boundaries create unnatural edges
2. Value noise produces "blobby" features (less natural than gradient noise)
3. No micro-detail within tiles (solid colors for performance)
4. No elevation-based shading or depth cues
5. Limited to 6 tile types

### Tile Palette

| Tile | RGB | Hex | Visual |
|------|-----|-----|--------|
| Grass | (34, 139, 34) | `#228B22` | Forest green, no variation |
| Dirt | (139, 90, 43) | `#8B5A2B` | Flat brown |
| Stone | (128, 128, 128) | `#808080` | Neutral gray |
| Water | (30, 100, 180) | `#1E64B4` | Deep blue, animated |
| Sand | (210, 180, 140) | `#D2B48C` | Tan/beige |
| Void | (10, 10, 15) | `#0A0A0F` | Near black |

### Resolution Pipeline

```
BASE_SIZE = 256×256 pixels

Pre-computed resolutions:
[26, 51, 77, 102, 128, 154, 179, 205, 230, 256]

Zoom 0%   → 26px tiles  (see vast area, low detail)
Zoom 50%  → 128px tiles (balanced)
Zoom 100% → 256px tiles (maximum detail)
```

### Performance Characteristics

| Metric | Current Value | Notes |
|--------|---------------|-------|
| Tile Generation | O(1) lookup | Pre-computed, cached |
| Chunk Generation | ~2ms | 256 noise samples |
| Scaling | Nearest-neighbor | No interpolation cost |
| Cache Hit Rate | ~95% | LRU working well |
| Edge Blending | DISABLED | Code exists, not used |
| Per-Pixel Variation | DISABLED | Solid colors only |

---

## Part 2: The Realism Gap

### What Makes Terrain Look Real

1. **Continuous Gradients** - Nature doesn't have hard edges
2. **Multi-Scale Detail** - Features at every zoom level
3. **Lighting & Shading** - Depth from elevation
4. **Color Temperature Variation** - Warm highlights, cool shadows
5. **Organic Noise** - Irregular, non-repeating patterns
6. **Contextual Blending** - Grass near water looks different

### Current Visual Limitations

```
CURRENT (Hard Boundaries):
┌────────────────────────────────────────┐
│ GRASS  GRASS  GRASS │ WATER  WATER     │  ← Jarring edge
│ GRASS  GRASS  GRASS │ WATER  WATER     │
│ GRASS  GRASS  GRASS │ WATER  WATER     │
└────────────────────────────────────────┘

REALISTIC (Soft Transitions):
┌────────────────────────────────────────┐
│ grass  grass  SAND   sand   WATER      │  ← Beach gradient
│ grass  GRASS  sand   SAND   water      │
│ GRASS  grass  SAND   sand   WATER      │
└────────────────────────────────────────┘
```

---

## Part 3: Photorealistic Techniques (Speed-First)

### Strategy 1: Gradient Threshold Blending

**Concept:** Instead of hard tile boundaries, create transition zones where tiles blend.

**Implementation:**

```typescript
// Instead of:
if (elevation < 0.30) return WATER;
if (elevation < 0.35) return SAND;

// Use blend zones:
const waterThreshold = 0.30;
const sandThreshold = 0.35;

if (elevation < waterThreshold - 0.02) {
  return WATER;  // Pure water
} else if (elevation < waterThreshold + 0.02) {
  // Blend zone: mix water and sand pixels
  const blend = (elevation - (waterThreshold - 0.02)) / 0.04;
  return blendTiles(WATER, SAND, blend);
} else if (elevation < sandThreshold) {
  return SAND;  // Pure sand
}
```

**Performance Cost:** Near-zero at tile level (pre-computed blends)

**Visual Impact:** ★★★★★ - Eliminates jarring edges

---

### Strategy 2: Elevation-Based Shading

**Concept:** Use the elevation noise value to darken/lighten tiles, creating depth.

```typescript
// Sample local elevation gradient
const elevHere = noise.sample(x, y);
const elevNorth = noise.sample(x, y - 1);
const elevWest = noise.sample(x - 1, y);

// Compute pseudo-normal (which way does surface face?)
const slopeX = elevHere - elevWest;
const slopeY = elevHere - elevNorth;

// Light from upper-left (classic game lighting)
const lightDir = { x: -0.7, y: -0.7 };
const brightness = 0.5 + 0.5 * (slopeX * lightDir.x + slopeY * lightDir.y);

// Apply to tile color
return modulateBrightness(baseTile, brightness);
```

**Pre-computation Strategy:**
- Generate 5 brightness variants per tile (0.6, 0.8, 1.0, 1.2, 1.4)
- Select variant at render time based on slope
- Total storage: 5× current = still tiny

**Performance Cost:** One multiply + lookup per tile

**Visual Impact:** ★★★★★ - Instant depth perception

---

### Strategy 3: Deterministic Micro-Variation

**Concept:** Add per-pixel variation that's position-seeded, so it's stable and cacheable.

```typescript
function generateTileWithVariation(tileType: TileType, worldX: number, worldY: number) {
  const baseColor = TILE_COLORS[tileType];
  const seed = hashPosition(worldX, worldY);
  const rng = seededRandom(seed);

  const pixels = [];
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      // Deterministic variation per pixel
      const localSeed = seed ^ (px * 31) ^ (py * 17);
      const variation = (fastHash(localSeed) % 20) - 10; // ±10 RGB

      pixels.push({
        r: clamp(baseColor.r + variation, 0, 255),
        g: clamp(baseColor.g + variation * 0.8, 0, 255), // Less green variation
        b: clamp(baseColor.b + variation * 0.6, 0, 255), // Even less blue
      });
    }
  }
  return pixels;
}
```

**Caching Strategy:**
- Key: `${tileType}:${worldX},${worldY}`
- Generate on first access, cache forever (LRU eviction)
- Pre-generate visible tiles during idle frames

**Performance Cost:** First-access only, then O(1)

**Visual Impact:** ★★★★☆ - Natural texture without patterns

---

### Strategy 4: Biome-Influenced Color Palettes

**Concept:** Adjust tile colors based on surrounding biome context.

```typescript
// Sample moisture in larger radius
const localMoisture = averageMoisture(worldX, worldY, radius: 5);
const temperature = 1.0 - (elevation * 0.5); // Higher = colder

// Grass color shifts based on climate
const grassPalette = {
  tropical:   { r: 20, g: 160, b: 20 },   // Vibrant green
  temperate:  { r: 34, g: 139, b: 34 },   // Forest green (current)
  arid:       { r: 90, g: 130, b: 50 },   // Yellow-green
  alpine:     { r: 60, g: 100, b: 60 },   // Muted green
};

const palette = selectPalette(temperature, localMoisture);
```

**Pre-computation:** Compute biome map at chunk level (16×16 values), interpolate per-tile

**Performance Cost:** One interpolation per tile

**Visual Impact:** ★★★★☆ - World feels cohesive, not random

---

### Strategy 5: Simplex Noise Upgrade

**Concept:** Replace value noise with simplex noise for more natural features.

**Why Simplex > Value Noise:**
- No grid-aligned artifacts
- Smoother gradients
- Computationally similar cost
- Better for terrain (designed for this purpose)

```typescript
// Current (value noise) - blobby features
const elevation = valueNoise.sample(x * 0.05, y * 0.05);

// Upgraded (simplex) - natural ridges and valleys
const elevation = simplexNoise.sample(x * 0.05, y * 0.05);
```

**Implementation:** Drop-in replacement, ~200 lines of code

**Performance Cost:** Identical to current

**Visual Impact:** ★★★★★ - Dramatically more natural terrain shapes

---

### Strategy 6: Distance-Based Detail (LOD)

**Concept:** Add detail proportional to zoom level, not globally.

```
Zoom 0-25%:   Solid colors, no variation (current behavior)
Zoom 25-50%:  Subtle color variation (±5 RGB)
Zoom 50-75%:  Medium variation (±10 RGB) + edge hints
Zoom 75-100%: Full detail (±15 RGB) + micro-texture
```

**Implementation:**
```typescript
const detailLevel = Math.floor(zoom / 25); // 0-4
const variationStrength = [0, 5, 10, 15, 20][detailLevel];

// Only compute expensive variation at high zoom
if (detailLevel > 0) {
  applyMicroVariation(tile, variationStrength);
}
```

**Performance Cost:** Zero at low zoom, gradual increase

**Visual Impact:** ★★★★☆ - Detail when you can see it, speed when you can't

---

### Strategy 7: Atmospheric Color Grading

**Concept:** Apply distance-based color shift for depth perception.

```typescript
// Tiles further from player appear slightly hazier
const distanceFromCenter = Math.sqrt(
  (tileX - playerX) ** 2 + (tileY - playerY) ** 2
);

// Subtle blue shift for distant tiles (atmospheric perspective)
const hazeAmount = Math.min(distanceFromCenter / 20, 0.15);
const hazedColor = {
  r: lerp(color.r, 150, hazeAmount),  // Toward gray-blue
  g: lerp(color.g, 160, hazeAmount),
  b: lerp(color.b, 180, hazeAmount),
};
```

**Performance Cost:** One lerp per tile (negligible)

**Visual Impact:** ★★★☆☆ - Subtle but adds depth

---

## Part 4: Implementation Roadmap

### Phase 1: Quick Wins (1-2 days)

| Change | Effort | Impact | Risk |
|--------|--------|--------|------|
| Enable per-pixel variation | Low | High | Low |
| Add 5 brightness variants | Low | High | Low |
| Soften biome thresholds | Low | High | Low |

**Expected Result:** Tiles feel textured, edges less harsh, sense of depth

### Phase 2: Core Upgrades (3-5 days)

| Change | Effort | Impact | Risk |
|--------|--------|--------|------|
| Implement simplex noise | Medium | Very High | Medium |
| Biome-influenced palettes | Medium | High | Low |
| Gradient threshold blending | Medium | Very High | Medium |

**Expected Result:** Terrain looks organic, biomes feel distinct

### Phase 3: Polish (5-7 days)

| Change | Effort | Impact | Risk |
|--------|--------|--------|------|
| LOD-based detail scaling | Medium | Medium | Low |
| Atmospheric color grading | Low | Medium | Low |
| Animated grass sway | High | Medium | Medium |
| Water reflections | High | High | High |

**Expected Result:** World feels alive and immersive

---

## Part 5: Performance Budget

### Current Baseline

```
Frame time budget: 16.6ms (60 FPS)
Current render time: ~3-5ms
Available headroom: ~11-13ms
```

### Proposed Allocation

```
Base tile lookup:        0.5ms  (current)
Brightness modulation:   0.3ms  (new)
Per-pixel variation:     0.5ms  (new, cached)
Biome interpolation:     0.2ms  (new)
Edge blending:           0.5ms  (new, selective)
─────────────────────────────────
Total render:            2.0ms

Remaining headroom:      14.6ms ✓
```

### Cache Memory Budget

```
Current:
- Chunk cache: 64 × 256 tiles = 16KB tile IDs
- Tile cache: 1024 × 256×256 = 67MB (if fully loaded)
- Scaled frames: 500 × ~10KB = 5MB

Proposed additions:
- Brightness variants: 5× tile storage = +335MB (too much!)
- Alternative: Generate on-demand, cache 1000 = +10MB ✓
- Biome map: 64 chunks × 16×16 = 16KB ✓
```

---

## Part 6: Code Snippets

### Enabling Existing Variation (Quick Win)

```typescript
// In base-tiles.ts, uncomment the variation code:

function generateGrassTile(seed: number): PixelGrid {
  const rand = seededRandom(seed);
  const grid: PixelGrid = [];

  for (let y = 0; y < BASE_SIZE; y++) {
    const row: Pixel[] = [];
    for (let x = 0; x < BASE_SIZE; x++) {
      // RE-ENABLE THIS:
      const colorChoice = rand();
      let color: RGB;
      if (colorChoice < 0.6) {
        color = GRASS_BASE;
      } else if (colorChoice < 0.8) {
        color = GRASS_LIGHT;
      } else if (colorChoice < 0.95) {
        color = GRASS_DARK;
      } else {
        color = GRASS_ACCENT;
      }
      row.push(color);
    }
    grid.push(row);
  }
  return grid;
}
```

### Simplex Noise Implementation

```typescript
// noise/simplex.ts
const GRAD3 = [
  [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
];

export class SimplexNoise {
  private perm: number[];

  constructor(seed: bigint) {
    this.perm = this.buildPermutation(seed);
  }

  sample(x: number, y: number): number {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;

    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);

    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;

    // ... (standard simplex implementation)

    return (n0 + n1 + n2) * 70; // Scale to [-1, 1]
  }
}
```

### Brightness Modulation

```typescript
// In viewport-renderer.ts

private modulateTileBrightness(
  pixels: PixelGrid,
  brightness: number
): PixelGrid {
  // Fast path: no modulation needed
  if (brightness > 0.95 && brightness < 1.05) return pixels;

  return pixels.map(row =>
    row.map(pixel => {
      if (!pixel) return null;
      return {
        r: Math.min(255, Math.round(pixel.r * brightness)),
        g: Math.min(255, Math.round(pixel.g * brightness)),
        b: Math.min(255, Math.round(pixel.b * brightness)),
      };
    })
  );
}
```

---

## Part 7: Visual Reference

### Target Aesthetic

```
NOT THIS (Current - Flat, Hard Edges):
╔══════════════════════════════════════╗
║▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║░░░░░░░░░░░░░░░░░░║
║▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║░░░░░░░░░░░░░░░░░░║
║▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║░░░░░░░░░░░░░░░░░░║
╚══════════════════════════════════════╝

THIS (Goal - Textured, Soft Transitions):
╔══════════════════════════════════════╗
║▓▓▓▒▓▓▓▓▒▓▓▓▒▓▓▒▒▒░▒░░░░▒░░░░░░▒░░░░░║
║▓▒▓▓▓▓▒▓▓▓▓▓▓▓▒▒▒▒░░░▒░░░░░░░░░░░░░▒░║
║▓▓▓▓▒▓▓▓▓▒▓▓▓▓▓▒▒░░░░░░░▒░░░░░░░░░░░░║
╚══════════════════════════════════════╝
  ↑ Varied grass    ↑ Beach fade    ↑ Varied water
```

### Color Ramp Examples

**Grass Biome Ramp (Dry → Wet):**
```
#8B9B50 → #6B8B30 → #228B22 → #1B7B1B → #156B15
 Arid     Savanna   Temperate  Lush      Jungle
```

**Elevation Shading (Valley → Peak):**
```
#1A5A1A → #228B22 → #2A9B2A → #32AB32 → #3ABB3A
 Shadow    Base      Lit       Highlight  Bright
```

---

## Conclusion

The current system is well-architected for performance but visually flat. By strategically enabling existing code (variation), adding pre-computed brightness variants, and implementing soft biome transitions, we can achieve near-photorealistic terrain while staying well within our performance budget.

**Priority Order:**
1. Enable per-pixel variation (exists, just disabled)
2. Add brightness/shading system
3. Implement gradient threshold blending
4. Upgrade to simplex noise
5. Add biome-influenced palettes

Each step is independent and incrementally improves visual quality without breaking what works.
