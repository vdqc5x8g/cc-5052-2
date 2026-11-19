import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createTrack } from "../shared/track.js";
import { VEHICLE_SETUP, REMOTE_IDS, DRIVABLE_ID } from "../shared/roster.js";
import { createSpectatorKernel } from "./spectator-kernel.js";
import { DEFAULT_NET, NET_LIMITS } from "../shared/protocol.js";
import { formatClock } from "../shared/mathx.js";

const $ = (id) => document.getElementById(id);

// ---------- transport ----------
function createWebSocketTransport(url) {
  let ws = null;
  let statusHandler = () => {};
  let messageHandler = () => {};
  let closedByUs = false;

  function open() {
    ws = new WebSocket(url);
    statusHandler("connecting");
    ws.addEventListener("open", () => {
      statusHandler("open");
      ws.send(JSON.stringify({ type: "hello", name: "spectator" }));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        messageHandler({ type: "error", code: "bad-json", message: "client parse failure" });
        return;
      }
      messageHandler(msg);
    });
    ws.addEventListener("close", () => {
      statusHandler("closed");
      if (!closedByUs) setTimeout(open, 2000);
    });
    ws.addEventListener("error", () => statusHandler("error"));
  }
  open();

  return {
    onStatus(fn) { statusHandler = fn; },
    onMessage(fn) { messageHandler = fn; },
    send(obj) {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(obj));
      return true;
    },
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}

const proto = location.protocol === "https:" ? "wss" : "ws";
const transport = createWebSocketTransport(`${proto}://${location.host}`);

const events = [];
const toastQueue = [];
const kernel = createSpectatorKernel({
  transport,
  onEvent(ev) {
    events.push(ev);
    toastQueue.push(ev);
    if (events.length > 200) events.shift();
  },
});

// ---------- scene ----------
const track = createTrack();
const canvas = $("viewport");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x070a10, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x070a10, 320, 760);

const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 2400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(60, 4, -120);
camera.position.set(150, 110, 40);

scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x0a0f18, 1.15));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(160, 220, 60);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x33d6ff, 0.85);
rimLight.position.set(-120, 80, -160);
scene.add(rimLight);

const grid = new THREE.GridHelper(1500, 75, 0x18273a, 0x0f1824);
grid.position.y = -1.5;
scene.add(grid);

function buildTrackMesh() {
  const segments = 900;
  const halfWidth = 13;
  const positions = [];
  for (let i = 0; i < segments; i += 1) {
    const d0 = (i / segments) * track.length;
    const d1 = ((i + 1) / segments) * track.length;
    const a = track.sampleAt(d0);
    const b = track.sampleAt(d1);
    const y0 = track.heightAt(d0);
    const y1 = track.heightAt(d1);
    const anx = -a.tz * halfWidth;
    const anz = a.tx * halfWidth;
    const bnx = -b.tz * halfWidth;
    const bnz = b.tx * halfWidth;
    const quad = [
      [a.x + anx, y0, a.z + anz],
      [b.x + bnx, y1, b.z + bnz],
      [b.x - bnx, y1, b.z - bnz],
      [a.x + anx, y0, a.z + anz],
      [b.x - bnx, y1, b.z - bnz],
      [a.x - anx, y0, a.z - anz],
    ];
    for (const p of quad) positions.push(...p);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x16222f, roughness: 0.9, metalness: 0.15, side: THREE.DoubleSide }),
  );
}
scene.add(buildTrackMesh());

(function buildEdgeGlow() {
  for (const side of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 700; i += 1) {
      const d = (i / 700) * track.length;
      const s = track.sampleAt(d);
      pts.push(new THREE.Vector3(s.x - s.tz * 13.2 * side, track.heightAt(d) + 0.05, s.z + s.tx * 13.2 * side));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    scene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x1d3346, transparent: true, opacity: 0.8 })));
  }
})();

(function buildCenterLine() {
  const pts = [];
  for (let i = 0; i <= 500; i += 1) {
    const d = (i / 500) * track.length;
    const s = track.sampleAt(d);
    pts.push(new THREE.Vector3(s.x, track.heightAt(d) + 0.08, s.z));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x2f4a63, dashSize: 4, gapSize: 5 }),
  );
  line.computeLineDistances();
  scene.add(line);
})();

