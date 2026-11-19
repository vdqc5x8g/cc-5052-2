import test from "node:test";
import assert from "node:assert/strict";
import {
  DisplayBuffer,
  DisplayClock,
  interpolateHeading,
  validateStatePacket,
  HEADING_GUARD,
  DEFAULT_CLOCK_OPTIONS,
} from "../public/display.js";
import { wrapPi } from "../shared/mathx.js";

function packet(seq, t, overrides = {}) {
  return {
    type: "state",
    v: 1,
    epoch: 1,
    seq,
    t,
    sentAt: t,
    vehicles: [
      {
        id: "v1",
        x: overrides.x ?? seq * 10,
        y: 6,
        z: overrides.z ?? 0,
        heading: overrides.heading ?? 0,
        bank: 0,
        speed: 50,
      },
    ],
  };
}

function fill(buf, { count = 12, startT = 1000, step = 50 } = {}) {
  for (let i = 0; i < count; i += 1) {
    buf.ingest(packet(i + 1, startT + i * step, { x: i * 20 }));
  }
}

test("validation rejects non-finite and missing-epoch packets", () => {
  const bad = packet(1, 1000);
  bad.vehicles[0].x = NaN;
  assert.equal(validateStatePacket(bad, false), false);
  assert.equal(validateStatePacket(packet(1, 1000), false), true);
  assert.equal(validateStatePacket(packet(1, 1000), true), true);
  const noEpoch = packet(1, 1000);
  delete noEpoch.epoch;
  assert.equal(validateStatePacket(noEpoch, true), false);
  assert.equal(validateStatePacket({ type: "state", seq: 1, t: 1, vehicles: [] }, false), false);
});

test("buffer orders by source timestamp and counts out-of-order arrivals", () => {
  const buf = new DisplayBuffer();
  assert.equal(buf.ingest(packet(1, 1000)).ok, true);
  assert.equal(buf.ingest(packet(3, 1200)).ok, true);
  const late = buf.ingest(packet(2, 1100));
  assert.equal(late.ok, true);
  assert.equal(late.insertedAt, 1);
  assert.deepEqual(buf.samples.map((s) => s.t), [1000, 1100, 1200]);
  assert.equal(buf.stats.received, 3);
});

test("duplicates by seq or identical timestamp are ignored", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000));
  assert.equal(buf.ingest(packet(1, 1000)).ok, false);
  assert.equal(buf.ingest(packet(2, 1000)).ok, false, "same t under new seq is a duplicate payload");
  assert.equal(buf.depth, 1);
  assert.equal(buf.stats.duplicates, 2);
});

test("duplicate sequence under new timestamp is dropped", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000));
  assert.equal(buf.ingest(packet(1, 1050)).ok, false);
  assert.equal(buf.depth, 1);
});

test("evaluation interpolates between bracketing source times", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000, { x: 0 }));
  buf.ingest(packet(2, 1100, { x: 100 }));
  const out = buf.evaluate(1050);
  assert.equal(out.mode, "interp");
  assert.ok(Math.abs(out.vehicles[0].x - 50) < 1e-9);
  assert.equal(out.segment.tA, 1000);
  assert.equal(out.segment.tB, 1100);
  assert.ok(Math.abs(out.segment.f - 0.5) < 1e-9);
});

test("late packet fills a gap rather than jumping the model", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000, { x: 0 }));
  buf.ingest(packet(3, 1200, { x: 200 }));
  // With the hole, display at 1100 clamps to the tail of [1000,1200].
  const before = buf.evaluate(1100);
  assert.equal(before.mode, "interp");
  assert.ok(Math.abs(before.vehicles[0].x - 100) < 1e-9);
  buf.ingest(packet(2, 1100, { x: 100 }));
  const after = buf.evaluate(1100);
  assert.ok(Math.abs(after.vehicles[0].x - 100) < 1e-9, "same time, same place: no visual jump");
  assert.equal(after.segment.tA, 1100);
});

test("extrapolation is bounded then held with no guesswork", () => {
  const buf = new DisplayBuffer();
  // 10 m over 50 ms = 200 m/s, above the default 130 m/s cap; raise the cap so
  // this test isolates the time bound rather than the velocity guard.
  buf.ingest(packet(1, 1000, { x: 0, z: 0, heading: 0.4 }));
  buf.ingest(packet(2, 1050, { x: 10, z: 0, heading: 0.5 }));
  const short = buf.evaluate(1100, { maxExtrapolationMs: 250, maxSpeedForExtrapolation: 1000 });
  assert.equal(short.mode, "extrap");
  assert.ok(Math.abs(short.vehicles[0].x - 20) < 1e-9);
  // The stop pose is the pose at the limit (10 m + 250 ms of last velocity),
  // so switching from extrap to held does not rewind the picture.
  const atLimit = buf.evaluate(1300, { maxExtrapolationMs: 250, maxSpeedForExtrapolation: 1000 });
  assert.equal(atLimit.mode, "held");
  assert.ok(Math.abs(atLimit.vehicles[0].x - 60) < 1e-9);
  const limit = buf.evaluate(1600, { maxExtrapolationMs: 250, maxSpeedForExtrapolation: 1000 });
  assert.equal(limit.mode, "held");
  assert.equal(limit.vehicles[0].x, atLimit.vehicles[0].x, "hold is static, not per-packet");
  assert.equal(limit.vehicles[0].heading, 0.5);
  assert.ok(limit.staleMs > 250);
});

test("extrapolation caps velocity so garbage deltas cannot fling the model", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000, { x: 0 }));
  buf.ingest(packet(2, 1050, { x: 100000 }));
  const out = buf.evaluate(1060, { maxExtrapolationMs: 250, maxSpeedForExtrapolation: 130 });
  const dx = out.vehicles[0].x - 100000;
  // 50 ms at <=130 m/s => <=6.5 m
  assert.ok(dx <= 6.5001 && dx >= 0, `capped offset was ${dx}`);
});

