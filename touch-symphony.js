/* ═══════════════════════════════════════════════════════════════════════════
   TOUCH SYMPHONY — Application Logic
   ═══════════════════════════════════════════════════════════════════════════

   Architecture overview:
     The app is organised as a set of small, independent IIFE (Immediately
     Invoked Function Expression) modules. Each module owns its state via
     closures and exposes a small public API. No framework, no build step —
     just vanilla JS that runs as soon as the script tag loads.

   Modules (top-down execution order):
     1. Config            — central mutable tunables (sliders write here)
     2. TouchCapture      — normalises pointer events into {id, x, y, pressure,
                            velocity, ...} records; emits start/move/end events
     3. SurfaceRenderer   — paints the canvas each frame based on trails,
                            ripples, and heatmap state
     4. GestureRecorder   — captures a stroke during record/classify mode
     5. GestureProcessor  — pure functions for resampling, scaling, centring
                            a stroke into a normalised template
     6. GestureClassifier — stores labelled templates, does nearest-neighbour
                            matching; persists to localStorage
     7. DataPanel         — refreshes the telemetry readouts on every frame
     8. GesturePanel      — renders the saved gesture list + prediction output
     9. ModeController    — wires tab clicks to mode switches and shows/hides
                            mode-specific UI sections
     10. Event wiring     — top-level IIFE that glues it all together, handles
                            the naming modal, keyboard shortcuts, etc.

   Data flow:
     user input → TouchCapture → start/move/end callbacks
         ↓
     event wiring (module 10) decides what to do based on current mode:
         - always: feed rec into SurfaceRenderer.updateTrail / addRipple
         - record/classify mode: also feed into GestureRecorder
         - on end: prompt-to-save (record) or run predict() (classify)

   Rendering is a 60fps requestAnimationFrame loop inside SurfaceRenderer
   that fully clears the canvas each frame and redraws from the authoritative
   data structures (trails Map, ripples array, heatmap Map). This avoids
   alpha-blending ghost accumulation — see the big comment at the top of the
   render() function.
   ═════════════════════════════════════════════════════════════════════════ */


/* ─── 1. Config ───────────────────────────────────────────────────────────
   Centralised tunables. The advanced controls panel writes to this module;
   every other module reads from it live (no restart needed). */
const Config = (() => {
  // DEFAULTS is the factory-reset state.
  // Every advanced slider's min/max in the HTML should comfortably bracket
  // the corresponding default value here.
  const DEFAULTS = {
    // ── Heatmap accumulation ──
    heatAccumBase:  0.9,    // Base heat added per move event (multiplied by pressure, velocity, dwell)
    heatAccumCap:   8.0,    // Ceiling for a single cell's accumulated value — higher lets hot spots stack brighter
    heatDecay:      0.9965, // Per-frame multiplicative decay. Closer to 1 = slower fade.
                            //   0.9965 → half-life ≈ 3.3s at 60fps (ln 2 / -ln 0.9965 / 60)

    // ── Rendering ──
    heatMinAlpha:   0.25,   // Baseline opacity floor for fresh cells (like heatmap.js "minOpacity")
    heatFadeThresh: 0.30,   // When v drops below peak × this, alpha tapers continuously to 0

    // ── Velocity weighting ──
    velocityWeight: 1.0,    // 0 = ignore velocity, 1 = full effect
    velocityFastPx: 3.0,    // Speed (px/ms) at which weighting hits its minimum multiplier

    // ── Dwell weighting ──
    dwellWeight:    1.0,    // 0 = ignore dwell, 1 = full effect
    dwellMaxBonus:  0.8,    // Extra multiplier at peak dwell (0.8 → up to 1.8× deposit)
    dwellRampMs:    400,    // How long on the same cell to reach peak dwell bonus
  };

  // Current live state — starts as a shallow copy of defaults.
  const state = { ...DEFAULTS };

  // Subscribers. Called with (changedKey, newValue) when set() is called,
  // or with (null, null) when reset() is called (so listeners know to
  // refresh everything).
  const listeners = [];

  return {
    // Read a single config value. Returns undefined for unknown keys.
    get(k) { return state[k]; },

    // Write a single config value and notify listeners.
    set(k, v) {
      state[k] = v;
      listeners.forEach(fn => fn(k, v));
    },

    // Restore every value to its factory default. Listeners receive (null, null)
    // as a "refresh everything" signal.
    reset() {
      Object.assign(state, DEFAULTS);
      listeners.forEach(fn => fn(null, null));
    },

    // Expose the defaults object (as a copy) for any UI that needs to display
    // factory values. Currently unused but kept for future UI.
    defaults() { return { ...DEFAULTS }; },

    // Subscribe to config changes. fn is called as fn(key, newValue).
    onChange(fn) { listeners.push(fn); },
  };
})();


/* ─── 2. TouchCapture ─────────────────────────────────────────────────────
   Single source of truth for pointer input. Normalises the browser's
   PointerEvent into a uniform `rec` object used across the app:

     rec = {
       id:          pointerId (unique per active pointer),
       x, y:        local coordinates (canvas-relative),
       t:           last timestamp in performance.now() ms,
       startT:      timestamp of pointerdown,
       type:        'mouse' | 'touch' | 'pen',
       pressure:    normalised pressure 0-1 (see normalisePressure),
       velocity:    smoothed px/ms speed across recent movement,
       prevX, prevY, prevT:   previous-frame position for velocity calc,
       lastCellKey, dwellStartT:  used by dwell-weighting logic in render
     }

   Emits three event types: 'start', 'move', 'end'. Subscribers register
   via TouchCapture.on(event, fn) and receive the rec object. */
