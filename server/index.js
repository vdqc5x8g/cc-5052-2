import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { World } from "./world.js";
import { NetSim } from "./net-sim.js";
import { makeRng } from "../shared/rng.js";
import { clamp } from "../shared/mathx.js";
import {
  PROTOCOL_VERSION,
  DEFAULT_NET,
  sanitizeNetConfig,
  validateHello,
} from "../shared/protocol.js";
import { SNAPSHOT_HZ, SERVER_TICK_HZ, VEHICLE_SETUP, DRIVABLE_ID } from "../shared/roster.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const SIM_STEP_MS = 1000 / SERVER_TICK_HZ;
const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let full;
  if (urlPath.startsWith("/vendor/jsm/")) {
    full = path.resolve(ROOT, "node_modules/three/examples/jsm", urlPath.slice("/vendor/jsm/".length));
  } else if (urlPath === "/vendor/three.module.js") {
    full = path.resolve(ROOT, "node_modules/three/build/three.module.js");
  } else {
    const rel = urlPath === "/" ? "/public/index.html" : urlPath;
    full = path.resolve(ROOT, `.${rel}`);
  }
  if (!full.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(full)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

export function startServer({
  port = 8080,
  host = "0.0.0.0",
  seed = 1337,
  clock = () => performance.now(),
} = {}) {
  const world = new World();
  const epoch = 1 + (seed % 100000);
  const serverStart = clock();
  const clients = new Set();
  const pending = [];
  let nextClientId = 1;
  let seq = 0;
  let extraSeq = 0;

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });

  function now() {
    return clock() - serverStart;
  }

  function send(client, obj) {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(obj));
  }

  function sendWelcome(client) {
    send(client, {
      type: "welcome",
      v: PROTOCOL_VERSION,
      epoch,
      spectatorId: client.id,
      serverNow: round(now(), 1),
      tickHz: SNAPSHOT_HZ,
      track: { length: round(world.track.length, 2), control: world.track.control },
      vehicles: VEHICLE_SETUP.map(({ id, name, color, drivable }) => ({ id, name, color, drivable })),
      drivableId: DRIVABLE_ID,
      net: client.net.config,
    });
  }

  // A snapshot is serialised once per sequence, but each spectator gets an
  // independently delayed / dropped copy of it.
  function broadcast() {
    seq += 1;
    const snap = world.snapshot();
    const base = {
      type: "state",
      v: PROTOCOL_VERSION,
      epoch,
      seq,
      t: snap.t,
      sentAt: round(now(), 1),
      vehicles: snap.vehicles,
      player: {
        id: DRIVABLE_ID,
        ...world.entities.get(DRIVABLE_ID).input,
        speed: round(world.player.speed, 2),
        offTrack: world.player.offTrack,
      },
    };
    for (const client of clients) {
      const scheduled = client.net.schedule(base.sentAt);
      if (!scheduled) continue;
      pending.push({ client, deliverAt: scheduled.deliverAt, payload: JSON.stringify(base) });
    }
    // Drop packets whose spectator disconnected while in flight.
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (!clients.has(pending[i].client)) pending.splice(i, 1);
    }
  }

  let simAccum = 0;
  let snapAccum = 0;
  let last = clock();

  const tickTimer = setInterval(() => {
    const t = clock();
    const elapsed = clamp(t - last, 0, 200);
    last = t;
    simAccum += elapsed;
    snapAccum += elapsed;
    let steps = 0;
    while (simAccum >= SIM_STEP_MS && steps < 12) {
      world.step(SIM_STEP_MS / 1000);
      simAccum -= SIM_STEP_MS;
      steps += 1;
    }
    while (snapAccum >= SNAPSHOT_MS) {
      snapAccum -= SNAPSHOT_MS;
      broadcast();
    }
    const at = now();
    const due = [];
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].deliverAt <= at) {
        due.push(pending[i]);
        pending.splice(i, 1);
      }
    }
    // Deliver in scheduled-arrival order so reordering comes from jitter
    // alone, never from the flush loop's iteration order.
    due.sort((a, b) => a.deliverAt - b.deliverAt);
    for (const item of due) send(item.client, JSON.parse(item.payload));
  }, 3);

  function handleMessage(client, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(client, { type: "error", code: "bad-json", message: "malformed JSON" });
      return;
    }
    if (!msg || typeof msg !== "object") {
      send(client, { type: "error", code: "bad-message", message: "message must be an object" });
      return;
    }
    switch (msg.type) {
      case "hello": {
        const res = validateHello(msg);
        if (!res.ok) {
          send(client, { type: "error", code: "bad-hello", message: res.error });
          return;
        }
        client.name = res.name;
        sendWelcome(client);
        break;
      }
      case "input": {
        const result = world.applyInput(msg.value ?? msg);
        send(client, {
          type: "input-applied",
          ok: result.ok,
          reason: result.reason,
          serverNow: round(now(), 1),
          input: world.entities.get(DRIVABLE_ID).input,
        });
        break;
      }
      case "net": {
        const { config, warnings } = sanitizeNetConfig(msg.value ?? msg);
        client.net.setConfig(config);
        send(client, { type: "net-applied", net: config, warnings });
        break;
      }
      case "burst": {
        // Force an immediate correlated outage for this spectator only.
        const ms = clamp(Number(msg.lenMs ?? 500), 0, 5000);
        client.net.burstRemaining = Math.max(1, Math.round(ms / 50));
        send(client, { type: "burst-applied", lenMs: ms });
        break;
      }
      case "ping": {
        send(client, { type: "pong", clientTime: msg.clientTime, serverNow: round(now(), 1) });
        break;
      }
      default:
        send(client, { type: "error", code: "unknown-type", message: `unknown type ${msg.type}` });
    }
  }

  wss.on("connection", (socket) => {
    nextClientId += 1;
    const client = {
      id: `spectator-${nextClientId}`,
      socket,
      name: "spectator",
      net: new NetSim({ ...DEFAULT_NET }, makeRng(seed * 31 + nextClientId * 7919)),
    };
    clients.add(client);
    socket.on("message", (raw) => handleMessage(client, raw));
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));

    const statsTimer = setInterval(() => {
      if (socket.readyState !== 1) return;
      send(client, {
        type: "netstats",
        stats: {
          ...client.net.stats,
          inflight: pending.reduce((n, p) => n + (p.client === client ? 1 : 0), 0),
          config: client.net.config,
        },
        serverNow: round(now(), 1),
      });
    }, 500);
    socket.on("close", () => clearInterval(statsTimer));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(`[hover-spectator] listening on http://localhost:${addr.port}`);
      console.log(`[hover-spectator] websocket: ws://localhost:${addr.port}`);
      resolve({
        server,
        wss,
        world,
        port: addr.port,
        close() {
          clearInterval(tickTimer);
          for (const c of clients) c.socket.terminate();
          return new Promise((res) => {
            wss.close(() => server.close(res));
          });
        },
      });
    });
  });
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  startServer({ port }).catch((err) => {
    console.error("[hover-spectator] failed to start:", err);
    process.exit(1);
  });
}
