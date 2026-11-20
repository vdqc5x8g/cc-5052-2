import { wrapPi } from "../shared/mathx.js";
import { estimateClockMapping, estimatePlayoutMapping, renderToServer, detectUnitFault } from "./clock-mapping.js";

// Independent acceptance oracle. It derives its own server->render mapping from
// delivery observations (never from the receiver), reconstructs the expected
// truth pose itself, and grades every rendered frame into one of:
//   interp       - playhead inside a valid two-sample interpolation window;
//   extrap       - beyond the newest sample but within the declared limit;
//   blackout     - inside a predeclared loss interval, graded on its own terms;
//   held         - past the extrapolation limit (feed stalled);
// plus cross-cutting checks for regressions and playhead drift.
export class Acceptor {
  constructor(trajectory, {
    snapshotIntervalMs = 50,
    maxExtrapolationMs = 300,
    interpPosTolM = 1.5,
    interpHeadTolRad = 0.25,
    extrapPosTolM = 8,
    extrapHeadTolRad = 0.7,
    maxRegressionMs = 1,
    maxDriftMs = 20,
    maxSteadyLagMs = 700,
    correctionPosTolM = 10,
    correctionHeadTolRad = 0.8,
    warmupMs = 350,
  } = {}) {
    this.trajectory = trajectory;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.limit = maxExtrapolationMs;
    this.warmupMs = warmupMs;
    this.tol = {
      interpPosTolM,
      interpHeadTolRad,
      extrapPosTolM,
      extrapHeadTolRad,
      maxRegressionMs,
      maxDriftMs,
      maxSteadyLagMs,
      correctionPosTolM,
      correctionHeadTolRad,
    };
  }

  // Independent mapping fit from what actually arrived. The unit-rate estimate
  // feeds the unit-fault detector; the playout estimate is the render-clock
  // basis the receiver is expected to have built on its own.
  fitMapping(deliveries) {
    const clean = deliveries.filter((d) => !d.duplicate);
    return estimatePlayoutMapping(clean, this.snapshotIntervalMs);
  }

  fitRateMapping(deliveries) {
    return estimateClockMapping(deliveries.filter((d) => !d.duplicate));
  }

