import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHairpin, createSpinner, samplePackets } from "./analytic-track.js";
import { buildReorderTrace, buildLossTrace, SNAPSHOT_MS } from "./network-traces.js";
import { PlaybackReceiver } from "./playback-receiver.js";
import { Acceptor } from "./acceptor.js";
import { runScenario, shortenTrace, shortenFrames } from "./scenario-runner.js";
import { injectTimestampUnitFault, injectDuplicateLateSample } from "./faults.js";
import { renderReplayHtml } from "./replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(here, "..", "reports", "acceptance");

export function buildScenarios() {
  const hairpin = createHairpin();
  const packets = samplePackets(hairpin, {
    startMs: 0,
    endMs: hairpin.durationSec * 1000,
    intervalMs: SNAPSHOT_MS,
  });
  const apex = hairpin.windows.apexServerMs;
  const reorder = buildReorderTrace(packets, apex);
  const loss = buildLossTrace(packets, hairpin.windows.bendMs);

  // Duplicate is injected at an early, definitely-delivered packet whose
  // re-arrival lands well behind the receiver's current playhead: the stale
  // policy pins to an old source instant and the snapback policy visibly
  // rewinds.
  const staleSeq = loss.deliveries[4].seq;
  const snapbackSeq = reorder.packets[Math.floor(reorder.packets.length * 0.55)].seq;

  return [
    {
      name: "reorder-bend-monotone",
      expectPass: true,
      trace: reorder,
      trajectory: hairpin,
      receiver: () => new PlaybackReceiver({ policy: "monotone", autoDelay: true }),
      note: "弯心乱序到达，单调播放头应全部在有效插值窗内",
    },
    {
      name: "loss-bend-monotone",
      expectPass: true,
      trace: loss,
      trajectory: hairpin,
      receiver: () => new PlaybackReceiver({ policy: "monotone", autoDelay: true }),
      note: "弯前丢包、弯后补齐；失联按可外推范围单独验收",
    },
    {
      name: "reorder-unit-fault",
      expectPass: false,
      trace: injectTimestampUnitFault(reorder),
      trajectory: hairpin,
      receiver: () => new PlaybackReceiver({ policy: "monotone", autoDelay: true, primeOnCount: 2 }),
      note: "时间戳单位错误（s 当作 ms）：屏幕位置整体错位，时钟斜率 ~1000",
    },
    {
      name: "loss-stale-duplicate",
      expectPass: false,
      trace: injectDuplicateLateSample(loss, { duplicateSeq: staleSeq, reArriveDelayMs: 400 }),
      trajectory: hairpin,
      receiver: () => new PlaybackReceiver({ policy: "stale", autoDelay: true }),
      note: "重复采用迟到样本：恢复时播放头倒退，车头切线与真值分叉",
    },
    {
      name: "reorder-snapback",
      expectPass: false,
      // A genuinely late re-delivery of an older source packet gives the
      // snapback policy something to yank the playhead back toward.
      trace: injectDuplicateLateSample(reorder, {
        duplicateSeq: snapbackSeq,
        reArriveDelayMs: 500,
      }),
      trajectory: hairpin,
      receiver: () => new PlaybackReceiver({ policy: "snapback", autoDelay: true }),
      note: "对照故障：迟到样本把播放头向后拽，验收器应记录倒退",
    },
  ];
}

export function runOne(scenario, { frameHz = 60 } = {}) {
  const { frames, events, receiver } = runScenario(scenario.trace, {
    frameHz,
    receiver: scenario.receiver(),
  });
  const acceptor = new Acceptor(scenario.trajectory);
  const verdict = acceptor.grade({ trace: scenario.trace, frames });
  return { scenario, frames, events, receiver, verdict };
}

