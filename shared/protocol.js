export const PROTOCOL_VERSION = 1;

export const DEFAULT_NET = Object.freeze({
  latencyMs: 70,
  jitterMs: 16,
  lossPct: 2,
  burstChancePct: 1.2,
  burstLenMs: 320,
});

export const NET_LIMITS = Object.freeze({
  latencyMs: [0, 400],
  jitterMs: [0, 200],
  lossPct: [0, 100],
  burstChancePct: [0, 40],
  burstLenMs: [0, 3000],
});

export const DEFAULT_DISPLAY = Object.freeze({
  // Display delay is the reorder buffer depth. It must cover network jitter
  // plus typical bursts, or the display clock starves and seams appear.
  delayMs: 300,
  maxExtrapolationMs: 250,
  maxRateAdjust: 0.08,
});

export const VEHICLE_COLORS = ["#ff5d3b", "#33d6ff", "#ffd447", "#a583ff"];

export function clampNumber(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function sanitizeNetConfig(input = {}) {
  const warnings = [];
  const config = {};
  for (const [key, [lo, hi]] of Object.entries(NET_LIMITS)) {
    const raw = input[key];
    const fallback = DEFAULT_NET[key];
    const n = Number(raw);
    if (raw === undefined) {
      config[key] = fallback;
      continue;
    }
    if (!Number.isFinite(n)) {
      warnings.push(`${key} must be a number; using ${fallback}`);
      config[key] = fallback;
      continue;
    }
    const clamped = Math.min(hi, Math.max(lo, n));
    if (clamped !== n) warnings.push(`${key} clamped to ${clamped}`);
    config[key] = clamped;
  }
  return { config, warnings };
}

export function sanitizeInput(input = {}) {
  return {
    throttle: clampNumber(input.throttle, 0, 1, 0),
    brake: clampNumber(input.brake, 0, 1, 0),
    steer: clampNumber(input.steer, -1, 1, 0),
  };
}

export function validateHello(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, error: "message must be an object" };
  return { ok: true, name: typeof msg.name === "string" ? msg.name.slice(0, 24) : "spectator" };
}