const TouchCapture = (() => {
  const el = document.getElementById('canvas');

  // Map of currently-active pointerIds to their rec objects. A pointer is
  // active from pointerdown until pointerup/cancel/leave.
  const active = new Map();

  // Per-event-type subscriber arrays.
  const subs = { start: [], move: [], end: [] };

  // Cumulative count of every pointer event we've handled since page load.
  // Surfaced in the telemetry panel as "Total samples".
  let sampleCount = 0;

  // Rolling list of timestamps used to compute the sample rate (Hz).
  let rateSamples = [];

  // ── Pressure capability detection ──
  // JS doesn't know upfront whether this device has real pressure hardware.
  // JS waits for a few pointer events, inspect the pressure values, and
  // classify: if the values vary smoothly → 'native'. If they're all 0,
  // 0.5, or 1 (the only values a non-pressure browser ever reports) →
  // 'synthesised'. The result drives the capability badge in the header.
  let pressureMode = 'detecting';  // 'native' | 'synthesised' | 'detecting'
  const pressureSamples = [];       // Raw e.pressure values from first events

  function detectPressureMode(e) {
    // Already decided — no work needed.
    if (pressureMode !== 'detecting') return;

    if (e.pressure !== undefined) pressureSamples.push(e.pressure);

    // Wait for enough samples to have a reasonable signal. 8 events is
    // ~130ms of interaction, plenty to see variance.
    if (pressureSamples.length >= 8) {
      // Real pressure varies smoothly. Fake pressure reports only 0, 0.5,
      // or 1 (idle, default, active). Two tests:
      //   (1) rounded-to-percent values should have >3 unique values
      //   (2) raw values should include something that isn't 0/0.5/1
      const unique = new Set(pressureSamples.map(v => Math.round(v * 100)));
      const hasVariance = unique.size > 3;
      const notJustBinary = !pressureSamples.every(v => v === 0 || v === 0.5 || v === 1);

      pressureMode = (hasVariance && notJustBinary) ? 'native' : 'synthesised';

      // Notify the UI — fired as a CustomEvent on `document` so the badge
      // listener in the main event-wiring IIFE can pick it up.
      document.dispatchEvent(new CustomEvent('pressuremode', { detail: pressureMode }));
    }
  }

  function normalisePressure(e, rec) {
    detectPressureMode(e);

    // Stylus input always reports real pressure, so trust it directly.
    if (e.pointerType === 'pen' && e.pressure !== undefined && e.pressure > 0) {
      return e.pressure;
    }

    // Native pressure hardware detected (rare — iPhone 3D Touch, some
    // Surface devices). Trust the browser's value.
    if (pressureMode === 'native' && e.pressure !== undefined) {
      return e.pressure;
    }

    // No usable pressure sensing. Return a flat 1.0 rather than pretending
    // to synthesise something from touch radius or duration — those
    // approximations were tried and found misleading.
    return 1.0;
  }

  function getPressureMode() { return pressureMode; }

  // Convert an event's page coordinates into canvas-local coordinates.
  function toLocal(e) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ── pointerdown: a new pointer arrives ──
  el.addEventListener('pointerdown', (e) => {
    // Capture the pointer so it can keep getting events even if it drags
    // outside the canvas. Released automatically on pointerup.
    el.setPointerCapture(e.pointerId);

    const { x, y } = toLocal(e);
    const t = performance.now();

    // Build the pointer record. prevX/Y/T match current for the first
    // frame so velocity starts at 0.
    const rec = {
      id: e.pointerId, x, y, pressure: 0.15,
      t, startT: t, type: e.pointerType,
      prevX: x, prevY: y, prevT: t, velocity: 0,
      lastCellKey: null, dwellStartT: t,
    };
    rec.pressure = normalisePressure(e, rec);

    active.set(e.pointerId, rec);
    sampleCount++;
    rateSamples.push(t);
    subs.start.forEach(fn => fn(rec));
  });

  // ── pointermove: existing pointer moved ──
  el.addEventListener('pointermove', (e) => {
    // Ignore moves for pointers that didn't see go down (edge case with
    // hover events on devices that synthesise them).
    if (!active.has(e.pointerId)) return;

    const { x, y } = toLocal(e);
    const t = performance.now();
    const rec = active.get(e.pointerId);

    // Compute velocity BEFORE updating position, to be able to compare the
    // incoming (x,y,t) to the previous stored values.
    const dt = Math.max(t - rec.prevT, 1);   // at least 1ms to avoid div-by-zero
    const dist = Math.hypot(x - rec.prevX, y - rec.prevY);

    // Exponential moving average smooths velocity across frames so a
    // single slow frame doesn't spike the reading to zero.
    //   new_v = old_v × 0.6 + instant × 0.4
    rec.velocity = rec.velocity * 0.6 + (dist / dt) * 0.4;

    // Shift "previous" to the old "current" before updating current.
    rec.prevX = rec.x; rec.prevY = rec.y; rec.prevT = rec.t;
    rec.x = x; rec.y = y; rec.t = t;
    rec.pressure = normalisePressure(e, rec);

    sampleCount++;
    rateSamples.push(t);
    // Cap rate-sample history to 60 entries (~1 second at 60fps).
    if (rateSamples.length > 60) rateSamples.shift();

    subs.move.forEach(fn => fn(rec));
  });

  // ── pointerup / cancel / leave: pointer is gone ──
  function endPointer(e) {
    if (!active.has(e.pointerId)) return;
    const rec = active.get(e.pointerId);
    active.delete(e.pointerId);
    subs.end.forEach(fn => fn(rec));
  }
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);
  el.addEventListener('pointerleave', endPointer);

  // Public API.
  return {
    // Subscribe to a lifecycle event.
    on(evt, fn) { subs[evt].push(fn); },

    // Snapshot of all currently-active pointer records.
    getActive() { return Array.from(active.values()); },

    // Total number of raw pointer events since page load.
    getSampleCount() { return sampleCount; },

    // Current detection result ('native', 'synthesised', or 'detecting').
    getPressureMode,

    // Average events/second across the rolling rateSamples window.
    // Returns 0 until at least 2 samples.
    getSampleRate() {
      if (rateSamples.length < 2) return 0;
      const span = rateSamples[rateSamples.length - 1] - rateSamples[0];
      return span > 0 ? Math.round((rateSamples.length - 1) / (span / 1000)) : 0;
    },

    // Hard reset (currently unused, but kept for future multi-page nav).
    clear() { active.clear(); sampleCount = 0; rateSamples = []; }
  };
})();


/* ─── 3. SurfaceRenderer ──────────────────────────────────────────────────
   Owns the canvas. Runs a 60fps requestAnimationFrame loop that fully
   clears the canvas each frame and redraws from the authoritative data
   structures below. The CSS grid background on .stage is a separate layer
   below the canvas, so clearing the canvas never touches it.

   Data structures:
     trails:   Map<pointerId, Array<{x, y, p, age}>>
               Per-pointer ring-buffer of recent positions. Used to draw
               comet-tail trails behind moving pointers.
     ripples:  Array<{x, y, age, maxAge}>
               One-shot starburst circles added on pointerdown.
     heatmap:  Map<"gridX,gridY", {v, peak}>
               Accumulated "heat" per 8×8 grid cell. v is the current value,
               peak is the highest value this cell ever reached — used so
               alpha can taper continuously to zero once v drops below a
               fraction of peak (the "fade threshold"). */
