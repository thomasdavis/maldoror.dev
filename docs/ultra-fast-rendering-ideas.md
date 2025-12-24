# Ultra-Fast Rendering & Network Latency Ideas

Three novel approaches for achieving ultra-low latency in terminal-based multiplayer games.

---

## 1. Probabilistic Pre-Rendering Pipeline

**Core Insight:** Don't wait for input—predict it and have the response ready.

### How It Works

Maintain a probability tree of likely player actions based on:
- Current movement direction and momentum
- Nearby terrain/obstacles
- Historical player behavior patterns

Pre-render the top 3-4 most likely next frames *before* the player presses a key. Store these as compressed diffs from current state.

```
Current Frame
    ├── 45% → Player continues walking (pre-rendered, 12 bytes diff)
    ├── 30% → Player stops (pre-rendered, 8 bytes diff)
    ├── 15% → Player turns left (pre-rendered, 89 bytes diff)
    └── 10% → Other (compute on demand)
```

When input arrives, check if it matches a prediction:
- **Hit:** Send pre-computed diff immediately (sub-millisecond response)
- **Miss:** Fall back to normal rendering (still fast, but not instant)

### Expected Impact
- 70-80% of frames become essentially zero-latency
- Pre-computation happens during idle cycles between ticks
- Network round-trip becomes irrelevant for predicted actions

---

## 2. Chromatic Run-Length Encoding (CRLE)

**Core Insight:** ANSI escape codes are verbose. A single color change is 15-20 bytes. Restructure output to minimize mode switches.

### How It Works

Instead of rendering left-to-right, top-to-bottom, render by **color layers**:

**Traditional approach:**
```
[set red]█[set blue]█[set red]█[set green]█[set red]█
= 5 color changes, ~100 bytes
```

**CRLE approach:**
```
[set red][goto 1,1]█[goto 1,3]█[goto 1,5]█
[set blue][goto 1,2]█
[set green][goto 1,4]█
= 3 color changes + cursor jumps, ~60 bytes
```

### Advanced Optimization: Color Quantization

Before rendering, analyze the frame and quantize to reduce unique colors:
- Cluster similar colors (ΔE < 3 imperceptible to humans)
- Reduce 1000 unique colors to 50-100
- Massive reduction in escape code overhead

### Spatial Coherence Exploitation

For each color, find the longest contiguous runs and render those first. Use cursor-relative movements (`\e[C` = 1 byte) instead of absolute positioning (`\e[row;colH` = 5-8 bytes).

### Expected Impact
- 40-60% reduction in output bytes
- Better SSH compression ratios (more repetitive patterns)
- Reduced terminal parsing overhead on client

---

## 3. Foveated Temporal Rendering

**Core Insight:** Human attention is focused. Render what matters at high fidelity/frequency, everything else can lag.

### How It Works

Divide the viewport into attention zones:

```
┌─────────────────────────────────┐
│  Zone C (peripheral)  4 Hz      │
│  ┌─────────────────────────┐    │
│  │  Zone B (mid)  10 Hz    │    │
│  │  ┌───────────────────┐  │    │
│  │  │ Zone A (foveal)   │  │    │
│  │  │ Player + 3 tiles  │  │    │
│  │  │     60 Hz         │  │    │
│  │  └───────────────────┘  │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

**Zone A (Foveal - 5x5 tiles around player):**
- Full 60 Hz updates
- Highest color fidelity
- Immediate response to any changes

**Zone B (Parafoveal - next 5 tiles):**
- 10-15 Hz updates
- Full color but batched updates
- Moving entities get promoted to Zone A timing

**Zone C (Peripheral - everything else):**
- 4-5 Hz updates
- Can use simplified rendering
- Static tiles can skip multiple frames

### Network Packet Prioritization

Structure packets so Zone A data is at the front:
```
[Zone A diff | Zone B diff | Zone C diff]
     ↑
     First bytes arrive, terminal starts parsing immediately
```

If packet is large and connection slow, Zone A renders while B/C still arriving.

### Adaptive Zone Sizing

Monitor network conditions in real-time:
- High latency → Shrink Zone A, expand prediction
- Low latency → Expand Zone A for richer experience
- Packet loss → Increase redundancy in Zone A only

### Expected Impact
- 3-5x reduction in average bytes per frame
- Perceived latency drops dramatically (core gameplay always snappy)
- Graceful degradation under poor network conditions

---

## Implementation Priority

1. **CRLE** - Lowest risk, immediate gains, no architectural changes
2. **Foveated Rendering** - Medium complexity, huge bandwidth savings
3. **Probabilistic Pre-Rendering** - Highest complexity, but the holy grail of perceived zero-latency

---

## Measurement Strategy

Before implementing, instrument:
- Bytes per frame (mean, p50, p99)
- Time from input received to output sent
- Client-perceived input-to-photon latency
- SSH compression ratios

Target metrics:
- < 500 bytes average frame size
- < 1ms server processing time
- < 16ms perceived latency on good connections
