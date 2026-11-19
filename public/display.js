import { clamp, wrapPi } from "../shared/mathx.js";

export const MAX_TURN_RATE = 9.5; // rad/s, safety ceiling for a hover craft
export const HEADING_GUARD = 2.4; // rad per sample pair beyond this is bad data

export const DEFAULT_BUFFER_OPTIONS = Object.freeze({
  historyMs: 8000,
  maxExtrapolationMs: 250,
  maxSpeedForExtrapolation: 130,
});

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateStatePacket(packet, requiresEpoch) {
  if (!packet || typeof packet !== "object") return false;
  if (packet.type !== "state") return false;
  if (!isFiniteNum(packet.seq) || !isFiniteNum(packet.t)) return false;
  if (!Array.isArray(packet.vehicles) || packet.vehicles.length === 0) return false;
  if (requiresEpoch && packet.epoch === undefined) return false;
  for (const v of packet.vehicles) {
    if (!v || typeof v.id !== "string") return false;
    for (const key of ["x", "y", "z", "heading", "bank", "speed"]) {
      if (!isFiniteNum(v[key])) return false;
    }
  }
  return true;
}

// Interpolate heading along the shortest arc. A delta larger than the guard is
// treated as bad data (a teleported or corrupt sample), not a rotation: hold
// the earlier heading and flag it instead of spinning the model through.
export function interpolateHeading(a, b, f) {
  const delta = wrapPi(b - a);
  if (Math.abs(delta) > HEADING_GUARD) {
    return { heading: a, suspicious: true, delta };
  }
  return { heading: a + delta * f, suspicious: false, delta };
}

function normAngle(a) {
  return wrapPi(a);
}

// Timestamp-indexed history of authoritative snapshots. Samples are ordered by
// their source timestamp, never by arrival order; the evaluator only ever
// interpolates between two bracketing source times.
export class DisplayBuffer {
  constructor(options = {}) {
    this.historyMs = options.historyMs ?? DEFAULT_BUFFER_OPTIONS.historyMs;
    this.samples = [];
    this.seqSeen = new Set();
    this.tSeen = new Set();
    this.maxSeq = -1;
    this.epoch = null;
    this.stats = {
      received: 0,
      duplicates: 0,
      outOfOrder: 0,
      missing: 0,
      malformed: 0,
      suspiciousHeadings: 0,
      trimmed: 0,
    };
  }

  reset() {
    this.samples = [];
    this.seqSeen.clear();
    this.tSeen.clear();
    this.maxSeq = -1;
    this.epoch = null;
  }