const SurfaceRenderer = (() => {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { alpha: true });

  let mode = 'free';

  // Device pixel ratio. Capped at 2 because 3x on high-DPI phones triples
  // the pixel count and tanks performance without visible benefit.
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  const trails = new Map();   // pointerId → array of {x, y, p, age}
  const ripples = [];          // array of {x, y, age, maxAge}
  const heatmap = new Map();   // "gx,gy" → {v, peak}

  // Resize the canvas to match its CSS size × DPR for crisp rendering.
  // Called on load, window resize, and orientation change.
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    // Reset the transform so our drawing coordinates are CSS pixels, not
    // raw device pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  // orientationchange fires before the layout has actually resized, hence the timeout.
  window.addEventListener('orientationchange', () => setTimeout(resize, 100));
  setTimeout(resize, 0);

  // Switch mode. Clears the heatmap when leaving heatmap mode so stale
  // data doesn't reappear on return.
  function setMode(m) {
    mode = m;
    if (m !== 'heatmap') heatmap.clear();
  }

  // Called on pointerdown — spawn a ripple starburst.
  function addRipple(x, y) {
    ripples.push({ x, y, age: 0, maxAge: 60 });
  }

  // Called on every pointerdown/move — extend the per-pointer trail and
  // (in heatmap mode) deposit heat into the corresponding grid cell.
  function updateTrail(rec) {
    if (!trails.has(rec.id)) trails.set(rec.id, []);
    const arr = trails.get(rec.id);
    arr.push({ x: rec.x, y: rec.y, p: rec.pressure, age: 0 });
    // Cap trail length so memory doesn't grow forever on long drags.
    if (arr.length > 60) arr.shift();

    // ── Heatmap accumulation (heatmap mode only) ──
    if (mode === 'heatmap') {
      // 8px grid cells. Using bitwise floor would be faster but less clear.
      const gx = Math.floor(rec.x / 8);
      const gy = Math.floor(rec.y / 8);
      const key = gx + ',' + gy;
      const cur = heatmap.get(key);
      const curV = cur ? cur.v : 0;

      // ── Velocity weighting ──
      // Slow drags deposit more heat than fast swipes. This mirrors how
      // real tactile sensors behave: fast motion spreads the same "force
      // budget" across more cells so each individual cell sees less.
      const vWeight = Config.get('velocityWeight');
      const vFast = Config.get('velocityFastPx');
      // 0 (still) → 1 (at or above fast threshold)
      const speedNorm = Math.min(rec.velocity / vFast, 1);
      // At vWeight=0: multiplier = 1 (no effect). At vWeight=1: scales
      // from 1.0 (still) down to 0.3 (fast).
      const velocityMult = 1 - vWeight * 0.7 * speedNorm;

      // ── Dwell weighting ──
      // Repeated hits on the SAME cell earn a growing bonus, rewarding
      // lingering attention. When the pointer crosses into a new cell,
      // the dwell timer resets.
      const dWeight = Config.get('dwellWeight');
      const dMaxBonus = Config.get('dwellMaxBonus');
      const dRamp = Config.get('dwellRampMs');
      if (rec.lastCellKey !== key) {
        rec.lastCellKey = key;
        rec.dwellStartT = rec.t;
      }
      const dwellMs = rec.t - rec.dwellStartT;
      // Saturates at 1 after the ramp time.
      const dwellProgress = Math.min(dwellMs / dRamp, 1);
      // At dWeight=0: multiplier = 1. At dWeight=1: up to 1+dMaxBonus (=1.8).
      const dwellMult = 1 + dWeight * dMaxBonus * dwellProgress;

      // Final deposit: base × pressure × velocity × dwell.
      const base = Config.get('heatAccumBase');
      const cap = Config.get('heatAccumCap');
      const deposit = base * rec.pressure * velocityMult * dwellMult;
      const nextV = Math.min(curV + deposit, cap);

      // Store both current and peak. peak is set on every accumulation so
      // that it tracks the highest value reached since the cell was born
      // or last refreshed by a new touch.
      heatmap.set(key, { v: nextV, peak: nextV });
    }
  }

  // Called on pointerup — currently a no-op. Trails fade naturally as
  // their points age out of the buffer.
  function clearTrail(id) {
  
  }

  // ── Main render loop ──
  function render() {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    // CRITICAL ARCHITECTURAL CHOICE:
    // FULLY CLEAR the canvas every frame rather than painting a
    // translucent dark rectangle over it (which some earlier versions
    // did to get a motion-blur trail effect). Alpha-blended fades
    // ACCUMULATE residual pixels that never reach zero — even after
    // lifting off, faint ghost smudges persist in the canvas buffer.
    //
    // Because the grid background is a CSS layer on .stage (below the
    // canvas), a full clear here is safe — never wipe the grid.
    // Trails, ripples, and heatmap cells are all redrawn each frame from
    // their data structures, which are the ground truth. When they age
    // out of the data, they disappear instantly from the screen.
    ctx.clearRect(0, 0, w, h);

    // ── Heatmap rendering ──
    if (mode === 'heatmap') {
      const toDelete = [];
      const cap = Config.get('heatAccumCap');
      const minAlpha = Config.get('heatMinAlpha');
      const fadeThresh = Config.get('heatFadeThresh');
      const decay = Config.get('heatDecay');

      heatmap.forEach((cell, key) => {
        const v = cell.v;
        const peak = cell.peak;
        const [gx, gy] = key.split(',').map(Number);

        // Normalised intensity 0–1 relative to the accumulation cap.
        const t = Math.min(v, cap) / cap;

        // ── Multi-stop colour gradient ──
        // Industry-standard heatmaps (heatmap.js, Leaflet.heat, etc.) use
        // multi-stop gradients for visual intensity separation. Ours:
        //   0.00–0.30   deep navy blue → cyan       — light activity
        //   0.30–0.65   cyan          → green       — moderate
        //   0.65–1.00   green         → pure white  — hot spots
        let r, g, b;
        if (t < 0.3) {
          const s = t / 0.3;
          r = 20 * (1 - s) + 0 * s;
          g = 60 * (1 - s) + 200 * s;
          b = 140 * (1 - s) + 220 * s;
        } else if (t < 0.65) {
          const s = (t - 0.3) / 0.35;
          r = 0 * (1 - s) + 125 * s;
          g = 200 * (1 - s) + 245 * s;
          b = 220 * (1 - s) + 197 * s;
        } else {
          const s = (t - 0.65) / 0.35;
          r = 125 * (1 - s) + 255 * s;
          g = 245 * (1 - s) + 255 * s;
          b = 197 * (1 - s) + 255 * s;
        }

        // ── Alpha (opacity) ──
        // Fresh cells get a floor opacity (minAlpha) so even a light touch
        // is immediately visible. BUT — once the cell is decaying past a
        // fraction of its peak (fadeThresh), linearly tapers alpha to
        // zero, so fading cells don't vanish at the minAlpha floor.
        const freshAlpha = minAlpha + t * (1 - minAlpha);
        const fadeStart = peak * fadeThresh;
        const fadeScale = v >= fadeStart ? 1 : (v / fadeStart);
        const alpha = freshAlpha * fadeScale;

        // `r | 0` is a fast way to convert a float to an int in JS.
        ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
        ctx.fillRect(gx * 8, gy * 8, 8, 8);

        // Exponential decay per frame.
        const nextV = v * decay;
        if (nextV < 0.02) {
          // Below threshold — delete entirely so idle canvas is truly empty.
          toDelete.push(key);
        } else {
          cell.v = nextV;
          // peak is NOT updated here — it's a high-water mark that stays
          // stable through the fade so the taper reference point is fixed.
        }
      });
      toDelete.forEach(k => heatmap.delete(k));
    }

    // ── Ripples (starburst on pointerdown) ──
    // Iterate backwards so that it can splice while iterating.
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.age++;
      const t = r.age / r.maxAge;   // 0 → 1 over lifespan
      if (t >= 1) { ripples.splice(i, 1); continue; }

      const radius = t * 80;          // expands outward
      const alpha = (1 - t) * 0.6;    // fades as it grows

      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(125, 245, 197, ${alpha})`;
      ctx.lineWidth = 2 * (1 - t);
      ctx.stroke();
    }

    // ── Trails (comet-tails behind active pointers) ──
    trails.forEach((arr, id) => {
      if (arr.length < 2) return;

      // Draw each segment between consecutive points. Segments deeper in
      // history are thinner and more transparent, giving the tail effect.
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1], b = arr[i];
        const ageFactor = i / arr.length;             // 0 (oldest) → 1 (newest)
        const pressure = (a.p + b.p) / 2;
        const thickness = 2 + pressure * 14 * ageFactor;
        const alpha = ageFactor * 0.9;

        // Main stroke
        ctx.strokeStyle = `rgba(125, 245, 197, ${alpha})`;
        ctx.lineWidth = thickness;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        // Softer glow underneath (drawn second so it blends on top,
        // but its lower alpha keeps it ambient).
        ctx.strokeStyle = `rgba(125, 245, 197, ${alpha * 0.3})`;
        ctx.lineWidth = thickness * 2.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Age every point so older segments eventually get shifted out.
      arr.forEach(pt => pt.age++);
      while (arr.length && arr[0].age > 40) arr.shift();
    });

    // Garbage-collect empty trail arrays so the idle canvas really is empty.
    trails.forEach((arr, id) => {
      if (arr.length === 0) trails.delete(id);
    });

    // ── Active pointer cursors ──
    // Big pressure-sensitive ring + centre dot + crosshair + ID label.
    // Drawn last so they're always on top of trails and heatmap cells.
    TouchCapture.getActive().forEach(rec => {
      const radius = 10 + rec.pressure * 30;

      // Outer translucent pressure ring
      ctx.beginPath();
      ctx.arc(rec.x, rec.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(125, 245, 197, ${0.1 + rec.pressure * 0.2})`;
      ctx.fill();

      // Inner solid dot
      ctx.beginPath();
      ctx.arc(rec.x, rec.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#7df5c5';
      ctx.fill();

      // Crosshair ticks outside the ring
      ctx.strokeStyle = 'rgba(125, 245, 197, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rec.x - radius - 6, rec.y);
      ctx.lineTo(rec.x - radius - 2, rec.y);
      ctx.moveTo(rec.x + radius + 2, rec.y);
      ctx.lineTo(rec.x + radius + 6, rec.y);
      ctx.moveTo(rec.x, rec.y - radius - 6);
      ctx.lineTo(rec.x, rec.y - radius - 2);
      ctx.moveTo(rec.x, rec.y + radius + 2);
      ctx.lineTo(rec.x, rec.y + radius + 6);
      ctx.stroke();

      // Pointer ID label (useful when multi-touching to see which finger is which)
      ctx.font = '10px JetBrains Mono';
      ctx.fillStyle = '#7df5c5';
      ctx.fillText(`#${rec.id}`, rec.x + radius + 8, rec.y - radius - 2);
    });

    // Queue the next frame.
    requestAnimationFrame(render);
  }

  // Kick off the render loop.
  render();

  // Public API — everything external callers need to push data into the
  // renderer.
  return { setMode, addRipple, updateTrail, clearTrail, resize };
})();


