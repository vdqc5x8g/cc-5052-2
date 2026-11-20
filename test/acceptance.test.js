import test from "node:test";
import assert from "node:assert/strict";
import { createHairpin, createSpinner, samplePackets } from "../acceptance/analytic-track.js";
import { buildReorderTrace, buildLossTrace, MEAN_LATENCY_MS, SNAPSHOT_MS } from "../acceptance/network-traces.js";
import { estimateClockMapping, estimatePlayoutMapping, renderToServer, detectUnitFault } from "../acceptance/clock-mapping.js";
import { injectTimestampUnitFault, injectDuplicateLateSample } from "../acceptance/faults.js";
import { PlaybackReceiver } from "../acceptance/playback-receiver.js";
import { Acceptor } from "../acceptance/acceptor.js";
import { runScenario, shortenTrace, shortenFrames } from "../acceptance/scenario-runner.js";
import { renderReplayHtml } from "../acceptance/replay.js";
import { buildScenarios, runOne } from "../acceptance/run-acceptance.js";

function hairpinSetup() {
  const traj = createHairpin();
  const packets = samplePackets(traj, { startMs: 0, endMs: traj.durationSec * 1000, intervalMs: SNAPSHOT_MS });
  return {
    traj,
    packets,
    reorder: buildReorderTrace(packets, traj.windows.apexServerMs),
    loss: buildLossTrace(packets, traj.windows.bendMs),
  };
}

test("hairpin is an analytic 180-degree bend with a continuous heading timeline", () => {
  const traj = createHairpin();
  const entry = traj.poseAt(traj.windows.arcEntryMs / 1000 + 0.02);
  const apex = traj.poseAt(traj.windows.apexServerMs / 1000);
  const exit = traj.poseAt(traj.windows.arcExitMs / 1000 - 0.02);
  assert.ok(Math.abs(entry.heading - Math.PI / 2) < 0.05, `entry heading ${entry.heading}`);
  assert.ok(Math.abs(apex.heading) < 0.05, `apex heading ${apex.heading}`);
  assert.ok(Math.abs(exit.heading + Math.PI / 2) < 0.05);
  // Adjacent 50 ms samples never carry a discontinuous heading jump.
  for (let t = 0; t < traj.durationSec * 1000 - 50; t += 50) {
    const a = traj.poseAt(t / 1000).heading;
    const b = traj.poseAt((t + 50) / 1000).heading;
    const delta = Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    assert.ok(delta < 1.6, `heading jump ${delta} at ${t} ms`);
  }
});

test("the two network records share an identical mean latency", () => {
  const { reorder, loss } = hairpinSetup();
  assert.ok(Math.abs(reorder.meanLatencyMs - MEAN_LATENCY_MS) < 1e-9);
  assert.ok(Math.abs(loss.meanLatencyMs - MEAN_LATENCY_MS) < 1e-9);
  assert.ok(Math.abs(reorder.meanLatencyMs - loss.meanLatencyMs) < 1e-9);
  assert.ok(reorder.latencies.every((l) => l >= 10));
  assert.ok(loss.latencies.every((l) => l >= 10));
});

test("reorder record inverts arrival order at the apex; loss record drops pre-apex and bursts after", () => {
  const { reorder, loss, traj } = hairpinSetup();
  assert.ok(reorder.inversions.length >= 1, "at least one overtaking packet at the apex");
  for (const inv of reorder.inversions) {
    assert.ok(Math.abs(reorder.packets[inv.overtakingSeq].t - traj.windows.apexServerMs) < 500);
  }
  const [bendStart, bendEnd] = traj.windows.bendMs;
  assert.ok(loss.dropped.length >= 5);
  assert.ok(loss.dropped.every((i) => loss.packets[i].t >= bendStart && loss.packets[i].t <= bendEnd));
  assert.ok(loss.blackout.startMs === bendStart);
  const burst = loss.deliveries.filter((d) => d.t > bendEnd && d.t <= bendEnd + 400);
  assert.ok(burst.length >= 3, "post-turn catch-up burst exists");
  assert.ok(burst.every((d) => d.latencyMs > MEAN_LATENCY_MS));
});

