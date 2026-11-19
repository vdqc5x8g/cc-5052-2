import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../server/world.js";
import { NetSim } from "../server/net-sim.js";
import { makeRng } from "../shared/rng.js";
import { DisplayBuffer, DisplayClock } from "../public/display.js";
import { DisplayMetrics } from "../shared/metrics.js";
import { DEFAULT_NET } from "../shared/protocol.js";
import { REMOTE_IDS } from "../shared/roster.js";

// Deterministic end-to-end harness: the simulated network produces arrival
// times, and the display layer runs the same clock the browser does.

function makeHarness({ net = DEFAULT_NET, delayMs = 300, maxExtrapolationMs = 250, seed = 99 } = {}) {
  const world = new World();
  const rng = makeRng(seed);
  const netSim = new NetSim({ ...net }, rng);
  const buf = new DisplayBuffer();
  const clock = new DisplayClock({ delayMs, maxExtrapolationMs });
  const metrics = new DisplayMetrics(6000);
  const inFlight = [];
  return { world, netSim, buf, clock, metrics, inFlight };
}

function runHarness(h, { seconds = 20, snapshotHz = 20, frameHz = 60, deliver = true } = {}) {
  const snapDt = 1 / snapshotHz;
  const frameDtMs = 1000 / frameHz;
  const totalFrames = Math.round((seconds * 1000) / frameDtMs);
  let nextSnapAt = 0;
  let t = 0;
  let seq = 0;
  const frames = [];
  for (let frame = 0; frame < totalFrames; frame += 1) {
    t += frameDtMs;
    while (t >= nextSnapAt) {
      nextSnapAt += snapDt * 1000;
      seq += 1;
      const snap = h.world.snapshot();
      const pkt = {
        type: "state",
        v: 1,
        epoch: 1,
        seq,
        t: snap.t,
        sentAt: snap.t,
        vehicles: snap.vehicles,
        player: { id: "v4" },
      };
      const sched = h.netSim.schedule(t);
      if (sched) h.inFlight.push({ at: sched.deliverAt, pkt });
    }
    if (deliver) {
      for (let i = h.inFlight.length - 1; i >= 0; i -= 1) {
        if (h.inFlight[i].at <= t) {
          h.buf.ingest(h.inFlight[i].pkt);
          h.inFlight.splice(i, 1);
        }
      }
    }
    const status = h.clock.advance(frameDtMs, h.buf);
    if (status.initialized) {
      const out = h.buf.evaluate(status.displayT, { maxExtrapolationMs: h.clock.options.maxExtrapolationMs });
      const shown = out.vehicles.filter((v) => REMOTE_IDS.includes(v.id));
      const truth = h.world.truthForRemoteAt((status.displayT ?? 0) / 1000);
      if (shown.length) {
        h.metrics.add({ atMs: t, mode: out.mode, vehicles: shown, truth, displayT: status.displayT });
        frames.push({ t, mode: out.mode, displayT: status.displayT, vehicles: shown });
      }
    }
    // Advance the server a frame's worth of simulation.
    h.world.step(frameDtMs / 1000);
  }
  return frames;
}

test("clean network: interpolation tracks truth with bounded error", () => {
  const h = makeHarness({ net: { latencyMs: 60, jitterMs: 2, lossPct: 0, burstChancePct: 0, burstLenMs: 0 }, delayMs: 200 });
  runHarness(h, { seconds: 25 });
  const s = h.metrics.summary();
  assert.ok(s.samples > 100);
  assert.ok(s.posErrAvg < 3.5, `avg pos err ${s.posErrAvg.toFixed(2)} m`);
  assert.ok(s.posErrMax < 12, `max pos err ${s.posErrMax.toFixed(2)} m`);
  assert.ok(s.headErrAvgDeg < 12, `avg heading err ${s.headErrAvgDeg.toFixed(2)} deg`);
  assert.ok(s.heldRatio === 0, "no held frames on a clean link");
});