/* ─── 4. GestureRecorder ──────────────────────────────────────────────────
   Captures a single continuous stroke from the FIRST active pointer
   during record or classify mode. Secondary touches are ignored.

   Lifecycle:
     start(id)  — begins recording, remembers which pointerId owns the stroke
     addPoint(rec) — called on every move; appends to the stroke if the rec
                     belongs to the tracked pointer
     stop(id)   — ends recording if the stopping pointer matches; returns
                  the normalised stroke or null if the stroke was too short
                  to be meaningful (< 5 points) */
const GestureRecorder = (() => {
  let recording = false;
  let currentStroke = null;
  let onComplete = null;   // Unused externally, kept for future extension

  function start(primaryId) {
    recording = true;
    currentStroke = {
      id: primaryId,
      points: [],
      startT: performance.now()
    };
    // Fade in the red "RECORDING GESTURE" banner.
    document.getElementById('recBanner').classList.add('active');
  }

  function addPoint(rec) {
    // Guard: must be in recording mode, must have a current stroke, and
    // the incoming rec must belong to the pointer it started with.
    if (!recording || !currentStroke || rec.id !== currentStroke.id) return;
    currentStroke.points.push({
      x: rec.x,
      y: rec.y,
      p: rec.pressure,
      // Timestamp relative to stroke start — kept for potential use in
      // time-aware classifiers (not used by the current $1 algorithm).
      t: rec.t - currentStroke.startT
    });
  }

  function stop(id) {
    // Guard: must be recording, must have a stroke, pointer must match.
    if (!recording || !currentStroke || id !== currentStroke.id) return null;

    recording = false;
    document.getElementById('recBanner').classList.remove('active');

    const stroke = currentStroke;
    currentStroke = null;

    // Reject strokes too short to be a meaningful gesture (e.g. a single tap).
    if (stroke.points.length < 5) return null;

    // Hand off to GestureProcessor for normalisation.
    const normalised = GestureProcessor.normalise(stroke.points);

    if (onComplete) onComplete({ raw: stroke.points, normalised });
    return { raw: stroke.points, normalised };
  }

  function setOnComplete(fn) { onComplete = fn; }
  function isRecording() { return recording; }

  return { start, addPoint, stop, setOnComplete, isRecording };
})();


