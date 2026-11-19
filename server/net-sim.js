import { clamp } from "../shared/mathx.js";
import { gaussian } from "../shared/rng.js";

// Simulated path from server to one spectator: fixed latency, per-packet
// jitter, independent loss, and correlated burst outages.
export class NetSim {
  constructor(config, rng) {
    this.config = { ...config };
    this.rng = rng;
    this.burstRemaining = 0;
    this.stats = { sent: 0, dropped: 0, delivered: 0, burstDrops: 0 };
  }

  setConfig(config) {
    this.config = { ...config };
  }

  // Returns { deliverAt } or null when the packet is dropped.
  schedule(sendAtMs) {
    const { latencyMs, jitterMs, lossPct, burstChancePct, burstLenMs } = this.config;
    this.stats.sent += 1;

    if (this.burstRemaining <= 0 && burstChancePct > 0) {
      if (this.rng() < burstChancePct / 100) {
        this.burstRemaining = Math.max(1, Math.round(burstLenMs / 50));
      }
    }

    let dropped = false;
    if (this.burstRemaining > 0) {
      this.burstRemaining -= 1;
      dropped = true;
      this.stats.burstDrops += 1;
    } else if (lossPct > 0 && this.rng() < lossPct / 100) {
      dropped = true;
    }

    if (dropped) {
      this.stats.dropped += 1;
      return null;
    }

    const jitter = jitterMs > 0 ? gaussian(this.rng) * jitterMs * 0.5 : 0;
    const delay = clamp(latencyMs + jitter, 1, 5000);
    this.stats.delivered += 1;
    return { deliverAt: sendAtMs + delay };
  }
}