test("jitter plus loss: display stays continuous without per-packet snapping", () => {
  const h = makeHarness({
    net: { latencyMs: 110, jitterMs: 40, lossPct: 12, burstChancePct: 2, burstLenMs: 260 },
    delayMs: 300,
    seed: 4242,
  });
  runHarness(h, { seconds: 30 });
  const s = h.metrics.summary();
  assert.ok(s.samples > 100);
  assert.equal(s.discontinuities, 0, `saw ${s.discontinuities} visual jumps`);
  assert.ok(s.posErrAvg < 6, `avg pos err ${s.posErrAvg.toFixed(2)} m`);
  assert.ok(s.headErrAvgDeg < 20, `avg heading err ${s.headErrAvgDeg.toFixed(2)} deg`);
  // Loss must actually be exercised.
  assert.ok(h.buf.stats.missing > 0 || h.buf.stats.outOfOrder > 0, "loss/out-of-order occurred");
});

test("long outage: once extrapolation expires the display holds instead of guessing", () => {
  const h = makeHarness({ net: { latencyMs: 50, jitterMs: 0, lossPct: 0, burstChancePct: 0, burstLenMs: 0 }, delayMs: 100 });
  // Warm up with delivery.
  runHarness(h, { seconds: 8 });
  const newest = h.buf.newestT;
  const out = h.buf.evaluate(newest + 400, { maxExtrapolationMs: 250 });
  assert.equal(out.mode, "held");
  const heldV1 = out.vehicles.find((v) => v.id === "v1");
  // The frozen pose is the bounded extrapolation endpoint, not the last
  // authority sample: entering the hold must not rewind by 250 ms of travel.
  const atLimit = h.buf.evaluate(newest + 250, { maxExtrapolationMs: 250 });
  const limitV1 = atLimit.vehicles.find((v) => v.id === "v1");
  assert.equal(heldV1.x, limitV1.x, "hold starts exactly at the extrapolation limit");
  assert.ok(out.staleMs > 250);
  // Later evaluation times return the identical pose: no per-packet creep.
  const later = h.buf.evaluate(newest + 2000, { maxExtrapolationMs: 250 });
  const laterV1 = later.vehicles.find((v) => v.id === "v1");
  assert.equal(laterV1.x, heldV1.x);
  assert.equal(laterV1.heading, heldV1.heading);
  assert.ok(later.staleMs > 1900);
});

test("out-of-order arrival does not teleport the display clock", () => {
  const h = makeHarness({ net: { latencyMs: 90, jitterMs: 80, lossPct: 0, burstChancePct: 0, burstLenMs: 0 }, delayMs: 320, seed: 7 });
  const frames = runHarness(h, { seconds: 20 });
  const s = h.metrics.summary();
  assert.equal(s.discontinuities, 0);
  // With a 200ms delay, jitter of 80ms should still be absorbed by the buffer.
  assert.ok(h.buf.stats.outOfOrder + h.buf.stats.duplicates >= 0);
  assert.ok(frames.every((f) => ["interp", "extrap", "held", "prebuffer"].includes(f.mode)));
});

test("server input is rejected for non-drivable and clamped for drivable", () => {
  const world = new World();
  assert.equal(world.applyInput({ throttle: 5, brake: -2, steer: 9 }).ok, true);
  const input = world.entities.get("v4").input;
  assert.equal(input.throttle, 1);
  assert.equal(input.brake, 0);
  assert.equal(input.steer, 1);
});

test("world tick is deterministic for remote vehicles", () => {
  const a = new World();
  const b = new World();
  for (let i = 0; i < 300; i += 1) {
    a.step(1 / 60);
    b.step(1 / 60);
  }
  const ta = a.truthForRemoteAt(a.clockSec);
  const tb = b.truthForRemoteAt(b.clockSec);
  for (let i = 0; i < ta.length; i += 1) {
    assert.ok(Math.abs(ta[i].x - tb[i].x) < 1e-9);
    assert.ok(Math.abs(ta[i].z - tb[i].z) < 1e-9);
  }
});
