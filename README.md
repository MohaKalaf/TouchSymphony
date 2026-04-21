# Touch Symphony

**A smart surface sensing playground, built from scratch in vanilla JavaScript.**

Live demo: **[touch.mohammadkalaf.com](https://touch.mohammadkalaf.com)**

Touch Symphony captures multi-touch position, pressure, velocity, and dwell data in real time and visualises it four different ways — a reactive trail renderer, an industry-standard heatmap, a gesture recorder, and a nearest-neighbour gesture classifier. Every parameter that drives the visualisation can be tuned live via an advanced-controls panel, so the same underlying system can be demonstrated to both engineers and non-technical viewers.

Built over two days as a portfolio demonstration for a tactile-sensing startup, with no framework, no build step, and no dependencies beyond two web fonts.

---

## What it does

### Four interactive modes

| Mode | What it shows |
|------|---------------|
| **Free** | Pressure-reactive comet trails with per-pointer colour identity, starburst ripples on touch-down, and live crosshair cursors that scale with reported pressure. |
| **Heatmap** | An 8×8-pixel grid that accumulates "heat" from every touch event, rendered with a multi-stop colour gradient (navy → cyan → green → white) and exponential decay. Velocity and dwell time both modulate the deposit rate. |
| **Record** | Captures a single continuous stroke and prompts you to label it. The raw stroke is resampled, scaled, and centred into a normalised template stored in `localStorage`. |
| **Classify** | Draws a stroke and finds its nearest neighbour among saved templates. Reports the match label plus a confidence score. |

### Live telemetry

Every frame, the right-hand panel displays: active pointer count, maximum current pressure, cumulative sample count, real-time sample rate (Hz), and a 120-sample pressure history sparkline. The stage itself overlays the same values at each corner so they stay visible while you're drawing.

### Pressure capability detection

On first interaction, the app samples pressure values for 8 events and classifies the device's sensing capability. It distinguishes real pressure hardware (stylus, 3D Touch, Force Touch) from devices that only report 0, 0.5, or 1 by measuring value variance. The result drives a "Native Pressure" or "No Sensor" badge in the header — honest about what the hardware actually supports rather than synthesising a pressure value from touch radius or duration, which earlier experiments showed to be misleading.

### Advanced controls (heatmap mode only)

Ten live sliders for every heatmap tunable: base deposit rate, accumulation cap, exponential decay rate, minimum alpha floor, fade threshold, velocity weighting strength, velocity fast-threshold, dwell weighting strength, dwell max bonus, dwell ramp time. Every change takes effect on the next frame. Reset restores factory defaults.

---

## How it works

### Architecture

Ten independent IIFE modules, each owning its state via closures and exposing a small public API. No framework. No build step. The modules are sequenced so that each one only depends on the ones before it:

```
1. Config            Central mutable tunables (sliders write here)
2. TouchCapture      Normalises pointer events into uniform records
3. SurfaceRenderer   Canvas render loop, heatmap accumulation
4. GestureRecorder   Single-stroke capture during record/classify
5. GestureProcessor  Pure functions: resample, scale, centre
6. GestureClassifier Template storage + nearest-neighbour match
7. DataPanel         Right-side telemetry readouts
8. GesturePanel      Saved-gesture list + prediction display
9. ModeController    Tab switching + mode-specific UI visibility
10. Event wiring     Top-level glue, keyboard shortcuts, modal
```

### Data flow

```
user input
    │
    ▼
TouchCapture ──────► start / move / end callbacks
    │                       │
    │                       ▼
    │              event wiring decides based on mode:
    │                - always: SurfaceRenderer.updateTrail
    │                - record/classify: also GestureRecorder
    │                - on end: save modal | run predict()
    │
    └──► rec { id, x, y, pressure, velocity, dwell... }
```

### Heatmap — the interesting part

The heatmap is closer to how production heatmaps like `heatmap.js`, `Leaflet.heat`, and `simpleheat` actually work than most "tutorial" implementations. Every cell stores two values:

```js
{ v: currentValue, peak: highestValueEverReached }
```

**Deposit** on every touch event:

```
deposit = base × pressure × velocityMult × dwellMult
```

- `velocityMult = 1 − vWeight × 0.7 × min(speed / fastThreshold, 1)` — slow drags deposit more, fast swipes deposit less, mirroring how real tactile sensors behave because fast motion spreads the same force budget across more cells.
- `dwellMult = 1 + dWeight × dMaxBonus × min(dwellMs / rampMs, 1)` — lingering on the same cell earns a growing bonus. The timer resets when the pointer crosses into a new cell.

**Decay** happens every frame:

```js
v = v × decayRate        // 0.9965 default → half-life ≈ 3.3s at 60fps
```

**Rendering** uses a multi-stop gradient on the `[0, cap]` range mapped to `[0, 1]`:

- `0.00–0.30` deep navy blue → cyan (light activity)
- `0.30–0.65` cyan → green (moderate)
- `0.65–1.00` green → pure white (hot spots)

**Alpha** has a floor for fresh cells (`minAlpha = 0.25` by default, inspired by `heatmap.js`'s `minOpacity`) so light touches are immediately visible, but tapers continuously to zero once the cell has decayed past a fraction of its peak:

```js
freshAlpha = minAlpha + t × (1 − minAlpha)
fadeScale  = v ≥ peak × fadeThresh  ?  1  :  v / (peak × fadeThresh)
alpha      = freshAlpha × fadeScale
```

This splits the "make fresh cells visible" job (floor) from the "fade out smoothly" job (taper), so cells don't vanish abruptly at the minimum brightness — a subtle but important detail I only got right after several iterations.

### Gesture classification — the $1 recognizer

Gestures are matched using the classic $1 recognizer algorithm (Wobbrock et al., 2007):

1. **Resample** the raw stroke to exactly 32 evenly-spaced points along its path. Removes the effect of drawing speed.
2. **Scale** the bounding box to a 250×250 square preserving aspect ratio. Removes the effect of gesture size.
3. **Centre** on the centroid at (0, 0). Removes the effect of canvas position.
4. **Match** with average per-point Euclidean distance against every saved template. The lowest distance wins.
5. **Confidence** is `1 − min(distance / 60, 1)` — distances below 10 are great matches, above 60 are effectively random.

ML-free, explainable, fast. The `GestureClassifier` module is a drop-in replacement for a neural net later — the same `predict(normalisedPoints) → { label, confidence }` signature.

### Rendering philosophy

The canvas is **fully cleared every frame** rather than painting a translucent dark rectangle for a motion-blur effect. Alpha-blended fades accumulate residual pixels that never actually reach zero — faint ghost smudges persist in the canvas buffer even after all touches lift off. Fully clearing and redrawing from data structures (trails Map, ripples array, heatmap Map) guarantees that when data ages out, it disappears instantly.

The CSS grid background on `.stage` is a separate layer below the canvas, so clearing the canvas never wipes the grid.

---

## Engineering lessons logged

Production debugging lessons that cost real time, all documented inline in the code so they're findable again:

1. **Canvas alpha-blending ghost pixels.** See [Rendering philosophy](#rendering-philosophy).
2. **Nested scroll-container touch traps on mobile.** The `.collapsible-body` wrapper originally had `overflow: hidden` plus `max-height: 2000px` on its expanded state. On mobile browsers, that combination inside a scrolling parent creates a touch-event dead zone — drag gestures that start inside the wrapper are captured and never bubble to the outer scroll container. Content below became unreachable. Fix: only apply `overflow: hidden` when collapsed or mid-transition.
3. **Pressure capability detection.** Browsers on devices without pressure hardware will confidently report `e.pressure = 0.5` on every event. The only honest way to know is to sample several events and measure variance.
4. **Velocity smoothing.** Raw `distance / dt` velocity spikes wildly on a single slow frame. Exponential moving average (`v = v × 0.6 + instant × 0.4`) smooths it enough for meaningful deposit weighting without adding visible lag.
5. **Keeping the heatmap tunable as a demo tool.** Every parameter that affects visualisation behaviour lives in one `Config` module, read live by every other module. Editing a slider takes effect on the next frame, no reload. This matters because a heatmap with the wrong decay rate looks broken, and the "right" decay rate depends on the device's sample rate — so exposing it as a knob beats hardcoding a guess.

---

## File structure

```
touch-symphony.html   DOM shell (IDs and data attributes that JS binds to)
touch-symphony.css    Styles, organised into 11 numbered sections
touch-symphony.js     Ten sectioned modules, ~1000 lines, heavily commented
```

Zero runtime dependencies beyond two Google Fonts (JetBrains Mono, Fraunces). No build step. Drop the three files on any static host and it works.

---

## Running it

Clone and open `touch-symphony.html` directly in a browser, or serve the folder via any static HTTP server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/touch-symphony.html
```

The live version at **[touch.mohammadkalaf.com](https://touch.mohammadkalaf.com)** is the exact same three files deployed to a static host.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `1` | Free mode |
| `2` | Heatmap mode |
| `3` | Record mode |
| `4` | Classify mode |

---

## What's next

- **Phase C: ML classifier.** `GestureClassifier.predict(normalised) → { label, confidence }` is a deliberate hook — the $1 recognizer can be swapped for a small neural net without touching any other module.
- **Multi-stroke gestures.** The recorder is currently single-pointer, single-stroke. Extending to sequenced strokes would allow more complex gesture vocabularies.
- **Export / import of gesture libraries.** Partially done (JSON export exists); round-tripping re-imports and letting users share libraries is the logical next step.
- **WebGL heatmap renderer.** At very high touch rates the 2D canvas blit cost becomes the bottleneck. A shader-based heatmap would scale to much denser input.

---

## Author

Built by Mohammad Kalaf — Computer Science student at Brunel University London, genuinely interested in human-machine interaction, tactile interfaces, and sensor-driven product work.

- Website: [mohammadkalaf.com](https://mohammadkalaf.com)
- GitHub: [github.com/MohaKalaf](https://github.com/MohaKalaf)
