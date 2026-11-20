// Fault injection for acceptance runs. Each transform is pure over a trace so
// the original record stays available for comparison.

// Producer emitted seconds but the display layer interprets the field as
// milliseconds (or vice versa). The default models an s->ms fault: every source
// timestamp is multiplied by 1000, so the observed clock rate jumps to
// alpha ~= 1000 and poses land ~1000x too late on the render clock. The
// reciprocal ms->s case is available by passing factor = 1/1000.
export function injectTimestampUnitFault(trace, { factor = 1000, fromIndex = 0 } = {}) {
  const packets = trace.packets.map((p, i) => ({ ...p, t: p.t * (i >= fromIndex ? factor : 1) }));
  const scaledT = new Map(packets.map((p) => [p.seq, p.t]));
  const deliveries = trace.deliveries.map((d) => ({ ...d, t: scaledT.get(d.seq) }));
  return {
    ...trace,
    kind: `${trace.kind}+unit-fault`,
    packets,
    latencies: trace.latencies.slice(),
    dropped: trace.dropped.slice(),
    deliveries,
    fault: { type: "timestamp-unit", factor, fromIndex },
  };
}

// Re-emit an already-seen late packet as a "fresh" delivery. A receiver with
// correct deduplication ignores it; the stale policy re-adopts it and pins the
// picture to an old source instant, which the acceptor must catch as a
// regression and as a heading/tangent mismatch on screen.
export function injectDuplicateLateSample(trace, { duplicateSeq, reArriveDelayMs = 250 } = {}) {
  const original = trace.deliveries.find((d) => d.seq === duplicateSeq);
  if (!original) throw new Error(`seq ${duplicateSeq} was never delivered in this trace`);
  const duplicate = {
    ...original,
    seq: original.seq,
    t: original.t,
    arriveAtMs: original.arriveAtMs + reArriveDelayMs,
    duplicate: true,
  };
  const deliveries = trace.deliveries.concat([duplicate]).sort((a, b) => a.arriveAtMs - b.arriveAtMs || a.t - b.t);
  return {
    ...trace,
    deliveries,
    fault: { type: "duplicate-late-sample", duplicateSeq, reArriveDelayMs },
  };
}