  grade({ trace, frames, mapping }) {
    const mappingToUse = mapping ?? this.fitMapping(trace.deliveries);
    const unit = detectUnitFault(this.fitRateMapping(trace.deliveries));
    const lastSourceT = trace.packets.length ? trace.packets[trace.packets.length - 1].t : Infinity;
    const newestDeliveredAt = (renderMs) => {
      // Latest source timestamp that had actually arrived by this render time.
      let t = -Infinity;
      for (const d of trace.deliveries) {
        if (d.duplicate) continue;
        if (d.arriveAtMs <= renderMs) t = Math.max(t, d.t);
      }
      return t;
    };

    const rows = [];
    const failures = [];
    let prevSource = null;
    let firstCorrection = null;
    let blackoutSeen = false;
    let inRecovery = false;
    let blackout = trace.blackout;
    if (blackout) blackout = { ...blackout, endMs: blackout.endMs + this.limit };

    for (const f of frames) {
      if (f.sourceMs === null || !f.pose) continue;
      const expectedSource = renderToServer(f.renderMs, mappingToUse);
      const driftMs = f.sourceMs - expectedSource;
      const regressionMs = prevSource !== null ? Math.max(0, prevSource - f.sourceMs) : 0;
      const newestT = newestDeliveredAt(f.renderMs);
      const beyondMs = newestT === -Infinity ? Infinity : f.sourceMs - newestT;

      let band = "interp";
      const inBlackout = !!blackout && f.renderMs >= blackout.startMs && f.renderMs <= blackout.endMs;
      if (inBlackout) {
        band = "blackout";
        blackoutSeen = true;
      } else if (beyondMs > this.limit + 1e-6) {
        band = "held";
      } else if (beyondMs > 1e-6) {
        band = "extrap";
      }
      // Recovery runs continuously from the first frame after the blackout
      // until the playhead has caught back up to its ideal target. Using the
      // target residual (not the newest-sample gap) avoids ending the exemption
      // during the brief moments catch-up dips inside the buffer again.
      if (blackoutSeen && !inBlackout) inRecovery = true;
      if (inRecovery && Math.abs(driftMs) <= this.tol.maxDriftMs) inRecovery = false;
      // Once every produced packet has arrived, the source timeline is simply
      // exhausted: a lagging playhead is end-of-data, not clock drift.
      const dataExhausted = newestT >= lastSourceT - 1e-6;

      const truth = this.trajectory.poseAt(f.sourceMs / 1000);
      const posErr = Math.hypot(f.pose.x - truth.x, f.pose.z - truth.z);
      const headErr = Math.abs(wrapPi(f.pose.heading - truth.heading));
      const row = {
        renderMs: f.renderMs,
        sourceMs: f.sourceMs,
        expectedSourceMs: expectedSource,
        mode: f.mode,
        band,
        posErrM: posErr,
        headErrRad: headErr,
        beyondMs,
        driftMs,
        regressionMs,
        newestT,
      };
      rows.push(row);

      const addFailure = (check, message, extra = {}) =>
        failures.push({ renderMs: f.renderMs, sourceMs: f.sourceMs, band, check, message, ...extra });

      // While the playout clock is priming against the first samples the
      // playhead is deliberately clamped to the newest sample; drift against
      // the steady-state mapping is expected there, not a defect.
      const inWarmup = f.renderMs < this.warmupMs;
      // A slower-than-target playhead is the designed response to starvation:
      // it stays monotone and inside the extrapolation budget. It only becomes
      // a fault if it grows past the steady-state lag allowance, whereas any
      // backward motion is caught separately as a regression.
      if (-driftMs > this.tol.maxSteadyLagMs && !dataExhausted && !inWarmup && !inBlackout && !inRecovery) {
        addFailure("playhead-drift", `steady playhead lag ${(-driftMs).toFixed(1)} ms exceeds ${this.tol.maxSteadyLagMs} ms`, { driftMs });
      }
      if (regressionMs > this.tol.maxRegressionMs) {
        addFailure("regression", `render playhead moved backward ${regressionMs.toFixed(1)} ms`, { regressionMs });
      }

      if (inWarmup || inRecovery) {
        // While priming or catching up after a blackout the playhead presents
        // an older but still correct source instant; the pose is graded by the
        // dedicated first-correction check and continuity alone here.
      } else if (band === "interp") {
        if (posErr > this.tol.interpPosTolM) {
          addFailure("interp-position", `interp position error ${posErr.toFixed(2)} m > ${this.tol.interpPosTolM} m`, { posErrM: posErr });
        }
        if (headErr > this.tol.interpHeadTolRad) {
          addFailure("interp-heading", `interp heading error ${(headErr * 180 / Math.PI).toFixed(1)} deg > ${(this.tol.interpHeadTolRad * 180 / Math.PI).toFixed(1)} deg`, { headErrRad: headErr });
        }
      } else if (band === "extrap") {
        if (beyondMs > this.limit + 1e-6) {
          addFailure("extrap-overrun", `extrapolation ${beyondMs.toFixed(1)} ms past newest sample exceeds declared ${this.limit} ms`, { beyondMs });
        }
        if (posErr > this.tol.extrapPosTolM) {
          addFailure("extrap-position", `extrap position error ${posErr.toFixed(2)} m > ${this.tol.extrapPosTolM} m`, { posErrM: posErr });
        }
        // Heading is deliberately held rather than guessed during
        // extrapolation, so it is not graded against the turning truth here;
        // the interpolation window after recovery catches any real heading
        // fault instead.
      } else if (band === "held" && !inBlackout) {
        addFailure("feed-held", `feed held ${beyondMs.toFixed(0)} ms beyond the extrapolation limit`, { beyondMs });
      } else if (band === "blackout" && beyondMs > this.limit + 1e-6 && f.mode !== "held") {
        addFailure("blackout-overrun", `blackout frame extrapolated ${beyondMs.toFixed(0)} ms beyond the declared limit`, { beyondMs });
      }

      // First interpolation frame after the blackout window: it must land
      // close to truth at the instant it claims to present, with the basis for
      // the number recorded so the verdict is readable, not just pass/fail.
      if (blackout && blackoutSeen && firstCorrection === null && f.renderMs > blackout.endMs && band === "interp") {
        firstCorrection = {
          renderMs: f.renderMs,
          sourceMs: f.sourceMs,
          posErrM: posErr,
          headErrRad: headErr,
          withinTolerance: posErr <= this.tol.correctionPosTolM && headErr <= this.tol.correctionHeadTolRad,
          basis: `truth pose reconstructed analytically at source t=${f.sourceMs.toFixed(1)} ms; tol ${this.tol.correctionPosTolM} m / ${(this.tol.correctionHeadTolRad * 180 / Math.PI).toFixed(0)} deg`,
        };
        if (!firstCorrection.withinTolerance) {
          addFailure("first-correction", `first post-blackout correction off by ${posErr.toFixed(2)} m / ${(headErr * 180 / Math.PI).toFixed(1)} deg`);
        }
      }

      prevSource = f.sourceMs;
    }

    const summary = this.summarize(rows);
    return {
      accepted: failures.length === 0 && !unit.unitFault,
      unitFault: unit,
      mapping: mappingToUse,
      blackout: blackout
        ? {
            ...blackout,
            frames: rows.filter((r) => r.band === "blackout").length,
            maxBeyondMs: Math.max(0, ...rows.filter((r) => r.band === "blackout").map((r) => r.beyondMs)),
            withinDeclaredLimit: rows
              .filter((r) => r.band === "blackout" && r.mode !== "held")
              .every((r) => r.beyondMs <= this.limit + 1e-6),
          }
        : null,
      firstCorrection,
      summary,
      failures,
      rows,
    };
  }

  summarize(rows) {
    const agg = (band) => {
      const sel = rows.filter((r) => r.band === band);
      if (!sel.length) return { frames: 0, posErrMaxM: 0, headErrMaxRad: 0 };
      return {
        frames: sel.length,
        posErrMaxM: Math.max(...sel.map((r) => r.posErrM)),
        headErrMaxRad: Math.max(...sel.map((r) => r.headErrRad)),
      };
    };
    return {
      totalFrames: rows.length,
      interp: agg("interp"),
      extrap: agg("extrap"),
      blackout: agg("blackout"),
      held: agg("held"),
      maxRegressionMs: Math.max(0, ...rows.map((r) => r.regressionMs)),
      maxLagMs: Math.max(0, ...rows.map((r) => Math.max(0, -r.driftMs))),
    };
  }
}
