import { wrapPi } from "../shared/mathx.js";

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Analytic sharp hairpin used for remote-presentation acceptance:
// straight -> 180-degree semicircle -> straight, at constant longitudinal
// speed. Every pose is a closed-form function of the server clock, so a render
// time maps to an exact truth pose without integration or a lookup cache.
//
// Layout (top view, x/z metres): the craft enters along +x, turns left around
// centre (L0, r), and exits along -x on a line parallel to the entry straight.
export function createHairpin({
  v = 20, // m/s constant longitudinal speed
  r = 12, // hairpin radius m
  L0 = 60, // entry straight length m
  L1 = 60, // exit straight length m
  startClockSec = 0,
} = {}) {
  const arcLen = Math.PI * r;
  const totalLen = L0 + arcLen + L1;
  const tArcStart = L0 / v;
  const tArcEnd = (L0 + arcLen) / v;
  const tEnd = totalLen / v;
  const sApex = L0 + arcLen / 2;
  const tApex = sApex / v;

  function arcAt(s) {
    const u = (s - L0) / r; // 0..pi across the bend
    return {
      x: L0 + r * Math.sin(u),
      z: r - r * Math.cos(u),
      heading: Math.PI / 2 - u,
      tx: Math.cos(u),
      tz: Math.sin(u),
      turnRate: v / r,
      u,
    };
  }

  // The geometric corner is position-continuous but has a heading seam at the
  // straight/circle junction (the tangent turns by pi/2 with no arc of its
  // own). Smooth the heading across a four-snapshot approach on the straight
  // side and the first arc samples, so every adjacent 50 ms packet pair has a
  // bounded heading delta. The apex itself stays exactly analytic.
  const blendMs = 200;
  const blendS = (v * blendMs) / 1000;
  const arcEnd = L0 + arcLen;

  function smoothHeading(s, raw) {
    if (s >= L0 - blendS && s < L0) {
      // Ease from straight heading 0 onto the arc entry heading pi/2.
      const f = (s - (L0 - blendS)) / blendS;
      const e = f * f * (3 - 2 * f);
      return e * (Math.PI / 2);
    }
    if (s >= arcEnd && s <= arcEnd + blendS / 2) {
      const f = (s - arcEnd) / (blendS / 2);
      return (-Math.PI / 2) * (1 - f) + (-Math.PI / 2) * f;
    }
    return raw;
  }

  function poseAt(serverSec) {
    const tau = serverSec - startClockSec;
    const s = clamp(v * tau, 0, totalLen);
    if (s < L0) {
      return { x: s, z: 0, y: 0, heading: wrapPi(smoothHeading(s, 0)), tx: 1, tz: 0, turnRate: 0, phase: "straight-in" };
    }
    if (s <= arcEnd) {
      const a = arcAt(s);
      return { x: a.x, z: a.z, y: 0, heading: wrapPi(a.heading), tx: a.tx, tz: a.tz, turnRate: a.turnRate, phase: "hairpin" };
    }
    const q = s - arcEnd;
    return { x: L0 - q, z: 2 * r, y: 0, heading: wrapPi(smoothHeading(s, -Math.PI / 2)), tx: -1, tz: 0, turnRate: 0, phase: "straight-out" };
  }

  // Dense polyline for the replay canvas, sampled by arc length.
  function polyline(stepM = 1) {
    const pts = [];
    for (let s = 0; s <= totalLen + 1e-9; s += stepM) pts.push(poseAt(startClockSec + s / v));
    pts.push(poseAt(startClockSec + tEnd));
    return pts;
  }

  return {
    id: "hairpin",
    v,
    r,
    totalLen,
    durationSec: tEnd,
    windows: {
      apexServerMs: tApex * 1000,
      arcEntryMs: tArcStart * 1000,
      arcExitMs: tArcEnd * 1000,
      // Predeclared bend window used when placing network impairments.
      bendMs: [tArcStart * 1000, tArcEnd * 1000],
    },
    poseAt,
    polyline,
  };
}

// Stationary spinner: the craft never translates but rotates continuously.
// A distance-only acceptance metric cannot see this motion at all; only the
// heading error captures the between-observation orientation jitter.
export function createSpinner({
  x = 0,
  z = 0,
  periodSec = 1,
  phase = 0,
  startClockSec = 0,
  durationSec = 4,
} = {}) {
  function poseAt(serverSec) {
    const tau = serverSec - startClockSec;
    const heading = phase + (TAU2 * tau) / periodSec;
    return {
      x,
      z,
      y: 0,
      heading: wrapPi(heading),
      tx: Math.sin(heading),
      tz: Math.cos(heading),
      turnRate: TAU2 / periodSec,
      phase: "spin",
    };
  }
  return {
    id: "spinner",
    durationSec,
    poseAt,
    polyline: () => [{ x, z }],
    windows: { apexServerMs: null, bendMs: null },
  };
}

const TAU2 = Math.PI * 2;

// Deterministic snapshot schedule: one packet per interval of server time.
export function samplePackets(trajectory, { startMs = 0, endMs, intervalMs = 50, vehicleId = "v1" } = {}) {
  const packets = [];
  let seq = 0;
  for (let t = startMs; t <= endMs + 1e-9; t += intervalMs) {
    const p = trajectory.poseAt(t / 1000);
    packets.push({
      seq,
      t,
      id: vehicleId,
      x: p.x,
      y: p.y,
      z: p.z,
      heading: p.heading,
    });
    seq += 1;
  }
  return packets;
}
