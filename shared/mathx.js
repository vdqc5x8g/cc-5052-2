export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function wrapPi(a) {
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

// Shift `angle` by whole turns so it sits within +/-PI of `reference`.
export function unwrapNear(angle, reference) {
  return angle + TAU * Math.round((reference - angle) / TAU);
}

export function smoothstep(t) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function formatClock(ms) {
  if (!Number.isFinite(ms)) return "--:--.---";
  const sign = ms < 0 ? "-" : "";
  ms = Math.abs(ms);
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${sign}${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}