(function buildGate() {
  const s = track.sampleAt(0);
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x33d6ff, transparent: true, opacity: 0.5 });
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 10, 0.6), mat);
    pillar.position.set(s.x + side * 10, 5, s.z);
    group.add(pillar);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(21, 0.6, 0.6), mat);
  beam.position.set(s.x, 10, s.z);
  group.add(beam);
  scene.add(group);
})();

function buildCraft(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.55,
    roughness: 0.3,
    emissive: color,
    emissiveIntensity: 0.2,
  });
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 3.4, 6, 16), bodyMat);
  hull.rotation.x = Math.PI / 2;
  group.add(hull);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.18, 0.9), bodyMat);
  wing.position.set(0, 0.05, 0.5);
  group.add(wing);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.8, 0.9), bodyMat);
  fin.position.set(0, 0.36, 1.15);
  group.add(fin);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), bodyMat);
  nose.position.set(0, 0, -1.7);
  group.add(nose);
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 24),
    new THREE.MeshBasicMaterial({ color: 0x33d6ff, transparent: true, opacity: 0.14 }),
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = -1.2;
  group.add(pad);
  return group;
}

const craftById = new Map();
const ghostById = new Map();
for (const v of VEHICLE_SETUP) {
  const craft = buildCraft(v.color);
  scene.add(craft);
  craftById.set(v.id, craft);
  const ghost = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 4.4, 5, 1, true),
    new THREE.MeshBasicMaterial({
      color: REMOTE_IDS.includes(v.id) ? 0x8fa3bb : 0x4a5a70,
      wireframe: true,
      transparent: true,
      opacity: 0.34,
    }),
  );
  ghost.rotation.order = "YXZ";
  ghost.rotation.x = Math.PI / 2;
  scene.add(ghost);
  ghostById.set(v.id, ghost);
}

function makeTrail(color, opacity, max) {
  const positions = new Float32Array(max * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  line.frustumCulled = false;
  scene.add(line);
  return { line, geo, positions, max, count: 0 };
}
const trails = new Map();
for (const id of [...REMOTE_IDS, DRIVABLE_ID]) {
  trails.set(id, {
    display: makeTrail(0x33d6ff, 0.85, 240),
    authority: makeTrail(0x7d8ea6, 0.35, 240),
  });
}

function pushTrail(trail, x, y, z) {
  const { positions, max } = trail;
  if (trail.count < max) {
    positions.set([x, y, z], trail.count * 3);
    trail.count += 1;
  } else {
    positions.copyWithin(0, 3);
    positions.set([x, y, z], (max - 1) * 3);
  }
  trail.geo.setDrawRange(0, trail.count);
  trail.geo.attributes.position.needsUpdate = true;
}
function clearTrails() {
  for (const pair of trails.values()) {
    for (const t of [pair.display, pair.authority]) {
      t.count = 0;
      t.geo.setDrawRange(0, 0);
    }
  }
}

// ---------- UI ----------
const ui = {
  vehicleList: $("vehicleList"),
  toast: $("toast"),
  banner: $("banner"),
  conn: $("conn"),
};

function setConn(text, kind) {
  ui.conn.textContent = text;
  ui.conn.style.color = kind === "good" ? "var(--good)" : kind === "bad" ? "var(--bad)" : "var(--warn)";
}

let toastTimer = 0;
function toast(text, bad = false) {
  ui.toast.textContent = text;
  ui.toast.classList.toggle("bad", bad);
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2800);
}

function pumpEventToasts() {
  if (!toastQueue.length) return;
  const ev = toastQueue.shift();
  toast(ev.message, ev.level === "error");
}

function buildVehicleList() {
  ui.vehicleList.innerHTML = "";
  for (const v of VEHICLE_SETUP) {
    const row = document.createElement("div");
    row.className = "vrow";
    row.dataset.id = v.id;
    row.innerHTML = `
      <span class="chip" style="background:${v.color}"></span>
      <div>
        <div class="vname">${v.name}${v.drivable ? " · YOU" : ""}</div>
        <div class="vsub">${v.id} · ${v.drivable ? "local control" : "remote"}</div>
      </div>
      <div class="vstat"><span class="val">—</span><br /><span class="tag">—</span></div>`;
    row.addEventListener("click", () => {
      kernel.selectVehicle(v.id);
    });
    ui.vehicleList.appendChild(row);
  }
}