/* ─── 5. GestureProcessor ─────────────────────────────────────────────────
   Pure functions that turn a raw stroke (variable length, absolute
   coordinates, variable speed) into a normalised template suitable for
   template matching:

     1. resample(pts, n)      — rewrite stroke as exactly n evenly-spaced
                                points along the path. Removes the effect
                                of how fast the user drew.
     2. scaleToSquare(pts)    — scale to fit a 250x250 box. Removes the
                                effect of absolute gesture size.
     3. translateToOrigin(pts) — centre at (0, 0). Removes the effect of
                                where on the canvas the gesture was drawn.

   Based on the classic "$1 recognizer" approach by Wobbrock et al. (2007).
   ML-free, fast, and explainable — ideal for a demo. The GestureClassifier
   module could swap this for a neural net without touching anything else. */
const GestureProcessor = (() => {
  // Number of resampled points per stroke. 32 is plenty for basic shape
  // matching; higher values slow down distance comparison without much
  // accuracy gain.
  const NUM_POINTS = 32;

  // Total path length through a stroke (sum of segment lengths).
  function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
      d += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }
    return d;
  }

  // Rewrite `pts` as `n` points spaced `I = totalLength/(n-1)` apart along
  // the original path. When the cumulative distance reaches an interval
  // boundary, interpolate to find the precise point. This removes the
  // effect of drawing speed (slow draw = dense points near slow sections;
  // after resampling, density is uniform).
  function resample(pts, n = NUM_POINTS) {
    if (pts.length < 2) return pts;

    const I = pathLength(pts) / (n - 1);
    let D = 0;                          // Accumulated distance since last emit
    const out = [pts[0]];
    const copy = pts.map(p => ({ ...p }));   // Mutable copy to splice into

    for (let i = 1; i < copy.length; i++) {
      const d = Math.hypot(copy[i].x - copy[i-1].x, copy[i].y - copy[i-1].y);
      if (D + d >= I) {
        // We've overshot the next interval. Interpolate the exact point
        // and splice it into the copy so the next iteration sees it.
        const ratio = (I - D) / d;
        const qx = copy[i-1].x + ratio * (copy[i].x - copy[i-1].x);
        const qy = copy[i-1].y + ratio * (copy[i].y - copy[i-1].y);
        const qp = copy[i-1].p + ratio * (copy[i].p - copy[i-1].p);
        const q = { x: qx, y: qy, p: qp };
        out.push(q);
        copy.splice(i, 0, q);
        D = 0;
      } else {
        D += d;
      }
    }

    // Edge case: rounding can leave us short a point. Pad with the last
    // known position so output length is exactly n.
    while (out.length < n) out.push({ ...pts[pts.length - 1] });
    return out.slice(0, n);
  }

  // Average position — used for centring.
  function centroid(pts) {
    const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
    return { x: c.x / pts.length, y: c.y / pts.length };
  }

  // Axis-aligned bounding box around a set of points.
  function boundingBox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    return { w: maxX - minX, h: maxY - minY, minX, minY };
  }

  // Scale the stroke so its bounding box fits within a `size × size` square,
  // preserving aspect ratio.
  function scaleToSquare(pts, size = 250) {
    const bb = boundingBox(pts);
    // Math.max(bb.w, bb.h, 1) avoids divide-by-zero on degenerate strokes.
    const scale = size / Math.max(bb.w, bb.h, 1);
    return pts.map(p => ({
      x: (p.x - bb.minX) * scale,
      y: (p.y - bb.minY) * scale,
      p: p.p
    }));
  }

  // Shift so that the centroid is at (0, 0).
  function translateToOrigin(pts) {
    const c = centroid(pts);
    return pts.map(p => ({ x: p.x - c.x, y: p.y - c.y, p: p.p }));
  }

  // One-shot pipeline: raw → resampled → scaled → centred.
  function normalise(rawPoints) {
    const r = resample(rawPoints);
    const s = scaleToSquare(r);
    return translateToOrigin(s);
  }

  // Average per-point Euclidean distance between two normalised strokes.
  // Lower = more similar. Used by GestureClassifier.predict().
  function distance(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      d += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
    }
    return d / a.length;
  }

  return { normalise, distance, resample, centroid, boundingBox };
})();


/* ─── 6. GestureClassifier ────────────────────────────────────────────────
   Stores labelled gesture templates and does nearest-neighbour lookup.
   Persists to localStorage under key 'ts_gestures' so saved gestures
   survive page reloads.

   Template shape:
     { label: string, points: [{x,y,p}...], swatch: dataURL }
   `swatch` is a small PNG preview generated at save time. */
const GestureClassifier = (() => {
  let templates = [];   // [{ label, points, swatch }]

  function addTemplate(label, normalisedPoints, swatchDataUrl) {
    templates.push({ label, points: normalisedPoints, swatch: swatchDataUrl });
    persist();
    return templates.length;
  }

  function removeTemplate(index) {
    templates.splice(index, 1);
    persist();
  }

  function clear() {
    templates = [];
    persist();
  }

  // Return a shallow copy so callers can't mutate the internal list.
  function getAll() { return templates.slice(); }

  // Nearest-neighbour template match.
  //   input:  a normalised point array (from GestureProcessor.normalise)
  //   returns: null if no templates stored, else:
  //            { label, confidence (0-1), distance }
  function predict(normalisedPoints) {
    if (templates.length === 0) return null;

    let best = { label: null, distance: Infinity, index: -1 };
    templates.forEach((tpl, i) => {
      const d = GestureProcessor.distance(normalisedPoints, tpl.points);
      if (d < best.distance) best = { label: tpl.label, distance: d, index: i };
    });

    // Convert distance to a 0-1 confidence. Distances below ~10 are a great
    // match; above ~60 are effectively random. Linear map with clamping.
    const maxMeaningfulDist = 60;
    const confidence = Math.max(0, Math.min(1, 1 - best.distance / maxMeaningfulDist));
    return { label: best.label, confidence, distance: best.distance };
  }

  // Save templates to localStorage. Silently ignore failures (private
  // browsing, storage full, disabled, etc.) — gestures still work for the
  // current session, just won't persist.
  function persist() {
    try {
      localStorage.setItem('ts_gestures', JSON.stringify(templates));
    } catch (e) { /* ignore */ }
  }

  // Load previously-saved templates on startup.
  function restore() {
    try {
      const raw = localStorage.getItem('ts_gestures');
      if (raw) templates = JSON.parse(raw);
    } catch (e) {
      templates = [];
    }
  }

  restore();

  return { addTemplate, removeTemplate, clear, getAll, predict };
})();