test("clock mapping is estimated independently from deliveries only", () => {
  const { reorder } = hairpinSetup();
  const m = estimateClockMapping(reorder.deliveries);
  assert.ok(Math.abs(m.alpha - 1) < 1e-9);
  const playout = estimatePlayoutMapping(reorder.deliveries, SNAPSHOT_MS);
  assert.ok(playout.betaMs >= MEAN_LATENCY_MS - 120 && playout.betaMs <= MEAN_LATENCY_MS + 80);
  const back = renderToServer(2000, playout);
  assert.ok(Math.abs((back + playout.betaMs) - 2000) < 1e-9);
});

test("timestamp unit fault exposes itself through the estimated rate, not just offset", () => {
  const { reorder } = hairpinSetup();
  const faulty = injectTimestampUnitFault(reorder, { factor: 1000 });
  const rate = estimateClockMapping(faulty.deliveries);
  const detection = detectUnitFault(rate);
  assert.ok(detection.unitFault);
  assert.ok(Math.abs(rate.alpha - 0.001) < 1e-6);
});

test("acceptor passes monotone playback on both impaired records with bounded interp error", () => {
  const { traj, reorder, loss } = hairpinSetup();
  const acceptor = new Acceptor(traj);
  for (const trace of [reorder, loss]) {
    const { frames } = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "monotone", autoDelay: true }) });
    const v = acceptor.grade({ trace, frames });
    assert.ok(v.accepted, v.failures.map((f) => f.message).join("; "));
    // Recovery frames legitimately present an older correct source instant;
    // only steady-state interpolation is held to the tight pose budget.
    const steadyInterp = v.rows.filter(
      (r) => r.band === "interp" && r.renderMs >= acceptor.warmupMs && Math.abs(r.driftMs) <= acceptor.tol.maxDriftMs,
    );
    assert.ok(steadyInterp.every((r) => r.posErrM < 1.5));
    assert.ok(steadyInterp.every((r) => r.headErrRad < 0.25));
    assert.ok(v.summary.maxRegressionMs === 0);
  }
});

test("extrapolation never crosses the declared limit, and blackout frames are graded separately", () => {
  const { traj, loss } = hairpinSetup();
  const acceptor = new Acceptor(traj);
  const { frames } = runScenario(loss, { receiver: new PlaybackReceiver({ policy: "monotone", autoDelay: true }) });
  const v = acceptor.grade({ trace: loss, frames });
  assert.ok(v.accepted);
  assert.ok(v.blackout.frames > 50);
  assert.ok(v.blackout.withinDeclaredLimit);
  const nonHeld = v.rows.filter((r) => r.mode !== "held");
  assert.ok(nonHeld.every((r) => r.beyondMs <= acceptor.limit + 1e-6));
  assert.ok(v.firstCorrection, "first post-blackout correction is recorded");
  assert.ok(v.firstCorrection.withinTolerance);
  assert.ok(/analytically/.test(v.firstCorrection.basis));
});

test("snapback policy produces a backward playhead regression the acceptor rejects", () => {
  const { traj, reorder } = hairpinSetup();
  const trace = injectDuplicateLateSample(reorder, {
    duplicateSeq: reorder.packets[Math.floor(reorder.packets.length * 0.55)].seq,
    reArriveDelayMs: 500,
  });
  const { frames } = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "snapback", autoDelay: true }) });
  const v = new Acceptor(traj).grade({ trace, frames });
  assert.ok(!v.accepted);
  assert.ok(v.failures.some((f) => f.check === "regression"));
  assert.ok(v.summary.maxRegressionMs > 100);
});

test("stale re-adoption of a repeated late sample is rejected while a correct receiver dedupes", () => {
  const { traj, loss } = hairpinSetup();
  const trace = injectDuplicateLateSample(loss, { duplicateSeq: loss.deliveries[4].seq, reArriveDelayMs: 400 });
  const good = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "monotone", autoDelay: true }) });
  assert.ok(good.receiver.duplicates >= 1);
  assert.ok(new Acceptor(traj).grade({ trace, frames: good.frames }).accepted);
  const stale = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "stale", autoDelay: true }) });
  const verdict = new Acceptor(traj).grade({ trace, frames: stale.frames });
  assert.ok(!verdict.accepted);
  assert.ok(verdict.failures.some((f) => f.check === "regression"));
});

