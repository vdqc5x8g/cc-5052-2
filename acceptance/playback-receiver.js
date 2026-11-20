import { clamp, wrapPi } from "../shared/mathx.js";
import { renderToServer, fixedDelayMapping } from "./clock-mapping.js";

// Offline playback receiver used by the acceptance harness. It rebuilds what a
// browser display layer does, but driven by an explicit render clock so the
// same trace can be presented at any frame rate deterministically.
//
// Policies:
//   monotone (default): the playhead never moves backwards; late packets fill
//     history gaps, recovery catches up by rate-limited forward motion;
//   snapback: a late packet that falls behind the playhead yanks the playhead
//     to it, producing a visible backward correction during buffer recovery;
//   stale: repeated/late samples are re-adopted as if they were new, pinning
//     the picture to an old source instant;
//   headingFreeze: position tracking is correct but heading is never updated,
//     used on the spinner to expose a metric that only measures distance.

export const POLICIES = ["monotone", "snapback", "stale", "headingFreeze"];

function headingLerp(a, b, f) {
  return wrapPi(a + wrapPi(b - a) * f);
}

export class PlaybackReceiver {
  constructor({
    playoutDelayMs = 200,
    maxExtrapolationMs = 300,
    policy = "monotone",
    primeOnCount = 2,
    autoDelay = false,
    snapshotIntervalMs = 50,
  } = {}) {
    this.playoutDelayMs = playoutDelayMs;
    this.maxExtrapolationMs = maxExtrapolationMs;
    this.policy = policy;
    this.primeOnCount = primeOnCount;
    this.autoDelay = autoDelay;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.minArrivalOffset = Infinity;
    this.reset();
  }

  reset() {
    this.buffer = []; // {t, pose} sorted by source t
    this.seenT = new Set();
    this.duplicates = 0;
    this.playheadMs = null;
    this.primed = false;
    this.lastArrivedT = -Infinity;
    this.staleT = undefined;
    this.snapbackT = undefined;
    this.lastRenderMs = null;
  }

  // The receiver keeps its own clock conversion. In autoDelay mode it derives
  // the playout offset independently from observed arrivals (minimum one-way
  // latency plus one snapshot interval), instead of trusting a configured
  // constant that may not match this link.
  mapping() {
    return fixedDelayMapping(this.playoutDelayMs);
  }

  ingest(delivery) {
    const t = delivery.t;
    const pose = delivery.pose;
    if (this.autoDelay && !delivery.duplicate) {
      this.minArrivalOffset = Math.min(this.minArrivalOffset, delivery.arriveAtMs - t);
      this.playoutDelayMs = this.minArrivalOffset + this.snapshotIntervalMs;
    }
    if (this.seenT.has(t)) {
      this.duplicates += 1;
      if (this.policy === "snapback") {
        // Faulty: a repeated late packet is treated as a fresh authority and
        // the playhead is allowed to jump back to its old source instant on
        // the next step.
        this.snapbackT = t;
        return { accepted: true, reason: "snapback-armed" };
      }
      if (this.policy !== "stale") return { accepted: false, reason: "duplicate" };
    }
    if (this.policy === "stale" && this.lastArrivedT > -Infinity && t < this.lastArrivedT) {
      // Faulty: adopt the late sample as the newest authority even though its
      // source time is older. Subsequent playhead targets then point backward.
      this.staleT = t;
      this.lastArrivedT = t;
      return { accepted: true, reason: "stale-adopted" };
    }
    this.seenT.add(t);
    this.lastArrivedT = Math.max(this.lastArrivedT, t);
    let lo = 0;
    let hi = this.buffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.buffer[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    this.buffer.splice(lo, 0, { t, pose });
    if (!this.primed && this.buffer.length >= this.primeOnCount) this.primed = true;
    return { accepted: true, reason: "inserted" };
  }

  newestT() {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].t : null;
  }