// Network sliders: the kernel validates and applies; failure toasts come back
// through onEvent, so the control surface never pretends a change landed.
const netSliders = [
  ["lat", "latencyMs", "latOut", (v) => `${Math.round(v)} ms`],
  ["jit", "jitterMs", "jitOut", (v) => `${Math.round(v)} ms`],
  ["loss", "lossPct", "lossOut", (v) => `${v.toFixed(0)} %`],
  ["burst", "burstChancePct", "burstOut", (v) => `${v.toFixed(1)} %`],
];
for (const [id, key, outId, fmt] of netSliders) {
  const el = $(id);
  const limits = NET_LIMITS[key];
  el.min = String(limits[0]);
  el.max = String(limits[1]);
  el.value = String(DEFAULT_NET[key]);
  $(outId).textContent = fmt(DEFAULT_NET[key]);
  el.addEventListener("input", () => {
    $(outId).textContent = fmt(Number(el.value));
  });
  el.addEventListener("change", () => {
    const res = kernel.setNet({ [key]: Number(el.value) });
    if (res.ok && res.config) {
      el.value = String(res.config[key]);
      $(outId).textContent = fmt(res.config[key]);
    }
  });
}

$("forceBurst").addEventListener("click", () => kernel.forceBurst(1200));

const delayEl = $("delay");
function applyDelay(v) {
  const res = kernel.setDisplayDelay(v);
  if (!res.ok) {
    toast(res.error ?? "display delay rejected", true);
    delayEl.value = String(kernel.state.displayDelayMs);
    return;
  }
  const ms = res.delayMs;
  delayEl.value = String(ms);
  $("delayOut").textContent = `${ms} ms`;
  clearTrails();
}
delayEl.addEventListener("change", () => applyDelay(Number(delayEl.value)));
$("delayOut").textContent = `${kernel.state.displayDelayMs} ms`;
delayEl.value = String(kernel.state.displayDelayMs);

// Keyboard
const keys = new Set();
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
    e.preventDefault();
  }
  keys.add(k);
  if (e.repeat) return;
  if (k === "c") {
    const id = kernel.cycleSelection();
    clearTrails();
    void id;
  }
  if (k === "t") {
    const st = kernel.tick(0);
    kernel.setTruthOverlay(!st.truthOverlay.enabled);
  }
  if (k === "p") {
    const st = kernel.tick(0);
    kernel.setPausedTrail(!st.pausedTrail);
    toast(st.pausedTrail ? "Trails recording" : "Trails paused");
  }
  if (e.code === "Space") {
    kernel.forceBurst(1200);
  }
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => {
  keys.clear();
  kernel.setInput({ throttle: 0, brake: 0, steer: 0 }, { force: true });
});

