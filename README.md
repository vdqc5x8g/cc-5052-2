# Hover Race — Spectator Display Layer

A networked hover-racing spectator scene. A Node server simulates remote craft on
a known track and streams timestamped snapshots over a simulated lossy link. The
browser builds a timestamp-indexed interpolation buffer and presents position and
heading behind a controlled delay — never snapping the model to each arriving
packet, never guessing forever for a lost one.

## Launching the interface

```bash
npm install
npm start
```

Then open **http://localhost:8080** in a browser.

- Change the port with `PORT=8099 npm start` (the URL follows).
- The page and the WebSocket share the same origin, so no separate client build
  or dev server is needed; `public/main.js` is served as an ES module and Three.js
  is served from `/vendor/`.

## What you are looking at

- **Display lag** — how far the drawn picture trails the newest authority
  timestamp. This is the buffer delay, not "time since the last packet".
- **Mode** — `INTERP` (smooth playback between two authority samples),
  `EXTRAP +Nms` (brief bounded guess while data is late), or `HELD` (feed stalled;
  the pose is frozen).
- **Time scale** — 1.000× is real time. The clock speed-varies to absorb drift;
  it slows below 1× near starvation and shows `held` at 0×.
- **Buffer** — packets retained and the headroom ahead of the cursor.

### Controls

| Input | Action |
| --- | --- |
| `W` / `S` / `A` / `D` (or arrows) | Drive JUNO: throttle / brake / steer |
| `Space` | Force a 1200 ms packet blackout |
| `C` | Cycle camera target |
| `T` | Toggle the authority-trajectory overlay |
| `P` | Pause / resume the display trail |
| Left sliders | Latency, jitter, loss %, burst chance (server-injected) |
| Delay slider | Display delay / reorder depth (0–800 ms) |
| Drag / wheel | Orbit / zoom the camera |

The left panel also lists each remote craft and the drivable JUNO (marked
`local control`). The right panel grades the display against server truth.

## How the display layer works

1. **Buffer by source time, not arrival order.** Snapshots are inserted in
   timestamp order; a late packet fills a gap rather than overwriting state.
2. **Decoupled display clock.** The cursor's target is `newest source t − delay`.
   Drift is absorbed by ±8 % rate nudging; it only jumps for a genuinely broken
   timeline, and that jump is reported in the HUD and event log.
3. **Bounded extrapolation, then stop.** Extrapolation is capped
   (`maxExtrapolationMs`, default 250 ms). At the cap the pose freezes
   absolutely and does not ride the moving "newest + cap" ceiling, so a
   recovering feed cannot drag the frozen model forward one packet at a time.
   Heading is never extrapolated.
4. **No concealed jumps.** There is no post-process motion blur. Time is
   dilated instead of snapped, and any reported resync resets the continuity
   baseline so it is counted once, honestly.

## Interpolation state and metrics

The results panel reports, per frame, against the analytic truth motion:

- display lag (ms) and clock mode / time scale,
- position error (avg / max, metres) and heading error (avg / max, degrees),
- discontinuities — per-frame motion faster than a craft can physically move,
  judged on the presented timeline so a legitimate catch-up is not miscounted,
- clock resyncs (reported, not hidden),
- extrapolated / held frame ratios,

plus buffer depth, packets received / lost, and out-of-order / duplicate counts.

## Tests

```bash
npm test
```

Covers buffer ordering and dedupe, bounded extrapolation and the frozen hold,
short-arc heading interpolation with a bad-data guard, clock rate nudging vs.
resync, metric classification, and a deterministic end-to-end harness
(server tick → simulated network → buffer → clock → metrics).
