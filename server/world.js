import { createTrack, createSpeedProfile, createTruthSampler } from "../shared/track.js";
import { wrapPi, clamp } from "../shared/mathx.js";
import { sanitizeInput } from "../shared/protocol.js";
import { VEHICLE_SETUP, DRIVABLE_ID } from "../shared/roster.js";

const MAX_LATERAL = 9.5;
const OFF_TRACK_LATERAL = 7;
const LAP_RESET_LATERAL = 4;

export class World {
  constructor() {
    this.track = createTrack();
    this.entities = new Map();
    for (const setup of VEHICLE_SETUP) {
      this.entities.set(setup.id, {
        ...setup,
        speedAt: createSpeedProfile(this.track, setup.speedShift),
        pose: { x: 0, y: 0, z: 0, heading: 0, bank: 0, speed: 0 },
        input: { throttle: 0, brake: 0, steer: 0 },
      });
    }
    this.botEntities = VEHICLE_SETUP.filter((v) => !v.drivable).map((setup) => {
      const truth = createTruthSampler(
        this.track,
        this.entities.get(setup.id).speedAt,
        setup.startDistance,
        setup.lateral,
        setup.hoverPhase,
      );
      return { id: setup.id, truth };
    });
    const drivable = VEHICLE_SETUP.find((v) => v.drivable);
    this.player = {
      distance: drivable.startDistance,
      lateral: drivable.lateral,
      lateralVel: 0,
      speed: 26,
      offTrack: false,
    };
    for (const bot of this.botEntities) {
      this.entities.get(bot.id).pose = { ...bot.truth.sample(0) };
    }
    this.refreshPlayerPose();
    this.events = [];
    this.clockSec = 0;
  }

  applyInput(raw) {
    const entity = this.entities.get(DRIVABLE_ID);
    entity.input = sanitizeInput(raw);
    return { ok: true };
  }

  step(dt) {
    this.clockSec += dt;
    for (const bot of this.botEntities) {
      const entity = this.entities.get(bot.id);
      const s = bot.truth.sample(this.clockSec);
      entity.pose = { ...s };
    }
    this.stepPlayer(dt);
  }

  stepPlayer(dt) {
    const entity = this.entities.get(DRIVABLE_ID);
    const p = this.player;
    const { throttle, brake, steer } = entity.input;

    const thrust = throttle * 44;
    const braking = brake * 72;
    const drag = 0.16 * p.speed + 0.0028 * p.speed * p.speed + 1.8;
    p.speed = clamp(p.speed + (thrust - braking - drag) * dt, 0, 98);

    const grip = 0.45 + p.speed / 80;
    const targetLateralVel = steer * 13.5 * grip * (0.35 + 0.65 * clamp(p.speed / 45, 0, 1));
    p.lateralVel += (targetLateralVel - p.lateralVel) * Math.min(1, dt * 7);
    if (Math.abs(steer) < 0.02) p.lateralVel *= Math.exp(-1.8 * dt);
    p.lateral += p.lateralVel * dt;

    const off = Math.abs(p.lateral) > OFF_TRACK_LATERAL;
    if (off && !p.offTrack) this.events.push({ atMs: this.clockSec * 1000, kind: "off-track" });
    if (!off && p.offTrack) this.events.push({ atMs: this.clockSec * 1000, kind: "rejoined" });
    p.offTrack = off;
    if (Math.abs(p.lateral) > MAX_LATERAL) {
      p.lateral = Math.sign(p.lateral) * MAX_LATERAL;
      p.lateralVel *= -0.15;
    }
    if (p.offTrack) p.speed *= Math.exp(-0.6 * dt);

    p.distance = (p.distance + p.speed * dt) % this.track.length;
    this.refreshPlayerPose();
  }

  refreshPlayerPose() {
    const entity = this.entities.get(DRIVABLE_ID);
    const p = this.player;
    const { steer } = entity.input;
    const s = this.track.sampleAt(p.distance);
    const nx = -s.tz;
    const nz = s.tx;
    const vx = s.tx * p.speed + nx * p.lateralVel;
    const vz = s.tz * p.speed + nz * p.lateralVel;
    entity.pose = {
      x: s.x + nx * p.lateral,
      z: s.z + nz * p.lateral,
      y: this.track.heightAt(p.distance) + 0.25 * Math.sin(this.clockSec * 2.6),
      heading: wrapPi(Math.atan2(vx, vz)),
      bank: -steer * 0.3 * clamp(p.speed / 75, 0, 1),
      speed: p.speed,
      distance: p.distance,
    };
  }

  snapshot() {
    const vehicles = [];
    for (const e of this.entities.values()) {
      vehicles.push({
        id: e.id,
        x: round(e.pose.x, 3),
        y: round(e.pose.y, 3),
        z: round(e.pose.z, 3),
        heading: round(wrapPi(e.pose.heading), 4),
        bank: round(e.pose.bank, 4),
        speed: round(e.pose.speed, 2),
      });
    }
    return { t: round(this.clockSec * 1000, 1), vehicles };
  }

  // Analytic ground truth for the remote bots, used by the client's own
  // copy of the same sampler (no truth is sent over the wire).
  truthForRemoteAt(clockSec) {
    const out = [];
    for (const bot of this.botEntities) {
      const s = bot.truth.sample(clockSec);
      out.push({
        id: bot.id,
        x: s.x,
        y: s.y,
        z: s.z,
        heading: wrapPi(s.heading),
      });
    }
    return out;
  }
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