/* ─── 7. DataPanel ────────────────────────────────────────────────────────
   Updates the right-side telemetry readouts plus the four stage-overlay
   corner values. Runs its own requestAnimationFrame loop so it updates
   at ~60fps without being tied to SurfaceRenderer's loop. */
const DataPanel = (() => {
  // Cache all DOM references once — re-querying every frame is wasteful.
  const statActive = document.getElementById('statActive');
  const statPressure = document.getElementById('statPressure');
  const statSamples = document.getElementById('statSamples');
  const statRate = document.getElementById('statRate');
  const touchList = document.getElementById('touchList');
  const ovMode = document.getElementById('ov-mode');
  const ovActive = document.getElementById('ov-active');
  const ovSamples = document.getElementById('ov-samples');
  const ovPressure = document.getElementById('ov-pressure');
  const coordFooter = document.getElementById('coordFooter');
  const telemetryBadge = document.getElementById('telemetryBadge');
  const sparkline = document.getElementById('sparkline');
  const sctx = sparkline.getContext('2d');

  // Rolling 120-sample history of max-pressure-per-frame. Drawn as the
  // sparkline under the telemetry stats.
  const pressureHistory = new Array(120).fill(0);

  function tick() {
    const active = TouchCapture.getActive();
    const maxPressure = active.reduce((m, r) => Math.max(m, r.pressure), 0);

    // Update pressure history (shift-and-push ring buffer)
    pressureHistory.push(maxPressure);
    pressureHistory.shift();

    // Update stat rows
    statActive.textContent = active.length;
    statPressure.textContent = maxPressure.toFixed(2);
    statSamples.textContent = TouchCapture.getSampleCount();
    const rate = TouchCapture.getSampleRate();
    statRate.textContent = rate > 0 ? `${rate} Hz` : '— Hz';

    // Update stage corner overlays (they duplicate some of the above,
    // but positioned over the canvas so they're visible when panel is scrolled)
    ovActive.textContent = active.length;
    ovSamples.textContent = TouchCapture.getSampleCount();
    ovPressure.textContent = maxPressure.toFixed(2);

    // Badge flips between IDLE and LIVE. className is fully reassigned
    // rather than toggled so to avoid accumulating classes over time.
    telemetryBadge.textContent = active.length > 0 ? 'LIVE' : 'IDLE';
    telemetryBadge.className = active.length > 0 ? 'panel-title-badge live' : 'panel-title-badge';

    // Footer shows first active pointer's coordinates.
    if (active.length > 0) {
      coordFooter.textContent = `(${Math.round(active[0].x)}, ${Math.round(active[0].y)})`;
    }

    // ── Touch list (pointer stream section) ──
    // Replaces the entire list innerHTML on every frame. Cheap enough for
    // small lists; trading raw perf for readable code.
    if (active.length === 0) {
      touchList.innerHTML = '<div class="touch-empty">No active pointers</div>';
    } else {
      touchList.innerHTML = active.map(r => `
        <div class="touch-item">
          <span class="touch-id">#${r.id}</span>
          <span class="touch-coords">${Math.round(r.x)},${Math.round(r.y)} · ${r.type}</span>
          <div class="touch-pressure-bar"><div class="touch-pressure-fill" style="width:${r.pressure*100}%"></div></div>
        </div>
      `).join('');
    }

    // ── Sparkline rendering ──
    sctx.clearRect(0, 0, sparkline.width, sparkline.height);
    sctx.strokeStyle = '#7df5c5';
    sctx.lineWidth = 1.5;
    sctx.beginPath();

    const step = sparkline.width / pressureHistory.length;
    pressureHistory.forEach((v, i) => {
      // Invert Y since canvas y-axis grows downward. 2px bottom padding.
      const y = sparkline.height - v * sparkline.height * 0.9 - 2;
      if (i === 0) sctx.moveTo(i * step, y);
      else sctx.lineTo(i * step, y);
    });
    sctx.stroke();

    // Close the path back down to the baseline and fill for the "area under
    // the curve" effect.
    sctx.lineTo(sparkline.width, sparkline.height);
    sctx.lineTo(0, sparkline.height);
    sctx.closePath();
    sctx.fillStyle = 'rgba(125, 245, 197, 0.1)';
    sctx.fill();

    requestAnimationFrame(tick);
  }

  // Called by ModeController when the user changes mode — updates the
  // top-left MODE overlay.
  function setMode(mode) {
    ovMode.textContent = mode.toUpperCase();
  }

  tick();

  return { setMode };
})();


/* ─── 8. GesturePanel ─────────────────────────────────────────────────────
   Renders the saved gesture list (with swatches) and the prediction
   display shown in classify mode. Delegates gesture storage to the
   GestureClassifier module. */
