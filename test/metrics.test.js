import test from "node:test";
import assert from "node:assert/strict";
import { DisplayBuffer, DisplayClock } from "../public/display.js";
import { DisplayMetrics } from "../shared/metrics.js";

function packet(seq, t, x) {
  return {
    type: "state",
    v: 1,
    epoch: 1,
    seq,
    t,
    vehicles: [{ id: "v1", x, y: 0, z: 0, heading: 0, bank: 0, speed: 50 }],
  };
}

function truthAt(x) {
  return [{ id: "v1", x, y: 0, z: 0, heading: 0 }];
}

test("catch-up time dilation is not counted as a visual discontinuity", () => {
  const m = new DisplayMetrics(6000);
  // Same smooth motion on the timeline, but presented 1.4x faster than wall
  // time: a naive wall-clock divisor would call this a teleport.
  m.add({ atMs: 0, mode: "interp", vehicles: truthAt(0), truth: truthAt(0), displayT: 1000 });
  m.add({ atMs: 16, mode: "interp", vehicles: truthAt(1.12), truth: truthAt(1.12), displayT: 1022.4 });
  assert.equal(m.discontinuities, 0);
  assert.ok(m.summary().posErrMax === 0);
});

test("a pose that changes while the cursor is frozen is a real discontinuity", () => {
  const m = new DisplayMetrics(6000);
  m.add({ atMs: 0, mode: "held", vehicles: truthAt(10), truth: truthAt(10), displayT: 2000 });
  // Same display time, pose jumps 12 m: not motion, a correction.
  m.add({ atMs: 16, mode: "held", vehicles: truthAt(22), truth: truthAt(22), displayT: 2000 });
  assert.equal(m.discontinuities, 1);
});

test("resetContinuity drops the baseline so an intentional cliff is not double-counted", () => {
  const m = new DisplayMetrics(6000);
  m.add({ atMs: 0, mode: "interp", vehicles: truthAt(0), truth: truthAt(0), displayT: 1000 });
  m.resetContinuity();
  m.add({ atMs: 16, mode: "interp", vehicles: truthAt(500), truth: truthAt(500), displayT: 2000 });
  assert.equal(m.discontinuities, 0);
});

test("frozen clock cursor ignores the moving extrapolation ceiling", () => {
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs: 100, maxExtrapolationMs: 250, resyncLagMs: 700 });
  for (let i = 0; i < 5; i += 1) buf.ingest(packet(i + 1, 1000 + i * 50, i * 5));
  clock.advance(16, buf);
  let st;
  for (let i = 0; i < 120; i += 1) {
    st = clock.advance(16, buf);
    if (st.clamped) break;
  }
  assert.equal(st.clamped, true);
  const frozenAt = st.displayT;
  // Packets keep arriving one interval at a time — exactly the recovery shape
  // that used to drag the frozen picture forward with each packet.
  for (let i = 0; i < 4; i += 1) {
    st = clock.advance(16, buf);
    const seq = 100 + i;
    buf.ingest(packet(seq, 1250 + (i + 1) * 50, (i + 6) * 5));
    st = clock.advance(16, buf);
    assert.equal(st.displayT, frozenAt, "frozen cursor must not ride the ceiling");
    assert.equal(st.clamped, true);
  }
});