export function saveReplay(result, { dir = REPORT_DIR, frameHz = 60 } = {}) {
  mkdirSync(dir, { recursive: true });
  const firstFailure = result.verdict.failures[0];
  const trimmed = firstFailure
    ? shortenTrace(result.scenario.trace, firstFailure.renderMs)
    : result.scenario.trace;
  const frames = firstFailure
    ? shortenFrames(result.frames, firstFailure.renderMs, 1500, 1000 / frameHz)
    : result.frames;
  const html = renderReplayHtml({
    title: result.scenario.name,
    trace: trimmed,
    frames,
    verdict: result.verdict,
    trajectory: result.scenario.trajectory,
    frameHz,
    note: result.scenario.note ?? "",
  });
  const file = join(dir, `${result.scenario.name}.html`);
  writeFileSync(file, html);
  return file;
}

// Heading-only jitter: same position between observations, changing heading.
export function runSpinnerCheck() {
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
  const good = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "monotone", autoDelay: true }) });
  const frozen = runScenario(trace, { receiver: new PlaybackReceiver({ policy: "headingFreeze", autoDelay: true }) });
  const acceptor = new Acceptor(spinner);
  return {
    trace,
    spinner,
    good: acceptor.grade({ trace, frames: good.frames }),
    frozen: acceptor.grade({ trace, frames: frozen.frames }),
  };
}

function printVerdict(name, verdict) {
  const s = verdict.summary;
  const unit = verdict.unitFault.unitFault ? `单位故障 alpha=${verdict.unitFault.alpha.toExponential(2)}` : "时钟正常";
  console.log(
    `- ${name}: ${verdict.accepted ? "PASS" : "FAIL"} | ${unit} | interp ${s.interp.frames} 帧(最大位置 ${s.interp.posErrMaxM.toFixed(2)} m, 车头 ${(s.interp.headErrMaxRad * 180 / Math.PI).toFixed(1)}°)` +
      ` | extrap ${s.extrap.frames} 帧 | blackout ${s.blackout.frames} 帧 | 最大倒退 ${s.maxRegressionMs.toFixed(1)} ms | 失败 ${verdict.failures.length}`,
  );
  for (const f of verdict.failures.slice(0, 4)) {
    console.log(`    · [${f.check}] @${f.renderMs.toFixed(0)}ms ${f.message}`);
  }
  if (verdict.firstCorrection) {
    const c = verdict.firstCorrection;
    console.log(
      `    首次恢复校正 @${c.renderMs.toFixed(0)}ms: 位置 ${c.posErrM.toFixed(2)} m / 车头 ${(c.headErrRad * 180 / Math.PI).toFixed(1)}° — ${c.withinTolerance ? "达标" : "超差"}`,
    );
  }
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const scenarios = buildScenarios();
  let mismatch = 0;
  for (const scenario of scenarios) {
    const result = runOne(scenario);
    printVerdict(scenario.name, result.verdict);
    const metExpectation = result.verdict.accepted === scenario.expectPass;
    if (!metExpectation) mismatch += 1;
    if (!result.verdict.accepted) {
      const file = saveReplay(result);
      console.log(`      回放已保存（缩短后的包序列）: ${file}`);
    }
  }

  const spin = runSpinnerCheck();
  printVerdict("spinner-good", spin.good);
  const frozenPosOnly = spin.frozen.summary.interp.posErrMaxM;
  const frozenHead = spin.frozen.summary.interp.headErrMaxRad;
  console.log(
    `- spinner-headingFreeze: 位置最大误差 ${frozenPosOnly.toFixed(3)} m（仅测距离会漏判），车头最大误差 ${(frozenHead * 180 / Math.PI).toFixed(1)}°，验收器判 ${spin.frozen.accepted ? "PASS（错误）" : "FAIL（正确捕捉朝向抖动）"}`,
  );
  if (spin.frozen.accepted || !spin.good.accepted) mismatch += 1;

  if (mismatch > 0) {
    console.error(`\n${mismatch} 个场景的验收结果与预期不符`);
    process.exit(1);
  }
  console.log("\n全部场景与预期一致。");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