const GesturePanel = (() => {
  // Cached DOM refs
  const listEl = document.getElementById('gestureList');
  const countEl = document.getElementById('gestureCount');
  const predictBox = document.getElementById('predictBox');
  const predictLabel = document.getElementById('predictLabel');
  const predictConf = document.getElementById('predictConf');
  const predictFill = document.getElementById('predictFill');

  // Generate a tiny PNG preview of a normalised stroke, used as the
  // swatch next to the gesture name in the library list.
  function drawSwatch(normalisedPoints, size = 28) {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const c = cv.getContext('2d');

    const bb = GestureProcessor.boundingBox(normalisedPoints);
    // 3px padding on each side so strokes don't touch the swatch edges.
    const scale = (size - 6) / Math.max(bb.w, bb.h, 1);
    const cx = bb.minX + bb.w / 2;
    const cy = bb.minY + bb.h / 2;

    c.strokeStyle = '#7df5c5';
    c.lineWidth = 1.5;
    c.lineCap = 'round';
    c.beginPath();

    normalisedPoints.forEach((p, i) => {
      // Translate so centroid is at swatch centre, then scale.
      const x = (p.x - cx) * scale + size / 2;
      const y = (p.y - cy) * scale + size / 2;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    c.stroke();

    // Return as a data URL so it can be used directly as an <img src="...">.
    return cv.toDataURL();
  }

  // Rebuild the list from the current classifier state.
  function renderList() {
    const all = GestureClassifier.getAll();
    countEl.textContent = `${all.length} stored`;

    if (all.length === 0) {
      listEl.innerHTML = '<div class="gesture-empty">Switch to Record mode to capture a gesture</div>';
      return;
    }

    listEl.innerHTML = all.map((g, i) => `
      <div class="gesture-item">
        <img class="gesture-swatch" src="${g.swatch}" alt="" />
        <span class="gesture-name">${escapeHtml(g.label)}</span>
        <button class="gesture-remove" data-idx="${i}" title="Remove">×</button>
      </div>
    `).join('');

    // Wire up remove buttons (re-bound each render because due to rebuilding innerHTML).
    listEl.querySelectorAll('.gesture-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        GestureClassifier.removeTemplate(parseInt(btn.dataset.idx, 10));
        renderList();
      });
    });
  }

  // Safe-insert user-supplied gesture names into HTML.
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  // Show or hide the prediction box (called from ModeController).
  function setPredictVisible(v) {
    predictBox.style.display = v ? 'block' : 'none';
  }

  // Update the prediction display with a classification result.
  // result = { label, confidence } | null
  function updatePrediction(result) {
    // Confidence under 20% is not siginficant enough, therefore drop it.
    if (!result || result.confidence < 0.2) {
      predictLabel.textContent = 'Unknown gesture';
      predictLabel.classList.add('none');
      predictConf.textContent = 'no match';
      predictFill.style.width = '0%';
      return;
    }
    predictLabel.textContent = result.label;
    predictLabel.classList.remove('none');
    predictConf.textContent = `confidence ${(result.confidence * 100).toFixed(0)}%`;
    predictFill.style.width = (result.confidence * 100) + '%';
  }

  // Clear the prediction display back to its empty state. Called on
  // entering classify mode.
  function resetPrediction() {
    predictLabel.textContent = 'Draw to classify';
    predictLabel.classList.add('none');
    predictConf.textContent = 'awaiting stroke';
    predictFill.style.width = '0%';
  }

  // Initial render so restored gestures show up on page load.
  renderList();

  return { renderList, setPredictVisible, updatePrediction, resetPrediction, drawSwatch };
})();


/* ─── 9. ModeController ───────────────────────────────────────────────────
   Central switcher. Drives:
     - .active class on the mode tab buttons
     - SurfaceRenderer.setMode() so drawing logic knows which mode we're in
     - DataPanel.setMode() for the MODE overlay
     - GesturePanel predict visibility
     - Showing/hiding mode-specific panel sections (gesture library,
       advanced controls) */
const ModeController = (() => {
  let current = 'free';
  const buttons = document.querySelectorAll('.mode-btn');
  const gestureSection = document.getElementById('gestureSection');
  const advSection = document.getElementById('advSection');

  function set(mode) {
    current = mode;

    // Update tab bar active state.
    buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

    // Notify dependent modules.
    SurfaceRenderer.setMode(mode);
    DataPanel.setMode(mode);
    GesturePanel.setPredictVisible(mode === 'classify');
    if (mode === 'classify') GesturePanel.resetPrediction();

    // Gesture library is only relevant in record and classify modes.
    if (gestureSection) {
      gestureSection.style.display = (mode === 'record' || mode === 'classify') ? '' : 'none';
    }

    // Advanced controls only affect heatmap behaviour, so hide them
    // everywhere else to keep the panel uncluttered.
    if (advSection) {
      advSection.style.display = (mode === 'heatmap') ? '' : 'none';
    }
  }

  // Wire up the tab buttons.
  buttons.forEach(b => b.addEventListener('click', () => set(b.dataset.mode)));

  function getMode() { return current; }

  return { set, getMode };
})();


/* ─── 10. Event wiring ────────────────────────────────────────────────────
   Top-level IIFE that glues everything together. Responsible for:
     - Routing TouchCapture events to SurfaceRenderer and GestureRecorder
     - The "first touch" hint fade-out
     - The gesture-naming modal dialog
     - Clear/Export buttons
     - Keyboard shortcuts (1/2/3/4 to switch modes)
     - Pressure-capability badge updates
     - Gesture library collapse toggle
     - Advanced controls (show/hide + slider binding + reset) */
