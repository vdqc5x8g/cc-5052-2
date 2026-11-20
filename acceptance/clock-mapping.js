// Independent server-clock -> render-clock conversion.
//
// Both the receiver and the acceptor need to answer "which source timestamp
// should the picture at render time R show?" without sharing state. They share
// only this pure math; the estimator deliberately consumes only (source t,
// arrival R) observations, so a broken receiver timeline cannot feed it a
// biased answer.
//
// Model: R = alpha * sourceMs + betaMs, with alpha = 1 for clocks ticking at
// the same rate. A packet that was sent at t and suffered latency L arrives at
// R = t + L; median(L) over a long run estimates the playout offset, while the
// median slope of consecutive observations estimates the rate (and exposes a
// seconds/milliseconds unit mistake as alpha ~= 0.001).

export function median(values) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Estimate (alpha, beta) from delivery observations [{ t, arriveAtMs }].
export function estimateClockMapping(deliveries) {
  if (!deliveries || deliveries.length < 2) {
    throw new Error("need at least two delivery observations to estimate the clock mapping");
  }
  const slopes = [];
  for (let i = 1; i < deliveries.length; i += 1) {
    const dt = deliveries[i].t - deliveries[i - 1].t;
    const dr = deliveries[i].arriveAtMs - deliveries[i - 1].arriveAtMs;
    if (Math.abs(dt) > 1e-9) slopes.push(dr / dt);
  }
  const alpha = median(slopes);
  // Offset per observation: arriveAt - alpha*t, then take the median.
  const offsets = deliveries.map((d) => d.arriveAtMs - alpha * d.t);
  const betaMs = median(offsets);
  return { alpha, betaMs };
}

// A renderer mapping built from an explicit playout delay: R = t + delayMs.
export function fixedDelayMapping(delayMs) {
  return { alpha: 1, betaMs: delayMs };
}

// Fit the mapping a correctly built *playout* clock should follow. The raw
// arrival median sits at the median one-way latency, but a display deliberately
// presents behind the newest sample by a playout delay. With constant-rate
// snapshots the delay that keeps the cursor inside the buffer without forced
// clamping is the minimum observed arrival offset plus one full snapshot
// interval, i.e. the first instant two samples are available to interpolate.
export function estimatePlayoutMapping(deliveries, snapshotIntervalMs) {
  const base = estimateClockMapping(deliveries);
  const offsets = deliveries.map((d) => d.arriveAtMs - base.alpha * d.t);
  const minOffset = Math.min(...offsets);
  return { alpha: base.alpha, betaMs: minOffset + snapshotIntervalMs };
}

export function renderToServer(renderMs, mapping) {
  return (renderMs - mapping.betaMs) / mapping.alpha;
}

// Unit mistakes are detected from rate, not offset: a ms->s confusion scales
// every timestamp by 1e-3, which no amount of latency jitter can mimic.
export function detectUnitFault(mapping, { rateTolerance = 0.05 } = {}) {
  const rateError = Math.abs(mapping.alpha - 1);
  return {
    unitFault: rateError > rateTolerance,
    alpha: mapping.alpha,
    rateError,
    threshold: rateTolerance,
  };
}