let lastInputAt = 0;
function pollInput(now) {
  const throttle = keys.has("w") || keys.has("arrowup") ? 1 : 0;
  const brake = keys.has("s") || keys.has("arrowdown") ? 1 : 0;
  const steer =
    (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
  const idle = throttle === 0 && brake === 0 && steer === 0;
  const cadence = idle ? 400 : 50;
  if (now - lastInputAt < cadence) return;
  if (idle && now - lastInputAt < 1200) return;
  lastInputAt = now;
  kernel.setInput({ throttle, brake, steer }, { force: !idle });
}

// ---------- frame ----------
let lastFrame = performance.now();
let lastTrailPush = 0;
let latest = null;
const camTarget = new THREE.Vector3();
const desiredPos = new THREE.Vector3();

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(120, now - lastFrame);
  lastFrame = now;

  pollInput(now);
  const snap = kernel.tick(dtMs);
  latest = snap;

  const shownById = new Map(snap.vehicles.map((v) => [v.id, v]));
  const truthById = new Map(snap.truth.map((v) => [v.id, v]));

  for (const v of VEHICLE_SETUP) {
    const craft = craftById.get(v.id);
    const shown = shownById.get(v.id);
    if (shown) {
      craft.visible = true;
      craft.position.set(shown.x, shown.y, shown.z);
      craft.rotation.set(0, shown.heading, -(shown.bank ?? 0));
    } else {
      craft.visible = false;
    }
    const ghost = ghostById.get(v.id);
    const truth = truthById.get(v.id);
    ghost.visible = !!truth && snap.truthOverlay.enabled;
    if (truth) {
      ghost.position.set(truth.x, truth.y, truth.z);
      ghost.rotation.set(Math.PI / 2, truth.heading, 0);
    }
  }

  if (now - lastTrailPush > 33 && !snap.pausedTrail) {
    lastTrailPush = now;
    for (const [id, pair] of trails) {
      const shown = shownById.get(id);
      if (shown) pushTrail(pair.display, shown.x, shown.y + 0.06, shown.z);
      const truth = truthById.get(id);
      if (truth && snap.truthOverlay.enabled) pushTrail(pair.authority, truth.x, truth.y + 0.06, truth.z);
    }
  }

  updateCamera(snap, now);
  controls.update();
  renderer.render(scene, camera);

  if (snap.frameSeq % 2 === 0) updateHud(snap);
  pumpEventToasts();
}

let camYaw = 0.9;
function updateCamera(snap, now) {
  const shown = snap.vehicles.find((v) => v.id === snap.selected);
  if (!shown) return;
  const orbit = 26 + (snap.selected === DRIVABLE_ID ? 4 : 0);
  const height = 13;
  const behind = shown.heading + Math.PI * 0.92;
  desiredPos.set(
    shown.x + Math.sin(behind) * orbit,
    shown.y + height + Math.sin(now * 0.0006) * 0.6,
    shown.z + Math.cos(behind) * orbit,
  );
  camTarget.set(shown.x, shown.y + 1.4, shown.z);
  const blend = snap.selected === DRIVABLE_ID ? 0.075 : 0.055;
  camera.position.lerp(desiredPos, blend);
  controls.target.lerp(camTarget, 0.16);
  void camYaw;
}