test("heading interpolation takes the short arc and guards bad data", () => {
  const near = interpolateHeading(0.1, -0.1, 0.5);
  assert.equal(near.suspicious, false);
  assert.ok(Math.abs(near.heading - 0) < 1e-9);

  const across = interpolateHeading(3.0, -3.0, 0.5);
  assert.equal(across.suspicious, false);
  assert.ok(Math.abs(Math.abs(wrapPi(across.heading)) - Math.PI) < 1e-6, "crossed pi cleanly");

  const bad = interpolateHeading(0, HEADING_GUARD + 0.2, 0.5);
  assert.equal(bad.suspicious, true);
  assert.equal(bad.heading, 0, "holds previous heading instead of spinning");
});

test("suspicious heading between samples does not produce a visible snap", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000, { heading: 0 }));
  buf.ingest(packet(2, 1050, { heading: 3.0 })); // ~172 deg in 50ms -> impossible
  const out = buf.evaluate(1025);
  assert.equal(out.vehicles[0].heading, 0);
  assert.ok(buf.stats.suspiciousHeadings >= 1);
});

test("restart epoch discards stale timeline", () => {
  const buf = new DisplayBuffer();
  buf.ingest(packet(1, 1000));
  buf.ingest(packet(2, 1050));
  const restarted = { ...packet(1, 5000), epoch: 2 };
  assert.equal(buf.ingest(restarted).ok, true);
  assert.equal(buf.depth, 1);
  assert.equal(buf.epoch, 2);
});

test("history trimming keeps the window bounded yet retains two samples", () => {
  const buf = new DisplayBuffer({ historyMs: 500 });
  for (let i = 0; i < 50; i += 1) buf.ingest(packet(i + 1, 1000 + i * 50));
  assert.ok(buf.spanMs <= 500 + 1);
  assert.ok(buf.depth >= 2);
  assert.ok(buf.stats.trimmed > 0);
});

test("display clock target is newest minus delay, not arrival time", () => {
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs: 100, maxRateAdjust: 0.08, maxExtrapolationMs: 250 });
  fill(buf, { count: 5, startT: 1000, step: 50 });
  const st = clock.advance(16, buf);
  assert.equal(st.displayT, buf.newestT - 100);
  const before = st.displayT;
  // Advance 16ms of local time with no new packet: clock should move ~16ms.
  const st2 = clock.advance(16, buf);
  assert.ok(Math.abs(st2.displayT - before - 16) <= 16 * 0.1 + 1e-6);
});

test("clock rate nudges within bounds and never snaps for small error", () => {
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs: 100, maxRateAdjust: 0.08, resyncLagMs: 700, maxExtrapolationMs: 250 });
  fill(buf, { count: 5, startT: 1000, step: 50 });
  clock.advance(16, buf);
  const start = clock.displayT;
  // New sample pushes target 200ms ahead (one lost packet at 50ms * 4? use 50).
  buf.ingest(packet(6, 1250));
  const st = clock.advance(16, buf);
  assert.ok(st.rate > 1 && st.rate <= 1.0800001, `rate=${st.rate}`);
  assert.ok(st.displayT - start < 20, "no snap on small drift");
  assert.equal(clock.resyncs, 0);
});

test("clock freezes at the extrapolation ceiling under sustained loss", () => {
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs: 100, maxExtrapolationMs: 250, resyncLagMs: 700 });
  fill(buf, { count: 5, startT: 1000, step: 50 });
  clock.advance(16, buf);
  let st;
  for (let i = 0; i < 100; i += 1) {
    st = clock.advance(16, buf);
    assert.ok(st.displayT <= buf.newestT + 250 + 1e-9, "never beyond bounded extrapolation");
    if (st.clamped) break;
  }
  assert.equal(st.clamped, true, "clock clamps and stops guessing");
  assert.ok(st.displayT <= buf.newestT + 250 + 1e-9);
});

test("forward drift is caught up by time dilation, not by jumping the cursor", () => {
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs: 100, resyncLagMs: 700, maxExtrapolationMs: 2000 });
  fill(buf, { count: 5, startT: 1000, step: 50 });
  clock.advance(16, buf);
  // 1 s of source time appears at once (e.g. tab was throttled). This is below
  // the hard resync threshold, so the cursor must accelerate, not teleport.
  buf.ingest(packet(20, 2500));
  const before = clock.displayT;
  const st = clock.advance(16, buf);
  assert.equal(clock.resyncs, 0);
  assert.equal(st.catchUp, true);
  assert.ok(st.rate > 1.08, `catch-up rate ${st.rate}`);
  assert.ok(st.displayT - before < 30, "no discontinuity");
});

test("only a broken timeline beyond 2 s may snap the cursor", () => {
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs: 100, resyncLagMs: 700, maxExtrapolationMs: 4000 });
  fill(buf, { count: 5, startT: 1000, step: 50 });
  clock.advance(16, buf);
  buf.ingest(packet(200, 9000));
  const st = clock.advance(16, buf);
  assert.equal(clock.resyncs, 1);
  assert.equal(st.displayT, buf.newestT - 100);
});

test("clock never runs before oldest retained sample", () => {
  const buf = new DisplayBuffer({ historyMs: 300 });
  const clock = new DisplayClock({ delayMs: 0, maxExtrapolationMs: 100 });
  fill(buf, { count: 5, startT: 1000, step: 50 });
  clock.advance(16, buf);
  // Simulate a huge clock step if allowed; instead force displayT backward.
  clock.displayT = 0;
  const st = clock.advance(16, buf);
  assert.ok(st.displayT >= buf.oldestT);
});