  ingest(packet) {
    if (!validateStatePacket(packet, this.epoch !== null)) {
      this.stats.malformed += 1;
      return { ok: false, reason: "malformed" };
    }
    if (this.epoch === null) this.epoch = packet.epoch ?? 0;
    else if (packet.epoch !== undefined && packet.epoch !== this.epoch) {
      this.reset();
      this.epoch = packet.epoch;
    }

    if (this.seqSeen.has(packet.seq) || this.tSeen.has(packet.t)) {
      this.stats.duplicates += 1;
      return { ok: false, reason: "duplicate" };
    }

    if (packet.seq < this.maxSeq) this.stats.outOfOrder += 1;
    else {
      if (this.maxSeq >= 0 && packet.seq > this.maxSeq + 1) {
        this.stats.missing += packet.seq - this.maxSeq - 1;
      }
      this.maxSeq = packet.seq;
    }
    this.seqSeen.add(packet.seq);
    this.tSeen.add(packet.t);

    const sample = {
      t: packet.t,
      seq: packet.seq,
      vehicles: packet.vehicles.map((v) => ({ ...v })),
    };
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].t < sample.t) lo = mid + 1;
      else hi = mid;
    }
    this.samples.splice(lo, 0, sample);
    this.stats.received += 1;

    const newest = this.samples[this.samples.length - 1].t;
    const cutoff = newest - this.historyMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) {
      const old = this.samples.shift();
      this.tSeen.delete(old.t);
      this.stats.trimmed += 1;
    }
    return { ok: true, insertedAt: lo };
  }

  get newestT() {
    return this.samples.length ? this.samples[this.samples.length - 1].t : -Infinity;
  }

  get oldestT() {
    return this.samples.length ? this.samples[0].t : Infinity;
  }

  get depth() {
    return this.samples.length;
  }

  get spanMs() {
    return this.samples.length > 1 ? this.newestT - this.oldestT : 0;
  }

  findIndex(t) {
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  evaluate(displayT, options = {}) {
    const maxExtrapolationMs =
      options.maxExtrapolationMs ?? DEFAULT_BUFFER_OPTIONS.maxExtrapolationMs;
    const maxSpeed =
      options.maxSpeedForExtrapolation ?? DEFAULT_BUFFER_OPTIONS.maxSpeedForExtrapolation;
    const n = this.samples.length;
    const base = { displayT, newestT: this.newestT, oldestT: this.oldestT, depth: n };
    if (n === 0) return { ...base, mode: "empty", vehicles: [], reason: "no samples" };

    if (displayT <= this.samples[0].t) {
      return {
        ...base,
        mode: "prebuffer",
        vehicles: cloneVehicles(this.samples[0].vehicles),
        ageMs: this.samples[0].t - displayT,
        reason: "display clock behind oldest buffered sample",
      };
    }

    const i = this.findIndex(displayT);
    if (i >= 0 && i < n - 1) {
      const a = this.samples[i];
      const b = this.samples[i + 1];
      const span = b.t - a.t || 1;
      const f = clamp((displayT - a.t) / span, 0, 1);
      const vehicles = [];
      for (const va of a.vehicles) {
        const vb = findVehicle(b.vehicles, va.id);
        if (!vb) continue;
        const h = interpolateHeading(va.heading, vb.heading, f);
        if (h.suspicious) this.stats.suspiciousHeadings += 1;
        vehicles.push({
          id: va.id,
          x: va.x + (vb.x - va.x) * f,
          y: va.y + (vb.y - va.y) * f,
          z: va.z + (vb.z - va.z) * f,
          heading: normAngle(h.heading),
          bank: va.bank + (vb.bank - va.bank) * f,
          speed: va.speed + (vb.speed - va.speed) * f,
        });
      }
      return {
        ...base,
        mode: "interp",
        vehicles,
        ageMs: 0,
        segment: { tA: a.t, tB: b.t, f, spanMs: span },
      };
    }

    // Beyond the newest sample: extrapolate from the last two authority
    // samples for a strictly bounded window, then stop guessing entirely.
    // The stop pose is the pose at the limit itself, so entering a hold never
    // rewinds the picture; beyond the limit the same pose is simply repeated.
    const last = this.samples[n - 1];
    const prev = this.samples[n - 2];
    const beyondMs = displayT - last.t;
    if (n < 2) {
      return {
        ...base,
        mode: "held",
        vehicles: cloneVehicles(last.vehicles),
        ageMs: beyondMs,
        maxExtrapolationMs,
        staleMs: beyondMs,
        reason: "single sample",
      };
    }
    const settled = beyondMs > maxExtrapolationMs - 1e-6;
    const guessMs = settled ? maxExtrapolationMs : beyondMs;

    const span = Math.max(1, last.t - prev.t);
    const vehicles = [];
    for (const vl of last.vehicles) {
      const vp = findVehicle(prev.vehicles, vl.id);
      if (!vp) continue;
      let vx = (vl.x - vp.x) / span;
      let vy = (vl.y - vp.y) / span;
      let vz = (vl.z - vp.z) / span;
      const speedMag = Math.hypot(vx, vy, vz) * 1000;
      if (speedMag > maxSpeed) {
        const k = maxSpeed / speedMag;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      vehicles.push({
        id: vl.id,
        x: vl.x + vx * guessMs,
        y: vl.y + vy * guessMs,
        z: vl.z + vz * guessMs,
        // Rotation is never guessed: hold the last known heading.
        heading: normAngle(vl.heading),
        bank: vl.bank,
        speed: vl.speed,
      });
    }
    if (settled) {
      return {
        ...base,
        mode: "held",
        vehicles,
        ageMs: beyondMs,
        maxExtrapolationMs,
        staleMs: beyondMs,
        frozenAtMs: maxExtrapolationMs,
        reason: "extrapolation limit reached",
      };
    }
    return {
      ...base,
      mode: "extrap",
      vehicles,
      ageMs: beyondMs,
      maxExtrapolationMs,
      remainingMs: maxExtrapolationMs - beyondMs,
      reason: "awaiting newer authority sample",
    };
  }
}

function findVehicle(list, id) {
  return list.find((v) => v.id === id);
}

function cloneVehicles(list) {
  return list.map((v) => ({
    id: v.id,
    x: v.x,
    y: v.y,
    z: v.z,
    heading: normAngle(v.heading),
    bank: v.bank,
    speed: v.speed,
  }));
}

export const DEFAULT_CLOCK_OPTIONS = Object.freeze({
  delayMs: 300,
  maxRateAdjust: 0.08,
  resyncLagMs: 700,
  maxExtrapolationMs: 250,
  minBufferedMs: null, // defaults to delayMs: buffer must cover the delay
  starveGuardMs: 90, // start slowing down when this little data remains ahead
  starveRate: 0.55, // minimum time-dilation factor while starving
});

// The display clock is independent of packet arrival. It advances with local
// time and its *target* is (newest source timestamp - display delay); small
// discrepancies are absorbed by rate nudging, never by snapping.
export class DisplayClock {
  constructor(options = {}) {
    this.options = { ...DEFAULT_CLOCK_OPTIONS, ...options };
    this.displayT = null;
    this.initialized = false;
    this.priming = true;
    this.rate = 1;
    this.clamped = false;
    this.frozenT = null;
    this.catchUp = false;
    this.resyncs = 0;
    this.lastResync = null;
    this.heldMs = 0;
    this.lastStepMs = 0;
    this.starving = false;
    this.displayTBefore = null;
    this.resyncEvent = null;
  }

  setOptions(patch) {
    Object.assign(this.options, patch);
  }

  reset() {
    this.displayT = null;
    this.initialized = false;
    this.priming = true;
    this.rate = 1;
    this.clamped = false;
    this.frozenT = null;
    this.catchUp = false;
    this.starving = false;
    this.heldMs = 0;
    this.displayTBefore = null;
    this.resyncEvent = null;
  }

  advance(localDtMs, buffer) {
    const { delayMs, maxRateAdjust, resyncLagMs, maxExtrapolationMs, starveGuardMs, starveRate } =
      this.options;
    const minBuffered = this.options.minBufferedMs ?? delayMs;
    const dt = clamp(localDtMs, 0, 120);
    this.lastStepMs = dt;

    if (buffer.depth === 0) {
      this.clamped = false;
      this.frozenT = null;
      return { ...this.status(), priming: true, bufferedMs: 0, neededMs: minBuffered };
    }

    const newest = buffer.newestT;

    // Wait until the buffer covers the whole display delay before starting.
    // Otherwise the clock would immediately run ahead of the data and have to
    // extrapolate from the very first packet.
    if (!this.initialized) {
      if (buffer.spanMs + 1e-9 < minBuffered) {
        this.priming = true;
        return {
          ...this.status(),
          priming: true,
          bufferedMs: buffer.spanMs,
          neededMs: minBuffered,
        };
      }
      this.priming = false;
      this.displayT = Math.max(buffer.oldestT, newest - delayMs);
      this.initialized = true;
      this.rate = 1;
      this.catchUp = false;
      this.starving = false;
    } else {
      this.displayTBefore = this.displayT;
      const target = newest - delayMs;
      const err = target - this.displayT;
      // A frozen cursor must be excluded from the "behind" test: while held the
      // cursor sits past the newest sample by design, so its error is naturally
      // below -delay. Treating that as a broken timeline would yank the picture
      // backwards the moment the hold is entered.
      const timelineRestarted = this.clamped && newest + maxExtrapolationMs < this.frozenT - 1;
      if (err > 2000 || timelineRestarted || (!this.clamped && err < -resyncLagMs)) {
        // Only a truly broken timeline may move the cursor discontinuously. A
        // far-behind state (err < -resyncLagMs) is what a dead feed followed by
        // recovery looks like. The CLIFF IS REPORTED, never hidden: the caller
        // shows it in the HUD and metrics reset their continuity baseline.
        this.displayT = clamp(target, buffer.oldestT, newest + maxExtrapolationMs);
        this.resyncs += 1;
        this.resyncEvent = {
          errMs: err,
          jumpedMs: clamp(target, buffer.oldestT, newest + maxExtrapolationMs) - (this.displayTBefore ?? this.displayT),
          at: this.displayT,
          reason: err > 2000 ? "feed far ahead of cursor" : "cursor fell behind retained data",
        };
        this.lastResync = this.resyncEvent;
        this.rate = 1;
        this.catchUp = false;
        this.starving = false;
        this.clamped = false;
        this.frozenT = null;
      } else if (this.clamped) {
        // Absolute hold: no motion at all while the authority feed is stale.
        // Rate 0 means the pose is bit-identical frame to frame, and it cannot
        // creep along with each recovered packet.
        this.rate = 0;
        this.catchUp = true;
        this.starving = true;
        this.heldMs += dt;
      } else {
        // After a freeze or a long gap, catch up faster, but always by
        // speeding up time rather than jumping it: every frame still evaluates
        // the same interpolated timeline.
        this.catchUp = err > resyncLagMs;
        const limit = this.catchUp ? Math.max(maxRateAdjust, 0.45) : maxRateAdjust;
        let rate = clamp(1 + err / 900, 1 - limit, 1 + limit);

        // Starvation guard: near the newest sample there is no data ahead of
        // the cursor. Rather than run past it (extrapolate, then correct back
        // when the next packet lands), slow the picture down so it stays
        // inside the buffer. Time dilation is continuous; a correction seam is
        // not. Motion appears slightly slower for a moment, and the HUD says so.
        const headroom = newest - this.displayT;
        this.starving = headroom < starveGuardMs;
        if (this.starving) rate = Math.min(rate, starveRate);

        this.rate = rate;
        // Cap the step at the extrapolation ceiling instead of letting the
        // cursor overshoot and then pulling it back: an overshoot-then-rewind
        // would be a visible backward correction on the transition frame.
        this.displayT = Math.min(this.displayT + dt * this.rate, newest + maxExtrapolationMs);
      }
    }

    // Hard ceiling: never extrapolate further than maxExtrapolationMs past the
    // newest sample. Once reached the cursor freezes *absolutely* — it does not
    // track the moving ceiling, because that would advance the picture by one
    // packet interval per recovered packet: exactly the per-packet jump this
    // layer exists to avoid. It unfreezes only when real data is ahead of it.
    const ceiling = newest + maxExtrapolationMs;
    if (!this.clamped && this.initialized && this.displayT >= ceiling - 1e-6) {
      this.displayT = ceiling;
      this.clamped = true;
      this.frozenT = ceiling;
      this.heldMs = 0;
      this.rate = 0;
    }
    if (this.clamped) {
      this.displayT = this.frozenT;
      // Buffer has refilled past the frozen cursor: hand control back to the
      // rate-based catch-up path. Recovery is time dilation, never a skip.
      if (newest - delayMs > this.frozenT + 1) {
        this.clamped = false;
        this.frozenT = null;
        this.catchUp = true;
        this.heldMs = 0;
      }
    }
    // Hard floor: do not run behind the retained history window.
    if (this.displayT < buffer.oldestT) this.displayT = buffer.oldestT;

    return { ...this.status(), priming: false, bufferedMs: buffer.spanMs, neededMs: minBuffered };
  }

  status() {
    return {
      displayT: this.displayT,
      rate: this.rate,
      clamped: this.clamped,
      catchUp: this.catchUp,
      starving: this.starving,
      resyncs: this.resyncs,
      lastResync: this.lastResync,
      heldMs: this.heldMs,
      initialized: this.initialized,
    };
  }
}
