/**
 * Deterministic pseudo-random number generator using xorshift128+
 */
export class SeededRandom {
  private s0: bigint;
  private s1: bigint;

  constructor(seed: bigint) {
    // Initialize state from seed using splitmix64
    let state = seed;

    state = ((state ^ (state >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    this.s0 = state;

    state = ((state ^ (state >> 30n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    this.s1 = state;
  }

  /**
   * Generate next random number in [0, 1)
   */
  next(): number {
    const result = (this.s0 + this.s1) & 0xffffffffffffffffn;

    const s1 = this.s0 ^ this.s1;
    this.s0 = ((this.s0 << 55n) | (this.s0 >> 9n)) ^ s1 ^ (s1 << 14n);
    this.s0 = this.s0 & 0xffffffffffffffffn;
    this.s1 = ((s1 << 36n) | (s1 >> 28n)) & 0xffffffffffffffffn;

    // Convert to float in [0, 1)
    return Number(result & 0x1fffffffffffffn) / 0x20000000000000;
  }

  /**
   * Generate integer in [min, max]
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Clone the current state
   */
  clone(): SeededRandom {
    const rng = new SeededRandom(0n);
    rng.s0 = this.s0;
    rng.s1 = this.s1;
    return rng;
  }
}

/**
 * Simple 2D value noise implementation
 */
export class ValueNoise {
  private seed: bigint;
  private cache: Map<string, number> = new Map();

  constructor(seed: bigint) {
    this.seed = seed;
  }

  /**
   * Hash function for grid coordinates
   */
  private hash(x: number, y: number): number {
    const key = `${x},${y}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Combine coordinates with seed for unique hash
    const combinedSeed = this.seed ^ BigInt(x * 374761393 + y * 668265263);
    const rng = new SeededRandom(combinedSeed);
    const value = rng.next();

    // Cache for performance (limited size)
    if (this.cache.size < 10000) {
      this.cache.set(key, value);
    }

    return value;
  }

  /**
   * Smooth interpolation (smoothstep)
   */
  private smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
  }

  /**
   * Linear interpolation
   */
  private lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
  }

  /**
   * Sample noise at world coordinates with given frequency
   */
  sample(x: number, y: number, frequency: number = 1): number {
    const fx = x * frequency;
    const fy = y * frequency;

    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const tx = this.smoothstep(fx - x0);
    const ty = this.smoothstep(fy - y0);

    const v00 = this.hash(x0, y0);
    const v10 = this.hash(x1, y0);
    const v01 = this.hash(x0, y1);
    const v11 = this.hash(x1, y1);

    const v0 = this.lerp(v00, v10, tx);
    const v1 = this.lerp(v01, v11, tx);

    return this.lerp(v0, v1, ty);
  }

  /**
   * Fractal Brownian Motion - layered noise
   */
  fbm(
    x: number,
    y: number,
    octaves: number = 4,
    lacunarity: number = 2,
    persistence: number = 0.5
  ): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.sample(x, y, frequency);
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }

    return value / maxValue;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