(() => {

  // ── First-touch hint ──
  const stageHint = document.getElementById('stageHint');
  let hintHidden = false;

  // ── TouchCapture subscribers ──
  // On pointerdown: hide hint once, spawn ripple, begin trail, maybe start recording.
  TouchCapture.on('start', (rec) => {
    if (!hintHidden) {
      stageHint.classList.add('hidden');
      hintHidden = true;
    }
    SurfaceRenderer.addRipple(rec.x, rec.y);
    SurfaceRenderer.updateTrail(rec);

    const mode = ModeController.getMode();
    // In record AND classify mode, start a gesture capture on the first
    // active pointer. The GestureRecorder internally ignores any pointers
    // that aren't the tracked one.
    if (mode === 'record' && !GestureRecorder.isRecording()) {
      GestureRecorder.start(rec.id);
      GestureRecorder.addPoint(rec);
    } else if (mode === 'classify' && !GestureRecorder.isRecording()) {
      GestureRecorder.start(rec.id);
      GestureRecorder.addPoint(rec);
    }
  });

  // On move: extend trail and (if recording) extend gesture stroke.
  TouchCapture.on('move', (rec) => {
    SurfaceRenderer.updateTrail(rec);
    GestureRecorder.addPoint(rec);
  });

  // On end: stop gesture recording; if it produced a meaningful stroke,
  // handle it per current mode.
  TouchCapture.on('end', (rec) => {
    SurfaceRenderer.clearTrail(rec.id);
    const stroke = GestureRecorder.stop(rec.id);
    if (!stroke) return;   // too short or not our tracked pointer

    const mode = ModeController.getMode();
    if (mode === 'record') {
      // Open the "Name this gesture" modal.
      showNameModal(stroke);
    } else if (mode === 'classify') {
      // Run nearest-neighbour match and update the UI.
      const result = GestureClassifier.predict(stroke.normalised);
      GesturePanel.updatePrediction(result);
    }
  });


  // ── Gesture naming modal ──
  const modal = document.getElementById('modal');
  const nameInput = document.getElementById('gestureNameInput');
  const btnCancel = document.getElementById('modalCancel');
  const btnSave = document.getElementById('modalSave');
  let pendingStroke = null;

  function showNameModal(stroke) {
    pendingStroke = stroke;
    nameInput.value = '';
    modal.classList.add('active');
    // setTimeout 50 so iOS Safari actually focuses the input reliably
    // (direct focus() can be ignored if the modal hasn't finished rendering).
    setTimeout(() => nameInput.focus(), 50);
  }

  function hideModal() {
    modal.classList.remove('active');
    pendingStroke = null;
  }

  function saveGesture() {
    const label = nameInput.value.trim();
    // Empty label or no pending stroke → treat as cancel.
    if (!label || !pendingStroke) {
      hideModal();
      return;
    }
    const swatch = GesturePanel.drawSwatch(pendingStroke.normalised);
    GestureClassifier.addTemplate(label, pendingStroke.normalised, swatch);
    GesturePanel.renderList();
    hideModal();
  }

  btnCancel.addEventListener('click', hideModal);
  btnSave.addEventListener('click', saveGesture);
  // Enter saves, Escape discards — standard modal keyboard patterns.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveGesture();
    if (e.key === 'Escape') hideModal();
  });
  // Click outside the card (on the dim backdrop) also closes.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideModal();
  });


  // ── Clear / Export buttons in the gesture library ──
  document.getElementById('btnClearGestures').addEventListener('click', () => {
    if (confirm('Clear all saved gestures?')) {
      GestureClassifier.clear();
      GesturePanel.renderList();
    }
  });

  // Export all saved gestures as a JSON file download.
  document.getElementById('btnExport').addEventListener('click', () => {
    const data = JSON.stringify(GestureClassifier.getAll(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'touch-symphony-gestures.json';
    a.click();
    URL.revokeObjectURL(url);
  });


  // ── Keyboard shortcuts ──
  // 1/2/3/4 switch modes. Ignored while typing in an input.
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const map = { '1': 'free', '2': 'heatmap', '3': 'record', '4': 'classify' };
    if (map[e.key]) ModeController.set(map[e.key]);
  });


  // ── Pressure-capability badge ──
  // Listen for the CustomEvent fired from TouchCapture.detectPressureMode.
  const capBadge = document.getElementById('capBadge');
  const capBadgeText = document.getElementById('capBadgeText');
  document.addEventListener('pressuremode', (e) => {
    const mode = e.detail;
    if (mode === 'native') {
      capBadge.classList.add('native');
      capBadgeText.textContent = 'Native Pressure';
      capBadge.title = 'Your device reports real pressure values from hardware (stylus, 3D Touch, or Force Touch).';
    } else if (mode === 'synthesised') {
      capBadge.classList.add('synthesised');
      capBadgeText.textContent = 'No Sensor';
      capBadge.title = 'Your device has no pressure-sensing hardware, so pressure reads as a flat maximum. Real pressure requires a stylus, 3D Touch, or Force Touch — the kind of sensing gap that smart-surface technologies are designed to fill.';
    }
  });


  // ── Gesture library collapse toggle ──
  // See the CSS comment on .collapsible-body as to why managing an
  // `animating` class separately from `collapsed` is necessary.
  const gCollapseToggle = document.getElementById('gestureCollapseToggle');
  const gBody = document.getElementById('gestureBody');
  const gChevron = document.getElementById('gestureChevron');
  if (gCollapseToggle) {
    gCollapseToggle.addEventListener('click', () => {
      const willCollapse = !gBody.classList.contains('collapsed');

      // Add `animating` first. This applies the `overflow: hidden` +
      // `max-height: 2000px` cap throughout the transition. Without this,
      // expanding-from-0 would jump to full height instantly (no max-height
      // defined to animate TO), and collapsing would spill content out the
      // bottom before opacity catches up.
      gBody.classList.add('animating');

      // Force a style recalc so the browser registers the `.animating`
      // starting styles BEFORE toggle `.collapsed`. Without this reflow,
      // the transition can snap straight to the final state.
      void gBody.offsetHeight;

      gBody.classList.toggle('collapsed', willCollapse);
      gChevron.classList.toggle('collapsed', willCollapse);
      gCollapseToggle.setAttribute('aria-expanded', String(!willCollapse));

      // Once the transition finishes, remove `animating` IF it ended up
      // expanded. Leaving `overflow: hidden` + `max-height: 2000px` on the
      // expanded element would recreate the mobile scroll trap that made
      // buttons below unreachable.
      setTimeout(() => {
        if (!gBody.classList.contains('collapsed')) {
          gBody.classList.remove('animating');
        }
      }, 260);   // slightly longer than the 250ms CSS transition
    });
  }


  // ── Advanced controls: show/hide toggle ──
  const advToggle = document.getElementById('advToggle');
  const advGroup = document.getElementById('advGroup');
  const advReset = document.getElementById('advReset');
  const advHide = document.getElementById('advHide');

  function setAdvOpen(open) {
    advGroup.classList.toggle('open', open);
    advToggle.textContent = open ? '▾ Advanced Controls' : '▸ Advanced Controls';
  }
  advToggle.addEventListener('click', () => setAdvOpen(!advGroup.classList.contains('open')));
  advHide.addEventListener('click', () => setAdvOpen(false));


  // ── Advanced controls: slider binding ──
  // Each slider has data-cfg="<configKey>" and each readout span has
  // data-val="<configKey>". Auto-wire all sliders without needing a
  // hand-written handler per slider.

  // Per-key value formatters. Some keys need more decimals than others
  // (decay needs 4 because differences at the 3rd decimal matter; ramp
  // time is an integer ms count; etc.)
  const formatters = {
    heatDecay:       v => v.toFixed(4),
    heatAccumBase:   v => v.toFixed(2),
    heatAccumCap:    v => v.toFixed(1),
    heatMinAlpha:    v => v.toFixed(2),
    heatFadeThresh:  v => v.toFixed(2),
    velocityWeight:  v => v.toFixed(2),
    velocityFastPx:  v => v.toFixed(1),
    dwellWeight:     v => v.toFixed(2),
    dwellMaxBonus:   v => v.toFixed(2),
    dwellRampMs:     v => Math.round(v).toString(),
  };

  const sliders = document.querySelectorAll('.adv-slider');
  sliders.forEach(slider => {
    const key = slider.dataset.cfg;
    const valEl = document.querySelector(`[data-val="${key}"]`);
    const format = formatters[key] || (v => v.toFixed(2));

    // Pull the current Config value and push it into the slider + readout.
    function sync() {
      const v = Config.get(key);
      slider.value = v;
      if (valEl) valEl.textContent = format(v);
    }

    // User dragged the slider → write to Config and update our readout.
    // Other modules read Config live, so their behaviour updates on the
    // next frame automatically.
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      Config.set(key, v);
      if (valEl) valEl.textContent = format(v);
    });

    // Listen for external changes (e.g. Reset button) so our slider and
    // readout stay in sync. key === null means "refresh everything".
    Config.onChange((changedKey) => {
      if (changedKey === null || changedKey === key) sync();
    });

    sync();   // Initial population from defaults.
  });


  // ── Reset button: restore all Config values to factory defaults. ──
  advReset.addEventListener('click', () => {
    Config.reset();
  });

})();
