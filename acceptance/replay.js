// Self-contained HTML track replay. Everything (data, styles, canvas drawing,
// playback controls) is inlined so the file opens from disk with no server and
// no external dependency. The rendered marker draws both screen position and
// the heading tangent explicitly, which is what separates a position fault
// from a heading-only fault.

function json(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderReplayHtml({ title, trace, frames, verdict, trajectory, frameHz = 60, note = "" }) {
  const line = trajectory.polyline(1).map((p) => [p.x, p.z]);
  const packetBySeq = new Map(trace.packets.map((p) => [p.seq, p]));
  const keptRender = new Set(frames.filter((f) => f.pose).map((f) => Math.round(f.renderMs * 1000) / 1000));
  const rows = (verdict?.rows ?? [])
    .filter((r) => keptRender.has(Math.round(r.renderMs * 1000) / 1000))
    .map((r) => {
      const truth = trajectory.poseAt(r.sourceMs / 1000);
      return { ...r, truthX: truth.x, truthZ: truth.z, truthHeading: truth.heading };
    });
  const failures = (verdict?.failures ?? []).filter((fl) => keptRender.has(Math.round(fl.renderMs * 1000) / 1000));
  const deliveries = trace.deliveries.map((d) => {
    const pkt = packetBySeq.get(d.seq);
    return {
      seq: d.seq,
      t: d.t,
      arriveAtMs: d.arriveAtMs,
      duplicate: !!d.duplicate,
      x: pkt ? pkt.x : null,
      z: pkt ? pkt.z : null,
    };
  });
  const payload = {
    title,
    note,
    frameHz,
    line,
    frames: frames
      .filter((f) => f.pose)
      .map((f) => ({
        renderMs: +f.renderMs.toFixed(2),
        sourceMs: +(f.sourceMs ?? 0).toFixed(2),
        mode: f.mode,
        x: +f.pose.x.toFixed(3),
        z: +f.pose.z.toFixed(3),
        heading: +f.pose.heading.toFixed(4),
        regressionMs: +(f.regressionMs ?? 0).toFixed(2),
      })),
    rows,
    failures,
    deliveries,
    blackout: trace.blackout ?? null,
    accepted: verdict?.accepted ?? null,
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; font:13px/1.5 system-ui, sans-serif; background:#0e1116; color:#d7dde5; }
  header { padding:10px 16px; border-bottom:1px solid #232a33; display:flex; gap:14px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; }
  .badge { padding:2px 8px; border-radius:10px; font-weight:600; }
  .pass { background:#14361f; color:#7ee29a; }
  .fail { background:#3d1719; color:#ff9a92; }
  main { display:flex; gap:14px; padding:14px; flex-wrap:wrap; }
  canvas { background:#12171e; border:1px solid #232a33; border-radius:8px; }
  aside { width:340px; display:flex; flex-direction:column; gap:10px; }
  .panel { background:#161c24; border:1px solid #232a33; border-radius:8px; padding:10px 12px; }
  .panel h2 { font-size:12px; margin:0 0 6px; color:#9fb0c0; text-transform:uppercase; letter-spacing:.06em; }
  table { border-collapse:collapse; width:100%; }
  td, th { text-align:left; padding:2px 6px; font-variant-numeric:tabular-nums; }
  th { color:#8ea0b2; font-weight:600; }
  .controls { display:flex; gap:8px; align-items:center; }
  input[type=range] { flex:1; }
  button { background:#223042; color:#d7dde5; border:1px solid #33445a; border-radius:6px; padding:4px 10px; cursor:pointer; }
  .legend span { display:inline-block; margin-right:10px; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; vertical-align:middle; }
  #log { max-height:260px; overflow:auto; font-family:ui-monospace,monospace; font-size:12px; }
  .failrow { color:#ff9a92; }
  small { color:#8ea0b2; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="badge ${payload.accepted === false ? "fail" : "pass"}">${payload.accepted === false ? "验收失败" : "验收通过"}</span>
  <small>${escapeHtml(note)}</small>
</header>
<main>
  <div>
    <canvas id="track" width="760" height="640"></canvas>
    <div class="panel controls">
      <button id="play">暂停</button>
      <input id="scrub" type="range" min="0" max="${Math.max(0, payload.frames.length - 1)}" value="0">
      <span id="clock"></span>
    </div>
    <div class="panel legend">
      <span><i class="swatch" style="background:#5b6b7d"></i>解析轨迹</span>
      <span><i class="swatch" style="background:#7ee29a"></i>真值位置</span>
      <span><i class="swatch" style="background:#ffd447"></i>渲染位置</span>
      <span><i class="swatch" style="background:#ff6b5e"></i>车头切线</span>
      <span><i class="swatch" style="background:#33d6ff"></i>已到达包</span>
      <span><i class="swatch" style="background:#ff3b5c"></i>重复包/故障点</span>
    </div>
  </div>
  <aside>
    <div class="panel"><h2>当前帧</h2><table id="stats"></table></div>
    <div class="panel"><h2>失败记录</h2><div id="log"></div></div>
  </aside>
</main>
<script>
const DATA = ${json(payload)};
const cv = document.getElementById("track");
const ctx = cv.getContext("2d");
const xs = DATA.line.map(p => p[0]), zs = DATA.line.map(p => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
const pad = 46;
const scale = Math.min((cv.width - 2 * pad) / (maxX - minX || 1), (cv.height - 2 * pad) / (maxZ - minZ || 1));
const toPx = (x, z) => [pad + (x - minX) * scale, pad + (z - minZ) * scale];
let idx = 0, playing = true;
function car(x, z, heading, color, tangent) {
  const [px, py] = toPx(x, z);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
  if (tangent) {
    ctx.strokeStyle = "#ff6b5e"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.lineTo(px + Math.sin(heading) * 22, py + Math.cos(heading) * 22);
    ctx.stroke();
  }
}
function rowFor(frame) {
  return DATA.rows.find(r => Math.abs(r.renderMs - frame.renderMs) < (1000 / DATA.frameHz) + 1);
}
function draw(i) {
  idx = Math.max(0, Math.min(DATA.frames.length - 1, i));
  const f = DATA.frames[idx];
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = "#5b6b7d"; ctx.lineWidth = 2;
  ctx.beginPath();
  DATA.line.forEach((p, k) => { const [x, y] = toPx(p[0], p[1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  DATA.deliveries.forEach(d => {
    if (d.arriveAtMs <= f.renderMs && d.x !== null) {
      const [px, py] = toPx(d.x, d.z);
      ctx.fillStyle = d.duplicate ? "#ff3b5c" : "#33d6ff";
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(px, py, d.duplicate ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  });
  const row = rowFor(f);
  if (row) car(row.truthX, row.truthZ, row.truthHeading, "#7ee29a", false);
  const isFail = DATA.failures.some(fl => Math.abs(fl.renderMs - f.renderMs) < (1000 / DATA.frameHz) + 1);
  car(f.x, f.z, f.heading, isFail ? "#ff3b5c" : "#ffd447", true);
  document.getElementById("scrub").value = idx;
  document.getElementById("clock").textContent =
    "render " + f.renderMs.toFixed(0) + " ms · source " + f.sourceMs.toFixed(0) + " ms · " + f.mode;
  const statRows = [
    ["位置误差", row ? row.posErrM.toFixed(2) + " m" : "-"],
    ["车头误差", row ? (row.headErrRad * 180 / Math.PI).toFixed(1) + "°" : "-"],
    ["越界外推", row ? Math.max(0, row.beyondMs).toFixed(0) + " ms" : "-"],
    ["倒退", row ? row.regressionMs.toFixed(1) + " ms" : "-"],
    ["时钟漂移", row ? row.driftMs.toFixed(1) + " ms" : "-"],
    ["分类", row ? row.band : "-"],
  ];
  document.getElementById("stats").innerHTML = "<tr><th>指标</th><th>值</th></tr>" +
    statRows.map(r => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("");
}
function tick() {
  if (!playing) return;
  if (idx >= DATA.frames.length - 1) { playing = false; document.getElementById("play").textContent = "播放"; return; }
  draw(idx + 1);
}
document.getElementById("play").onclick = () => {
  playing = !playing;
  document.getElementById("play").textContent = playing ? "暂停" : "播放";
  if (playing && idx >= DATA.frames.length - 1) draw(0);
};
document.getElementById("scrub").oninput = (e) => { playing = false; document.getElementById("play").textContent = "播放"; draw(+e.target.value); };
document.getElementById("log").innerHTML = DATA.failures.length
  ? DATA.failures.map(fl => "<div class=\\"failrow\\">@" + fl.renderMs.toFixed(0) + "ms [" + fl.check + "] " + fl.message + "</div>").join("")
  : "<small>无失败项</small>";
setInterval(tick, 1000 / DATA.frameHz);
if (DATA.frames.length) draw(0);
</script>
</body>
</html>`;
}
