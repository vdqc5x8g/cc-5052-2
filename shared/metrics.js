import { wrapPi } from "../shared/mathx.js";

// Sliding-window metrics for the display layer. All timings are in ms and
// positions in metres. Truth is the analytic path for remote vehicles.
export class DisplayMetrics {
  constructor(windowMs = 6000) {
    this.windowMs = windowMs;
    this.rows = [];
    this.discontinuities = 0;
    this.lastPose = new Map();
    this.lastTruth = new Map();
    this.prevMode = null;
    this.modeChanges = 0;
  }

  reset() {
    this.rows = [];
    this.discontinuities = 0;
    this.lastPose.clear();
    this.lastTruth.clear();
    this.prevMode = null;
    this.modeChanges = 0;
  }

  // Drop the per-frame continuity baseline without discarding the window. Used
  // when a discontinuity was intentional and already reported (clock resync),
  // so the deliberate skip is not double-counted as a rendering glitch.
  resetContinuity() {
    this.lastPose.clear();
  }

  add({ atMs, mode, vehicles, truth, displayT }) {
    const byId = new Map(truth.map((v) => [v.id, v]));
    // Continuity is judged against presented time, not raw wall time. During
    // catch-up the cursor runs faster than real time, so dividing by the wall
    // gap would report perfectly smooth motion as a teleport. A static pose that
    // changes anyway (a correction while frozen) is still a real jump, though,
    // and there presented time does not advance — so use whichever gap is
    // larger: the motion must be plausible on both timelines.

    let worstPos = 0;
    let worstHead = 0;
    let count = 0;
    for (const shown of vehicles) {
      const t = byId.get(shown.id);
      if (!t) continue;
      const posErr = Math.hypot(shown.x - t.x, shown.y - t.y, shown.z - t.z);
      const headErr = Math.abs(wrapPi(shown.heading - t.heading));
      worstPos = Math.max(worstPos, posErr);
      worstHead = Math.max(worstHead, headErr);
      count += 1;

      const prev = this.lastPose.get(shown.id);
      if (prev && prev.displayT !== undefined && displayT !== undefined && prev.atMs !== undefined) {
        const timelineGapSec = (displayT - prev.displayT) / 1000;
        const wallGapSec = (atMs - prev.atMs) / 1000;
        const gapSec = Math.max(timelineGapSec, wallGapSec);
        if (gapSec > 0.002) {
          const jump = Math.hypot(shown.x - prev.x, shown.y - prev.y, shown.z - prev.z);
          const dHead = Math.abs(wrapPi(shown.heading - prev.heading));
          // Anything faster than a hover craft can physically move is a visual
          // discontinuity: a teleport, not motion.
          if (jump / gapSec > 150 || dHead / gapSec > 9.5) this.discontinuities += 1;
        }
      }
      this.lastPose.set(shown.id, {
        x: shown.x,
        y: shown.y,
        z: shown.z,
        heading: shown.heading,
        atMs,
        displayT,
      });
      this.lastTruth.set(shown.id, { x: t.x, y: t.y, z: t.z, heading: t.heading });
    }

    if (mode !== this.prevMode) {
      if (this.prevMode !== null) this.modeChanges += 1;
      this.prevMode = mode;
    }

    this.rows.push({ atMs, mode, posErr: worstPos, headErr: worstHead, count, displayT });
    const cutoff = atMs - this.windowMs;
    while (this.rows.length > 0 && this.rows[0].atMs < cutoff) this.rows.shift();
  }

  summary(netStats = null) {
    const n = this.rows.length;
    if (n === 0) {
      return {
        samples: 0,
        posErrAvg: 0, posErrMax: 0,
        headErrAvgDeg: 0, headErrMaxDeg: 0,
        discontinuities: this.discontinuities,
        modeChanges: this.modeChanges,
        extrapRatio: 0, heldRatio: 0,
        net: netStats,
      };
    }
    let pSum = 0;
    let pMax = 0;
    let hSum = 0;
    let hMax = 0;
    let extrap = 0;
    let held = 0;
    for (const r of this.rows) {
      pSum += r.posErr;
      pMax = Math.max(pMax, r.posErr);
      hSum += r.headErr;
      hMax = Math.max(hMax, r.headErr);
      if (r.mode === "extrap") extrap += 1;
      if (r.mode === "held") held += 1;
    }
    return {
      samples: n,
      posErrAvg: pSum / n,
      posErrMax: pMax,
      headErrAvgDeg: (hSum / n) * (180 / Math.PI),
      headErrMaxDeg: hMax * (180 / Math.PI),
      discontinuities: this.discontinuities,
      modeChanges: this.modeChanges,
      extrapRatio: extrap / n,
      heldRatio: held / n,
      net: netStats,
    };
  }
}

// Lag of the drawn picture relative to the newest authority timestamp.
export function displayLagMs(newestT, displayT) {
  if (!Number.isFinite(newestT) || !Number.isFinite(displayT)) return null;
  return newestT - displayT;
}
