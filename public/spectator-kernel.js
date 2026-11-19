import { DisplayBuffer, DisplayClock } from "./display.js";
import { DisplayMetrics, displayLagMs } from "../shared/metrics.js";
import { createTruthModel } from "../shared/truth.js";
import { sanitizeNetConfig, sanitizeInput, DEFAULT_NET, DEFAULT_DISPLAY } from "../shared/protocol.js";
import { SNAPSHOT_HZ, REMOTE_IDS } from "../shared/roster.js";

// The spectator kernel owns everything except drawing: transport, the
// timestamp-indexed display buffer, the display clock, per-frame evaluation,
// measurement, and the control surface (input + network knobs). UI code holds
// no authoritative state; it calls these methods and renders the snapshot.
// Failures are reported through onEvent so the UI can surface them, never by
// silently mutating the timeline.

export function createSpectatorKernel({ transport, onEvent = () => {}, now = () => performance.now() } = {}) {
  const buffer = new DisplayBuffer({ historyMs: 8000 });
  const clock = new DisplayClock({ ...DEFAULT_DISPLAY });
  const metrics = new DisplayMetrics(6000);
  const truth = createTruthModel();

  const input = { throttle: 0, brake: 0, steer: 0 };
  const netConfig = { ...DEFAULT_NET };
  const player = { speed: 0, offTrack: false };
  let selected = REMOTE_IDS[0];
  let frameSeq = 0;
  let welcome = null;
  let connected = false;
  let lastMessageAt = 0;
  let lastInputSentAt = -Infinity;
  let netStats = null;
  let echo = null;
  let pausedTrail = false;
  let showTruth = true;
  let lastResyncAt = null;
  let lastReportedHeld = false;
  let frozen = null; // pinned pose while the display clock is clamped

  function emit(level, code, message, detail) {
    onEvent({ level, code, message, detail, at: now() });
  }

  transport.onStatus((status) => {
    connected = status === "open";
    if (!connected) {
      clock.reset();
      buffer.reset();
      frozen = null;
      emit("warn", "transport-closed", "link closed; display timeline reset, retrying");
    } else {
      emit("info", "transport-open", "link established");
    }
  });

  transport.onMessage((msg) => {
    lastMessageAt = now();
    switch (msg.type) {
      case "welcome": {
        welcome = msg;
        buffer.reset();
        clock.reset();
        metrics.reset();
        frozen = null;
        lastReportedHeld = false;
        clock.setOptions({ delayMs: clock.options.delayMs });
        netConfigAppliedFromServer(msg.net);
        emit("info", "welcome", `epoch ${msg.epoch}, ${msg.vehicles?.length ?? 0} vehicles`);
        break;
      }
      case "state": {
        const res = buffer.ingest(msg);
        if (!res.ok && res.reason === "malformed") {
          emit("error", "malformed-packet", `dropped malformed state seq=${msg?.seq}`);
        }
        if (msg.player && msg.player.speed !== undefined) {
          player.speed = msg.player.speed;
          player.offTrack = !!msg.player.offTrack;
        }
        break;
      }
      case "netstats":
        netStats = msg.stats;
        break;
      case "net-applied":
        if (msg.warnings?.length) emit("warn", "net-clamped", msg.warnings.join("; "), msg.net);
        echo = { type: "net", config: msg.net };
        break;
      case "input-applied":
        if (!msg.ok) emit("error", "input-rejected", msg.reason ?? "input rejected");
        else echo = { type: "input", input: msg.input };
        break;
      case "burst-applied":
        emit("info", "burst", `blackout ${Math.round(msg.lenMs)} ms`);
        break;
      case "error":
        emit("error", `server-${msg.code ?? "error"}`, msg.message ?? "server error");
        break;
      default:
        break;
    }
  });

  function netConfigAppliedFromServer(net) {
    if (!net) return;
    Object.assign(netConfig, net);
  }

  // ---- controls (validated here, not in the DOM) ----
  function setNet(patch) {
    if (!connected) {
      emit("error", "control-offline", "cannot apply network settings while disconnected");
      return { ok: false, errors: ["offline"] };
    }
    const merged = { ...netConfig, ...patch };
    const { config, warnings } = sanitizeNetConfig(merged);
    Object.assign(netConfig, config);
    const sent = transport.send({ type: "net", value: config });
    if (!sent) {
      emit("error", "control-send-failed", "network settings not sent");
      return { ok: false, errors: ["send failed"], config };
    }
    if (warnings.length) emit("warn", "net-clamped", warnings.join("; "));
    return { ok: true, config, warnings };
  }

  function setDisplayDelay(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0 || n > 800) {
      emit("error", "bad-delay", `display delay must be 0..800 ms, got ${ms}`);
      return { ok: false, error: "delay must be 0..800 ms" };
    }
    clock.setOptions({ delayMs: n });
    clock.reset();
    emit("info", "delay-changed", `display delay ${n} ms`);
    return { ok: true, delayMs: n };
  }

  function setMaxExtrapolation(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      emit("error", "bad-extrap", "extrapolation limit must be 0..1000 ms");
      return { ok: false, error: "extrapolation limit must be 0..1000 ms" };
    }
    clock.setOptions({ maxExtrapolationMs: n });
    return { ok: true, maxExtrapolationMs: n };
  }

  function forceBurst(lenMs = 600) {
    if (!connected) {
      emit("error", "control-offline", "cannot inject a blackout while disconnected");
      return { ok: false, error: "offline" };
    }
    const sent = transport.send({ type: "burst", lenMs });
    if (!sent) return { ok: false, error: "send failed" };
    return { ok: true };
  }

  function setInput(next, { force = false } = {}) {
    const clean = sanitizeInput(next);
    const changed =
      clean.throttle !== input.throttle || clean.brake !== input.brake || clean.steer !== input.steer;
    const t = now();
    if (!changed && !force && t - lastInputSentAt < 1000) return { ok: true, skipped: true };
    if (!connected) {
      emit("error", "control-offline", "input ignored: no link to simulation");
      return { ok: false, error: "offline" };
    }
    Object.assign(input, clean);
    lastInputSentAt = t;
    const sent = transport.send({ type: "input", value: clean });
    if (!sent) {
      emit("error", "control-send-failed", "input not sent");
      return { ok: false, error: "send failed" };
    }
    return { ok: true, input: { ...input } };
  }

  function selectVehicle(id) {
    if (!truth || !REMOTE_IDS.includes(id)) {
      // Drivable vehicle is selectable for camera purposes too.
      const ok = id === "v4";
      if (!ok) {
        emit("warn", "bad-select", `unknown vehicle ${id}`);
        return { ok: false };
      }
    }
    selected = id;
    return { ok: true, selected };
  }

  // ---- per-frame ----
  function tick(dtMs) {
    frameSeq += 1;
    const status = clock.advance(dtMs, buffer);
    // A reported clock cliff means the drawn timeline genuinely skipped. Drop
    // the continuity baseline so the jump is counted once in metrics, not
    // smeared into the next frame's per-frame delta.
    if (status.resyncEvent && status.resyncEvent.at !== lastResyncAt) {
      lastResyncAt = status.resyncEvent.at;
      metrics.resetContinuity();
      emit(
        "warn",
        "clock-resync",
        `display clock skipped ${Math.round(status.resyncEvent.jumpedMs)} ms (${status.resyncEvent.reason})`,
        status.resyncEvent,
      );
    }
    const displayT = status.displayT;
    let evaluation =
      displayT === null
        ? { mode: "empty", vehicles: [] }
        : buffer.evaluate(displayT, { maxExtrapolationMs: clock.options.maxExtrapolationMs });

    // While the clock is clamped the cursor does not move, but the authority
    // buffer keeps growing behind it: re-evaluating each frame would walk the
    // pose forward one packet interval at a time — the per-packet teleport this
    // layer exists to prevent. Pin the pose captured at the moment the ceiling
    // engaged and repeat it until real data has refilled past the cursor.
    if (status.clamped && displayT !== null) {
      if (!frozen) {
        frozen = {
          vehicles: evaluation.vehicles.map((v) => ({ ...v })),
          displayT,
          since: now(),
        };
      }
      evaluation = {
        ...evaluation,
        mode: "held",
        vehicles: frozen.vehicles,
        ageMs: now() - frozen.since,
        staleMs: now() - frozen.since,
        reason: "clock frozen at extrapolation limit",
      };
    } else if (frozen) {
      frozen = null;
    }

    const truthVehicles =
      displayT === null || !Number.isFinite(displayT) ? [] : truth.remoteAt(displayT / 1000);

    if (!status.priming && evaluation.vehicles.length && truthVehicles.length) {
      // Grade only remote vehicles; the drivable one is legitimately steered.
      metrics.add({
        atMs: now(),
        mode: evaluation.mode,
        vehicles: evaluation.vehicles.filter((v) => REMOTE_IDS.includes(v.id)),
        truth: truthVehicles,
        displayT,
      });
    }

    const held = evaluation.mode === "held";
    if (held && !lastReportedHeld) {
      emit(
        "error",
        "feed-held",
        `feed stalled: pose frozen at the ${clock.options.maxExtrapolationMs} ms extrapolation limit`,
      );
    } else if (!held && lastReportedHeld) {
      emit("info", "feed-resumed", "new authority data, display resumed interpolating");
    }
    lastReportedHeld = held;

    const summary = metrics.summary(netStats);
    const lagMs = displayLagMs(buffer.newestT, displayT);

    return {
      frameSeq,
      connected,
      phase: status.priming ? "priming" : evaluation.mode,
      mode: evaluation.mode,
      reason: evaluation.reason ?? null,
      displayT,
      newestT: buffer.newestT,
      oldestT: buffer.oldestT,
      lagMs,
      extrapolation: {
        ageMs: evaluation.ageMs ?? 0,
        remainingMs: evaluation.remainingMs ?? null,
        limitMs: clock.options.maxExtrapolationMs,
        // During a hold, age is the staleness of the last authority pose, not
        // an extrapolation distance: this is real delay the viewer is seeing.
        staleMs: held ? evaluation.ageMs ?? null : null,
      },
      vehicles: evaluation.vehicles,
      truth: truthVehicles,
      clock: { ...status, delayMs: clock.options.delayMs, maxExtrapolationMs: clock.options.maxExtrapolationMs },
      buffer: {
        depth: buffer.depth,
        spanMs: buffer.spanMs,
        stats: { ...buffer.stats },
        newestT: buffer.newestT,
      },
      metrics: summary,
      net: { ...netConfig },
      netStats,
      truthOverlay: { enabled: showTruth, sampled: truthVehicles.length > 0 },
      input: { ...input },
      player: { ...player },
      selected,
      echo,
      pausedTrail,
      welcome,
      snapshotHz: SNAPSHOT_HZ,
      lastMessageAgeMs: lastMessageAt ? now() - lastMessageAt : null,
    };
  }

  function setTruthOverlay(enabled) {
    showTruth = !!enabled;
    return showTruth;
  }
  function setPausedTrail(paused) {
    pausedTrail = !!paused;
    return pausedTrail;
  }
  function cycleSelection() {
    const list = VEHICLE_SETUP.map((v) => v.id);
    selected = list[(list.indexOf(selected) + 1) % list.length];
    return selected;
  }

  return {
    tick,
    setNet,
    setDisplayDelay,
    setMaxExtrapolation,
    forceBurst,
    setInput,
    selectVehicle,
    cycleSelection,
    setTruthOverlay,
    setPausedTrail,
    get netConfig() { return { ...netConfig }; },
    get state() {
      return { selected, connected, displayDelayMs: clock.options.delayMs };
    },
  };
}
