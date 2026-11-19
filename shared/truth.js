import { createTrack, createSpeedProfile, createTruthSampler } from "./track.js";
import { VEHICLE_SETUP, REMOTE_IDS } from "./roster.js";

// Deterministic ground truth for the remote vehicles, derived from the shared
// curve + speed law. Both the server simulation and the spectator use this;
// nothing about it travels over the wire.
export function createTruthModel() {
  const track = createTrack();
  const samplers = new Map();
  for (const setup of VEHICLE_SETUP) {
    samplers.set(
      setup.id,
      createTruthSampler(
        track,
        createSpeedProfile(track, setup.speedShift),
        setup.startDistance,
        setup.lateral,
        setup.hoverPhase,
      ),
    );
  }
  return {
    track,
    sample(id, clockSec) {
      const s = samplers.get(id);
      if (!s) throw new Error(`unknown vehicle ${id}`);
      return s.sample(clockSec);
    },
    remoteAt(clockSec) {
      return REMOTE_IDS.map((id) => {
        const s = samplers.get(id).sample(clockSec);
        return { id, x: s.x, y: s.y, z: s.z, heading: s.heading };
      });
    },
  };
}
