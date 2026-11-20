// Two deterministic network records over the same analytic hairpin.
//
// Both records share the *same average one-way latency*. They differ in how
// the latency is arranged in time:
//   reorder: short delays before the apex, long delays at the apex so packets
//            arrive out of source order right at the bend middle;
//   loss:    the pre-apex packets are dropped and the post-bend packets are
//            delivered late in a burst, i.e. loss before the turn and catch-up
//            after it.
// The equal mean is constructed, not assumed: a helper recenters each raw
// latency table so the scheduled packets average a common target, and tests
// assert the equality numerically.

export const MEAN_LATENCY_MS = 120;
export const MIN_LATENCY_MS = 10;
export const SNAPSHOT_MS = 50;

function recenter(latencies, targetMeanMs) {
  const n = latencies.length;
  const sum = latencies.reduce((a, b) => a + b, 0);
  const shift = targetMeanMs - sum / n;
  let out = latencies.map((l) => l + shift);
  const min = Math.min(...out);
  if (min < MIN_LATENCY_MS) {
    out = out.map((l) => l + (MIN_LATENCY_MS - min));
  }
  const mean = out.reduce((a, b) => a + b, 0) / n;
  // The recenter shift is exact when target and n are integers; keep a guard.
  if (Math.abs(mean - targetMeanMs) > 1e-9) {
    const residual = targetMeanMs - mean;
    out[out.length - 1] += residual;
  }
  return out;
}

function meanOf(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildDeliveries(packets, latencies, dropped) {
  const dropSet = new Set(dropped);
  const scheduled = [];
  const deliveries = [];
  for (let i = 0; i < packets.length; i += 1) {
    if (dropSet.has(i)) continue;
    const latencyMs = latencies[i];
    const arriveAtMs = packets[i].t + latencyMs;
    scheduled.push({ seq: packets[i].seq, index: i, latencyMs, t: packets[i].t, arriveAtMs });
  }
  deliveries.push(...scheduled);
  deliveries.sort((a, b) => a.arriveAtMs - b.arriveAtMs || a.t - b.t);
  return { scheduled, deliveries };
}

// Mean over the full latency table, including the slots whose packets were
// dropped: the impairment schedule is what must average out across records,
// not only the packets that happened to survive.
function tableMean(latencies) {
  return meanOf(latencies);
}

// Record A: in-order baseline with an inversion at the apex. The early half of
// the bend window is faster than the mean and the apex half slower, by enough
// that a fast late-sent packet overtakes the slower earlier one.
export function buildReorderTrace(packets, apexMs, { meanMs = MEAN_LATENCY_MS } = {}) {
  const n = packets.length;
  const raw = new Array(n).fill(meanMs);
  const inversion = [];
  for (let i = 0; i < n; i += 1) {
    const dt = Math.abs(packets[i].t - apexMs);
    if (dt <= 200) raw[i] = meanMs - 55; // fast approaching the apex
    else if (dt <= 450) raw[i] = meanMs + 55; // slow just past it -> overtaking
  }
  const latencies = recenter(raw, meanMs);
  const { deliveries } = buildDeliveries(packets, latencies, []);

  for (let k = 1; k < deliveries.length; k += 1) {
    if (deliveries[k].t < deliveries[k - 1].t) {
      inversion.push({
        earlierArriveSeq: deliveries[k - 1].seq,
        overtakingSeq: deliveries[k].seq,
        atMs: deliveries[k].arriveAtMs,
      });
    }
  }
  return {
    kind: "reorder",
    packets,
    latencies,
    dropped: [],
    deliveries,
    meanLatencyMs: tableMean(latencies),
    inversions: inversion,
    blackout: null,
  };
}

// Record B: no reordering; instead a declared blackout over the bend entry and
// apex, followed by a late burst after the turn exit. The mean latency of the
// packets that *are* scheduled matches record A exactly.
export function buildLossTrace(packets, bendWindowMs, { meanMs = MEAN_LATENCY_MS } = {}) {
  const [bendStart, bendEnd] = bendWindowMs;
  const n = packets.length;
  const raw = new Array(n).fill(meanMs);
  const dropped = [];
  let exitBurstUntilMs = bendEnd + 400;
  for (let i = 0; i < n; i += 1) {
    const t = packets[i].t;
    if (t >= bendStart - 1e-9 && t <= bendEnd + 1e-9) {
      dropped.push(i);
    } else if (t > bendEnd && t <= exitBurstUntilMs) {
      raw[i] = meanMs + 170;
    }
  }
  const latencies = recenter(raw, meanMs);
  const { scheduled, deliveries } = buildDeliveries(packets, latencies, dropped);

  const lastBefore = scheduled.filter((d) => d.t < bendStart);
  const firstAfter = scheduled.find((d) => d.t > bendEnd);
  const blackout = {
    startMs: bendStart,
    endMs: firstAfter ? firstAfter.arriveAtMs : bendEnd,
    gapSourceMs: firstAfter ? firstAfter.t - lastBefore[lastBefore.length - 1].t : null,
  };
  return {
    kind: "loss",
    packets,
    latencies,
    dropped,
    deliveries,
    meanLatencyMs: tableMean(latencies),
    inversions: [],
    blackout,
  };
}