function updateHud(snap) {
  const mode = snap.clock.priming ? "PRIMING" : snap.mode.toUpperCase();
  setConn(
    snap.connected
      ? `connected · ${snap.clock.priming ? "buffering" : "live"} · ${snap.snapshotHz} Hz`
      : "disconnected · retrying",
    snap.connected ? (snap.phase === "held" ? "bad" : "good") : "bad",
  );

  $("lag").textContent =
    snap.lagMs === null ? "—" : `${snap.lagMs < 0 ? "−" : ""}${Math.abs(snap.lagMs).toFixed(0)} ms`;
  $("buffer").textContent = `${snap.buffer.depth} pkt`;
  const headroom = snap.newestT - (snap.displayT ?? snap.newestT);
  const fillPct = Math.max(0, Math.min(100, (headroom / Math.max(1, snap.clock.delayMs)) * 100));
  const fill = $("bufferFill");
  fill.style.width = `${fillPct.toFixed(0)}%`;
  fill.className = `bufferfill${fillPct < 20 ? " bad" : fillPct < 45 ? " warn" : ""}`;
  $("depthOut").textContent = `${Math.max(0, Math.round(headroom))} / ${snap.clock.delayMs} ms`;
  const modeEl = $("mode");
  modeEl.textContent =
    snap.mode === "extrap" ? `EXTRAP +${Math.round(snap.extrapolation.ageMs)}ms` : mode;
  modeEl.style.color =
    snap.mode === "interp"
      ? "var(--good)"
      : snap.mode === "extrap"
        ? "var(--warn)"
        : snap.mode === "held"
          ? "var(--bad)"
          : "var(--muted)";
  const clock = snap.clock;
  $("rate").textContent = clock.clamped
    ? "0.000× held"
    : `${(clock.rate ?? 1).toFixed(3)}×${clock.starving ? " slow" : clock.catchUp ? " catch-up" : ""}`;

  for (const row of ui.vehicleList.children) {
    const id = row.dataset.id;
    const shown = snap.vehicles.find((v) => v.id === id);
    const val = row.querySelector(".val");
    const tag = row.querySelector(".tag");
    row.classList.toggle("selected", id === snap.selected);
    if (!shown) {
      val.textContent = "—";
      tag.textContent = "waiting";
      tag.className = "tag";
      continue;
    }
    val.textContent = `${shown.speed.toFixed(0)} m/s`;
    tag.textContent =
      snap.phase === "priming"
        ? "buffering"
        : snap.mode === "interp"
          ? "live"
          : snap.mode === "extrap"
            ? "extrap"
            : "held";
    tag.className = `tag ${snap.mode}`;
  }

  const m = snap.metrics;
  $("posErr").textContent = `${m.posErrAvg.toFixed(2)} / ${m.posErrMax.toFixed(2)} m`;
  $("headErr").textContent = `${m.headErrAvgDeg.toFixed(1)} / ${m.headErrMaxDeg.toFixed(1)}°`;
  const discEl = $("disc");
  discEl.textContent = String(m.discontinuities);
  discEl.style.color = m.discontinuities > 0 ? "var(--bad)" : "var(--good)";
  $("resyncs").textContent = String(snap.clock.resyncs);
  $("modes").textContent = `${(m.extrapRatio * 100).toFixed(0)}% / ${(m.heldRatio * 100).toFixed(0)}%`;
  const rx = snap.buffer.stats.received;
  const lost = snap.netStats ? snap.netStats.dropped : snap.buffer.stats.missing;
  $("pkts").textContent = `${rx} / ${lost}`;
  $("ooo").textContent = `${snap.buffer.stats.outOfOrder} / ${snap.buffer.stats.duplicates}`;

  $("inputState").innerHTML =
    `<span>throttle</span><b>${Math.round(snap.input.throttle * 100)}%</b>` +
    `<span>brake</span><b>${Math.round(snap.input.brake * 100)}%</b>` +
    `<span>steer</span><b>${snap.input.steer.toFixed(2)}</b>` +
    `<span>speed (authority)</span><b>${snap.player.speed.toFixed(0)} m/s</b>` +
    `<span>surface</span><b style="color:${snap.player.offTrack ? "var(--bad)" : "var(--good)"}">${
      snap.player.offTrack ? "OFF TRACK" : "on track"
    }</b>` +
    `<span>packets in buffer</span><b>${snap.buffer.depth} (${Math.round(snap.buffer.spanMs)} ms span)</b>` +
    `<span>last packet</span><b>${snap.lastMessageAgeMs === null ? "—" : `${Math.round(snap.lastMessageAgeMs)} ms ago`}</b>` +
    `<span>display time</span><b>${formatClock(snap.displayT ?? 0)}</b>`;

  let bannerText = "";
  let bannerClass = "banner hidden";
  if (!snap.connected) {
    bannerText = "DISCONNECTED — retrying, timeline will reset";
    bannerClass = "banner bad";
  } else if (snap.clock.priming) {
    bannerText = `PRIMING DISPLAY BUFFER — ${Math.round(snap.buffer.spanMs)} / ${snap.clock.delayMs} ms`;
    bannerClass = "banner warn";
  } else if (snap.mode === "held") {
    bannerText = `REMOTE FEED STALLED — frozen at the ${snap.extrapolation.limitMs} ms extrapolation limit, stale by ${Math.round(
      snap.extrapolation.staleMs ?? snap.extrapolation.ageMs,
    )} ms`;
    bannerClass = "banner bad";
  } else if (snap.mode === "extrap") {
    bannerText = `EXTRAPOLATING ${Math.round(snap.extrapolation.ageMs)} / ${
      snap.extrapolation.limitMs
    } ms — then hold`;
    bannerClass = "banner warn";
  } else if (snap.clock.starving) {
    bannerText = `DISPLAY SLOWED TO ${(snap.clock.rate * 100).toFixed(0)}% — buffer nearly dry`;
    bannerClass = "banner warn";
  }
  ui.banner.textContent = bannerText;
  ui.banner.className = bannerClass;
}

buildVehicleList();
requestAnimationFrame(frame);

// Expose for the browser console / e2e harness.
window.__spectator = {
  kernel,
  latest: () => latest,
  events,
};