  evaluateAt(sourceMs) {
    const buf = this.buffer;
    if (!buf.length) return { mode: "empty", pose: null, window: null };
    if (sourceMs < buf[0].t) {
      return { mode: "prebuffer", pose: buf[0].pose, window: { tA: buf[0].t, tB: buf[0].t } };
    }
    let i = 0;
    while (i < buf.length - 1 && buf[i + 1].t <= sourceMs) i += 1;
    if (i < buf.length - 1) {
      const a = buf[i];
      const b = buf[i + 1];
      const span = b.t - a.t || 1;
      const f = clamp((sourceMs - a.t) / span, 0, 1);
      const pose = {
        ...a.pose,
        x: a.pose.x + (b.pose.x - a.pose.x) * f,
        z: a.pose.z + (b.pose.z - a.pose.z) * f,
      };
      if (this.policy === "headingFreeze") {
        // Position interpolates normally; the displayed heading is pinned to
        // the first observed orientation, the exact jitter a distance-only
        // metric cannot detect.
        pose.heading = buf[0].pose.heading;
      } else {
        pose.heading = headingLerp(a.pose.heading, b.pose.heading, f);
      }
      return { mode: "interp", pose, window: { tA: a.t, tB: b.t, f } };
    }
    const last = buf[buf.length - 1];
    const beyond = sourceMs - last.t;
    if (beyond <= this.maxExtrapolationMs + 1e-9) {
      const prev = buf[buf.length - 2] ?? last;
      const span = Math.max(1, last.t - prev.t);
      const g = Math.min(beyond, this.maxExtrapolationMs);
      const pose = {
        ...last.pose,
        x: last.pose.x + ((last.pose.x - prev.pose.x) / span) * g,
        z: last.pose.z + ((last.pose.z - prev.pose.z) / span) * g,
      };
      if (this.policy === "headingFreeze" && buf.length > 1) {
        pose.heading = buf[0].pose.heading;
      }
      return { mode: "extrap", pose, window: { baseT: last.t, beyondMs: beyond, limitMs: this.maxExtrapolationMs } };
    }
    return {
      mode: "held",
      pose: last.pose,
      window: { baseT: last.t, beyondMs: beyond, limitMs: this.maxExtrapolationMs },
    };
  }

  // One rendered frame at wall/render time renderMs, with deliveries whose
  // arrival time has passed already applied by the harness.
  step(renderMs) {
    if (!this.primed) {
      this.lastRenderMs = renderMs;
      return {
        renderMs,
        sourceMs: null,
        mode: "priming",
        pose: null,
        playheadMs: null,
        regressionMs: 0,
      };
    }
    const targetMs = renderToServer(renderMs, this.mapping());
    const newest = this.newestT();
    const ceiling = newest + this.maxExtrapolationMs;
    const dt = this.lastRenderMs === null ? 0 : Math.max(0, renderMs - this.lastRenderMs);
    let next;
    if (this.playheadMs === null) {
      next = Math.min(targetMs, newest);
    } else if (this.policy === "snapback" && this.snapbackT !== undefined && this.snapbackT < this.playheadMs) {
      next = this.snapbackT; // faulty: visible rewind to the late old sample
      this.snapbackT = undefined;
    } else if (this.policy === "snapback" && targetMs < this.playheadMs) {
      next = targetMs; // faulty: visible rewind
    } else if (targetMs >= this.playheadMs) {
      // Forward motion only. Catch-up from a stall runs faster than real time
      // (up to 4x) but never beyond the target, so recovery cannot overshoot
      // and need a backward correction later.
      const maxStep = dt * 4;
      next = Math.min(targetMs, this.playheadMs + Math.max(dt, maxStep));
      if (next > ceiling) {
        // Feed starvation: freeze absolutely at the extrapolation ceiling
        // rather than ride it upward packet by packet.
        next = ceiling;
      }
      if (this.policy === "stale" && this.staleT !== undefined) {
        next = Math.min(next, this.staleT);
      }
    } else {
      // Target fell behind an already-frozen playhead (a stalled feed): hold
      // position until fresh data pushes the ceiling back above it.
      next = this.playheadMs;
    }
    const regressionMs = this.playheadMs !== null ? Math.max(0, this.playheadMs - next) : 0;
    this.playheadMs = next;
    this.lastRenderMs = renderMs;
    const evalRes = this.evaluateAt(next);
    return {
      renderMs,
      sourceMs: next,
      mode: evalRes.mode,
      pose: evalRes.pose,
      window: evalRes.window,
      regressionMs,
    };
  }
}
