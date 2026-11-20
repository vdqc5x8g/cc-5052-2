import { PlaybackReceiver } from "./playback-receiver.js";

// Drive a trace through a playback receiver on a deterministic render grid.
// Frames are produced at wall/render times independent of packet arrivals, so
// changing frameHz only changes how often the same source timeline is sampled,
// never which source instant a given render time points at.
export function runScenario(trace, {
  frameHz = 60,
  renderStartMs = 0,
  renderEndMs,
  receiver,
} = {}) {
  const recv = receiver ?? new PlaybackReceiver();
  const dtMs = 1000 / frameHz;
  const endMs = renderEndMs ?? Math.max(...trace.deliveries.map((d) => d.arriveAtMs)) + 1500;
  const arrivals = trace.deliveries.slice().sort((a, b) => a.arriveAtMs - b.arriveAtMs || a.t - b.t);
  const packetBySeq = new Map(trace.packets.map((p) => [p.seq, p]));

  let cursor = 0;
  const frames = [];
  const events = [];
  for (let t = renderStartMs; t <= endMs + 1e-9; t += dtMs) {
    while (cursor < arrivals.length && arrivals[cursor].arriveAtMs <= t + 1e-9) {
      const d = arrivals[cursor];
      const pkt = packetBySeq.get(d.seq);
      const res = recv.ingest({ ...d, pose: pkt ? { x: pkt.x, y: pkt.y, z: pkt.z, heading: pkt.heading } : d.pose });
      events.push({ atMs: t, kind: res.reason, seq: d.seq, sourceT: d.t, duplicate: !!d.duplicate });
      cursor += 1;
    }
    const frame = recv.step(t);
    frames.push(frame);
  }
  return { frames, events, receiver: recv };
}

// On failure keep only the packets around the first offending frame: the
// replay stays small and the clickable review opens directly on the defect.
// Windowing is by packet *index*, not timestamp, so a unit-fault trace whose
// timestamps are off by 1000x still trims to the right neighborhood.
export function shortenTrace(trace, firstFailureMs, { padPackets = 30 } = {}) {
  const centerIndex = trace.packets.reduce((best, p, i) => {
    const d = Math.abs(p.t - firstFailureMs);
    return d < Math.abs(trace.packets[best].t - firstFailureMs) ? i : best;
  }, 0);
  const lo = Math.max(0, centerIndex - padPackets);
  const hi = Math.min(trace.packets.length - 1, centerIndex + padPackets);
  const keep = new Set(trace.packets.slice(lo, hi + 1).map((p) => p.seq));
  return {
    ...trace,
    packets: trace.packets.filter((p) => keep.has(p.seq)),
    deliveries: trace.deliveries.filter((d) => keep.has(d.seq)),
    latencies: trace.latencies.filter((_, i) => keep.has(trace.packets[i].seq)),
    dropped: trace.dropped.filter((i) => keep.has(trace.packets[i].seq)),
    shortened: { centerIndex, lo, hi },
  };
}

// Keep only rendered frames around the failure, extended by one render step
// on each side so the canvas is never empty on open.
export function shortenFrames(frames, centerRenderMs, padMs, stepMs) {
  return frames.filter(
    (f) => f.renderMs >= centerRenderMs - padMs - stepMs && f.renderMs <= centerRenderMs + padMs + stepMs,
  );
}
