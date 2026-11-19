import { TAU } from "./mathx.js";

export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

// Tiered racing line: long straight, tight hairpin on the left, a narrow S
// comb, then a sweeping right-hander. Sampling is by arc length so speed can
// be expressed in metres per second directly.
const CONTROL = [
  [0, 0],
  [110, -6],
  [210, -44],
  [252, -128],
  [206, -216],
  [106, -256],
  [6, -232],
  [-48, -168],
  [-30, -104],
  [24, -92],
  [52, -132],
  [22, -168],
  [-30, -162],
  [-58, -118],
  [-40, -80],
  [2, -76],
  [30, -104],
  [14, -142],
  [-26, -178],
  [-80, -186],
  [-132, -152],
  [-142, -96],
  [-104, -52],
  [-44, -38],
];

export function createTrack(samplesPerSegment = 64) {
  const pts = CONTROL.map(([x, z]) => ({ x, z }));
  const raw = [];
  const n = pts.length;
  const P = (i) => pts[(i + n) % n];

  for (let i = 0; i < n; i += 1) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    for (let k = 0; k < samplesPerSegment; k += 1) {
      const t = k / samplesPerSegment;
      raw.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
      });
    }
  }
  raw.push({ x: raw[0].x, z: raw[0].z });

  const cumulative = [0];
  for (let i = 1; i < raw.length; i += 1) {
    const dx = raw[i].x - raw[i - 1].x;
    const dz = raw[i].z - raw[i - 1].z;
    cumulative.push(cumulative[i - 1] + Math.hypot(dx, dz));
  }
  const length = cumulative[cumulative.length - 1];

  function sampleAt(distance) {
    let d = distance % length;
    if (d < 0) d += length;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = cumulative[hi] - cumulative[lo] || 1e-6;
    const f = (d - cumulative[lo]) / segLen;
    const a = raw[lo];
    const b = raw[hi];
    const tx = (b.x - a.x) / segLen;
    const tz = (b.z - a.z) / segLen;
    const l = Math.hypot(tx, tz) || 1;
    return {
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      tx: tx / l,
      tz: tz / l,
    };
  }

  function heightAt(distance) {
    const d = distance % length;
    const u = d / length;
    return (
      6 +
      3.4 * Math.sin(u * TAU * 2 + 0.4) +
      1.7 * Math.sin(u * TAU * 5 + 1.1) +
      10 * smoothPulse(u, 0.34, 0.42) +
      6.5 * smoothPulse(u, 0.71, 0.77)
    );
  }

  return { length, sampleAt, heightAt, control: CONTROL };
}

function smoothPulse(u, a, b) {
  const w = 0.035;
  const rise = smooth01((u - (a - w)) / w);
  const fall = 1 - smooth01((u - b) / w);
  return Math.max(0, Math.min(rise, fall));
}

function smooth01(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

// Piecewise speed law over lap fraction. Includes deliberate speed shocks
// (hard braking zones and a launch burst) used as interpolation truth.
const SPEED_BANDS = [
  { u: 0.0, v: 62 },
  { u: 0.08, v: 74 },
  { u: 0.16, v: 76 },
  { u: 0.205, v: 30 },
  { u: 0.235, v: 26 },
  { u: 0.28, v: 58 },
  { u: 0.36, v: 65 },
  { u: 0.44, v: 34 },
  { u: 0.47, v: 30 },
  { u: 0.52, v: 60 },
  { u: 0.58, v: 72 },
  { u: 0.66, v: 78 },
  { u: 0.74, v: 40 },
  { u: 0.78, v: 36 },
  { u: 0.84, v: 64 },
  { u: 0.92, v: 70 },
  { u: 0.97, v: 66 },
  { u: 1.0, v: 62 },
];

function bandValue(bands, u) {
  for (let i = 1; i < bands.length; i += 1) {
    if (u <= bands[i].u) {
      const a = bands[i - 1];
      const b = bands[i];
      const f = (u - a.u) / (b.u - a.u || 1);
      // Sharp-ish but continuous ramp keeps truth differentiable; the sudden
      // deceleration remains visible in the trajectory.
      return a.v + (b.v - a.v) * smooth01(f);
    }
  }
  return bands[bands.length - 1].v;
}

export function createSpeedProfile(track, perVehicleOffsetU = 0) {
  const L = track.length;
  return function speedAt(distance) {
    let u = (((distance % L) + L) % L) / L;
    u = (u + perVehicleOffsetU) % 1;
    return bandValue(SPEED_BANDS, u);
  };
}

// Analytic ground truth. `clockSec` is server simulation time. The lap
// distance is obtained by integrating the speed law, cached at 10 ms steps.
export function createTruthSampler(track, speedAt, startDistance, lateral, hoverPhase, startClockSec = 0) {
  const L = track.length;
  const STEP = 0.01;
  const MAX_SECONDS = 1800;
  const cache = new Float64Array(Math.ceil(MAX_SECONDS / STEP) + 2);
  let d = startDistance;
  cache[0] = d;
  for (let i = 1; i < cache.length; i += 1) {
    d += speedAt(d) * STEP;
    cache[i] = d;
  }

  function distanceAt(clockSec) {
    const x = Math.max(0, clockSec - startClockSec) / STEP;
    const i = Math.min(cache.length - 2, Math.floor(x));
    const f = x - i;
    return cache[i] + (cache[i + 1] - cache[i]) * f;
  }

  function sample(clockSec) {
    const travelled = distanceAt(clockSec);
    const dist = ((travelled % L) + L) % L;
    const s = track.sampleAt(dist);
    const ahead = track.sampleAt(dist + 2);
    const nx = -s.tz;
    const nz = s.tx;
    const sway = Math.sin(clockSec * 1.25 + hoverPhase) * 1.5 + lateral;
    return {
      x: s.x + nx * sway,
      z: s.z + nz * sway,
      y: track.heightAt(dist) + Math.sin(clockSec * 2.1 + hoverPhase) * 0.35,
      heading: Math.atan2(ahead.x - s.x, ahead.z - s.z),
      bank: Math.sin(clockSec * 1.9 + hoverPhase * 2) * 0.12,
      speed: speedAt(dist),
      distance: dist,
      travelled,
    };
  }

  return { sample, distanceAt, speedAt };
}