test("slower frame rate changes sampling density but not the referenced source instant", () => {
  const { traj, reorder } = hairpinSetup();
  const run = (hz) =>
    runScenario(reorder, { frameHz: hz, receiver: new PlaybackReceiver({ policy: "monotone", autoDelay: true }) }).frames;
  const at60 = run(60);
  const at30 = run(30);
  let compared = 0;
  for (const f30 of at30) {
    if (f30.sourceMs === null) continue;
    const nearest = at60
      .filter((f) => f.sourceMs !== null)
      .map((f) => ({ f, d: Math.abs(f.renderMs - f30.renderMs) }))
      .sort((a, b) => a.d - b.d)[0];
    // A 30 Hz frame time is always a 60 Hz grid point; allow only floating
    // point slack, never a full frame step.
    assert.ok(nearest.d < 1e-9, `grid mismatch ${nearest.d}`);
    // Same render time must resolve to the same source instant regardless of
    // frame rate: the render->source mapping does not depend on frame cadence.
    assert.ok(Math.abs(nearest.f.sourceMs - f30.sourceMs) <= 1e-9);
    compared += 1;
  }
  assert.ok(compared > 100);
  // Each referenced instant must coincide with an actual delivered packet
  // window, never an invented timestamp.
  const delivered = new Set(reorder.deliveries.map((d) => d.t));
  for (const f of at30) {
    if (f.window && f.window.tA !== undefined) {
      assert.ok(delivered.has(f.window.tA));
      assert.ok(delivered.has(f.window.tB));
    }
  }
});

test("failure replays are self-contained HTML built from a shortened packet series", () => {
  const scenario = buildScenarios().find((s) => s.name === "reorder-snapback");
  const result = runOne(scenario);
  assert.ok(!result.verdict.accepted);
  const firstFailure = result.verdict.failures[0];
  const trimmed = shortenTrace(scenario.trace, firstFailure.renderMs);
  assert.ok(trimmed.packets.length < scenario.trace.packets.length);
  assert.ok(trimmed.deliveries.length < scenario.trace.deliveries.length);
  const frames = shortenFrames(result.frames, firstFailure.renderMs, 1500, 1000 / 60);
  const html = renderReplayHtml({
    title: scenario.name,
    trace: trimmed,
    frames,
    verdict: result.verdict,
    trajectory: scenario.trajectory,
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("</html>"));
  assert.ok(!/src=["']https?:/.test(html), "replay has no external script references");
  const payload = JSON.parse(html.match(/const DATA = (\{[\s\S]*?\});\nconst cv/)[1]);
  assert.ok(payload.frames.length === frames.filter((f) => f.pose).length);
  assert.ok(payload.deliveries.length === trimmed.deliveries.length);
  assert.equal(payload.accepted, false);
});

test("spinner: heading-only jitter is invisible to distance but caught by heading error", () => {
  const spinner = createSpinner({ periodSec: 1, durationSec: 3 });
  const packets = samplePackets(spinner, { startMs: 0, endMs: 3000, intervalMs: SNAPSHOT_MS });
  const trace = {
    kind: "spinner",
    packets,
    latencies: packets.map(() => 30),
    dropped: [],
    deliveries: packets.map((p) => ({ seq: p.seq, t: p.t, arriveAtMs: p.t + 30, latencyMs: 30 })),
    meanLatencyMs: 30,
    inversions: [],
    blackout: null,
  };
  const acceptor = new Acceptor(spinner);
  const good = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "monotone", autoDelay: true }) });
  const frozen = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "headingFreeze", autoDelay: true }) });
  const goodVerdict = acceptor.grade({ trace, frames: good.frames });
  const frozenVerdict = acceptor.grade({ trace, frames: frozen.frames });
  assert.ok(goodVerdict.accepted);
  assert.ok(frozenVerdict.summary.interp.posErrMaxM < 1e-6, "position never changes, distance metric sees nothing");
  assert.ok(frozenVerdict.summary.interp.headErrMaxRad > 0.3, "heading error catches the orientation jitter");
  assert.ok(!frozenVerdict.accepted);
});
