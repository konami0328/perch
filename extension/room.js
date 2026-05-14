const API_BASE = "http://localhost:8000";
const WS_BASE  = "ws://localhost:8000";

// ── State ─────────────────────────────────────────────────────────────────────

let myUserId  = null;
let ws        = null;
let timerTick = null;
let cameraOn     = false;
let faceWindow    = null;  // popup window running MediaPipe

const timerStates = {};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const roomCodeEl      = document.getElementById("room-code");
const userCountEl     = document.getElementById("user-count");
const connStatusEl    = document.getElementById("conn-status");
const myTimerDisplay  = document.getElementById("my-timer-display");
const myTimerStatus   = document.getElementById("my-timer-status");
const btnStart        = document.getElementById("btn-start");
const btnPause        = document.getElementById("btn-pause");
const btnReset        = document.getElementById("btn-reset");
const btnBreak        = document.getElementById("btn-break");
const todoInput       = document.getElementById("todo-input");
const btnTodoAdd      = document.getElementById("btn-todo-add");
const myTodoList      = document.getElementById("my-todo-list");
const othersContainer = document.getElementById("others-container");
const btnCamera       = document.getElementById("btn-camera");
const myFaceContainer = document.getElementById("my-face-container");
const myFaceCanvas    = document.getElementById("my-face-canvas");


// ── Init ──────────────────────────────────────────────────────────────────────

const code = new URLSearchParams(location.search).get("code")?.toUpperCase();

if (!code) {
  document.body.innerHTML = "<p style='padding:2rem'>No room code provided.</p>";
  throw new Error("No room code in URL");
}

roomCodeEl.textContent = code;
document.title = `Perch — ${code}`;
chrome.storage.local.set({ lastCode: code });

roomCodeEl.addEventListener("click", () => {
  navigator.clipboard.writeText(code).then(() => {
    roomCodeEl.textContent = "copied!";
    setTimeout(() => (roomCodeEl.textContent = code), 1500);
  });
});

connectWebSocket();

// ── postMessage bridge: face iframe → room.js ─────────────────────────────────

window.addEventListener("message", (e) => {
  // Only accept messages from our face iframe (localhost backend)
  if (!e.origin.startsWith("http://localhost")) return;

  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case "perch_face_ready":
      // Acknowledge so face window stops retrying
      sendToFaceWindow({ type: "perch_ack" });
      // Start camera immediately (window only opens when user clicks camera)
      sendToFaceWindow({ type: "perch_camera_start" });
      break;

    case "perch_face_metrics":
      // Render on my own canvas
      if (msg.metrics) {
        renderCartoonFace(myFaceCanvas, msg.metrics);
      }
      // Broadcast to room via WebSocket
      send({ type: "face_metrics", metrics: msg.metrics ?? null });
      break;

    case "perch_camera_error":
      cameraOn = false;
      setCameraButtonState(false);
      myFaceContainer.hidden = true;
      showBanner("Couldn't start camera. Check permissions.");
      break;
  }
});

function sendToFaceWindow(msg) {
  faceWindow?.postMessage(msg, "http://localhost:8000");
}

// ── Camera toggle ─────────────────────────────────────────────────────────────

btnCamera.addEventListener("click", toggleCamera);

function toggleCamera() {
  if (cameraOn) {
    cameraOn = false;
    sendToFaceWindow({ type: "perch_camera_stop" });
    myFaceContainer.hidden = true;
    setCameraButtonState(false);
    send({ type: "face_metrics", metrics: null });
    faceWindow?.close();
    faceWindow = null;
  } else {
    cameraOn = true;
    setCameraButtonState(true);
    myFaceContainer.hidden = false;
    faceWindow = window.open(
      "http://localhost:8000/face",
      "perch_face",
      "width=220,height=260,left=20,top=20"
    );
  }
}

function setCameraButtonState(on) {
  const icon  = btnCamera.querySelector(".camera-icon");
  const label = btnCamera.querySelector(".camera-label");
  if (on) {
    icon.textContent  = "◉";
    label.textContent = "camera on";
    btnCamera.classList.add("btn-camera--on");
  } else {
    icon.textContent  = "◎";
    label.textContent = "camera off";
    btnCamera.classList.remove("btn-camera--on");
  }
}

// ── Cartoon face rendering ────────────────────────────────────────────────────

/**
 * Draw a cartoon face on the given canvas from metrics data.
 * Used both for my own canvas (from iframe) and remote users (from WebSocket).
 */
function renderCartoonFace(canvas, metrics) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  drawFace(ctx, w, h, metrics, 1.0);
}

function renderRemoteFaceForUser(userId, metrics) {
  ensureOtherPanel(userId);
  const panel = document.getElementById(`panel-${userId}`);
  if (!panel) return;

  let container = panel.querySelector(".face-container");
  let canvas    = panel.querySelector(".face-canvas");

  if (!metrics) {
    if (container) container.hidden = true;
    return;
  }

  if (!canvas) {
    container = document.createElement("div");
    container.className = "face-container";
    canvas = document.createElement("canvas");
    canvas.className = "face-canvas face-canvas--remote";
    canvas.width  = 120;
    canvas.height = 120;
    container.appendChild(canvas);
    panel.querySelector(".panel-header").insertAdjacentElement("afterend", container);
  }
  container.hidden = false;
  renderCartoonFace(canvas, metrics);
}

// ── Face drawing primitives ───────────────────────────────────────────────────

function drawFace(ctx, w, h, m, opacity) {
  const cx = w/2, cy = h/2, R = Math.min(w,h)*0.34;
  ctx.save();
  ctx.globalAlpha = opacity;
  const yr = (m.yaw * Math.PI) / 180;
  ctx.translate(cx, cy);
  ctx.transform(1, 0, Math.sin(yr)*0.3, 1, 0, 0);
  ctx.translate(-cx, -cy);

  // face base
  const g = ctx.createRadialGradient(cx, cy-R*0.1, R*0.2, cx, cy, R*1.05);
  g.addColorStop(0,"#f5f0e8"); g.addColorStop(0.7,"#ede6d6"); g.addColorStop(1,"#d9cfc0");
  ctx.beginPath(); ctx.ellipse(cx, cy, R*0.88, R, 0, 0, Math.PI*2);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = "#c4b89a"; ctx.lineWidth = 1.5; ctx.stroke();

  // blush
  _blush(ctx, cx-R*0.52, cy+R*0.08, R*0.18);
  _blush(ctx, cx+R*0.52, cy+R*0.08, R*0.18);

  // eyes + brows
  const eyeY = cy-R*0.15, ex = R*0.32;
  _eye(ctx, cx-ex, eyeY, R*0.14, m.eyeLeft,  m.isSleeping);
  _eye(ctx, cx+ex, eyeY, R*0.14, m.eyeRight, m.isSleeping);
  _brow(ctx, cx-ex, eyeY-R*0.22, R*0.16, m.isSleeping ? -1 : 0);
  _brow(ctx, cx+ex, eyeY-R*0.22, R*0.16, m.isSleeping ? -1 : 0);

  // nose
  ctx.beginPath(); ctx.arc(cx, cy+R*0.06, R*0.035, 0, Math.PI*2);
  ctx.fillStyle = "#c4a882"; ctx.fill();

  // mouth
  _mouth(ctx, cx, cy+R*0.35, R, m.mouthOpen, m.isSleeping);

  // sleeping zzz
  if (m.isSleeping) _zzz(ctx, cx+R*0.6, cy-R*0.5, R);

  ctx.restore();
}

function _blush(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x,y,0,x,y,r);
  g.addColorStop(0,"rgba(220,150,130,0.35)"); g.addColorStop(1,"rgba(220,150,130,0)");
  ctx.beginPath(); ctx.ellipse(x,y,r,r*0.6,0,0,Math.PI*2);
  ctx.fillStyle=g; ctx.fill();
}

function _eye(ctx, x, y, r, open, sleeping) {
  if (sleeping) {
    ctx.beginPath(); ctx.moveTo(x-r,y); ctx.quadraticCurveTo(x,y+r*0.4,x+r,y);
    ctx.strokeStyle="#5a4a3a"; ctx.lineWidth=r*0.25; ctx.lineCap="round"; ctx.stroke(); return;
  }
  const h = r * open;
  if (h < r*0.08) {
    ctx.beginPath(); ctx.moveTo(x-r,y); ctx.lineTo(x+r,y);
    ctx.strokeStyle="#5a4a3a"; ctx.lineWidth=r*0.2; ctx.lineCap="round"; ctx.stroke(); return;
  }
  ctx.beginPath(); ctx.ellipse(x,y,r,h,0,0,Math.PI*2);
  ctx.fillStyle="#fff"; ctx.fill(); ctx.strokeStyle="#c4b89a"; ctx.lineWidth=0.8; ctx.stroke();
  const ir = h*0.75;
  const ig = ctx.createRadialGradient(x-ir*0.25,y-ir*0.25,ir*0.05,x,y,ir);
  ig.addColorStop(0,"#6b8c74"); ig.addColorStop(1,"#3d5a47");
  ctx.beginPath(); ctx.ellipse(x,y,ir*0.8,Math.min(ir,h*0.9),0,0,Math.PI*2);
  ctx.fillStyle=ig; ctx.fill();
  ctx.beginPath(); ctx.ellipse(x,y,ir*0.4,Math.min(ir*0.4,h*0.6),0,0,Math.PI*2);
  ctx.fillStyle="#1a2a20"; ctx.fill();
  ctx.beginPath(); ctx.arc(x-ir*0.28,y-ir*0.28,ir*0.18,0,Math.PI*2);
  ctx.fillStyle="rgba(255,255,255,0.85)"; ctx.fill();
}

function _brow(ctx, x, y, w, droop) {
  ctx.beginPath(); ctx.moveTo(x-w,y+droop*4);
  ctx.quadraticCurveTo(x,y-w*0.25+droop*6,x+w,y+droop*4);
  ctx.strokeStyle="#6b5a48"; ctx.lineWidth=w*0.22; ctx.lineCap="round"; ctx.stroke();
}

function _mouth(ctx, cx, my, R, open, sleeping) {
  if (sleeping) {
    ctx.beginPath(); ctx.moveTo(cx-R*0.12,my); ctx.lineTo(cx+R*0.12,my);
    ctx.strokeStyle="#8b7060"; ctx.lineWidth=2; ctx.lineCap="round"; ctx.stroke(); return;
  }
  const mw = R*0.28;
  if (open < 0.1) {
    ctx.beginPath(); ctx.moveTo(cx-mw,my-R*0.02);
    ctx.quadraticCurveTo(cx,my+R*0.1,cx+mw,my-R*0.02);
    ctx.strokeStyle="#8b7060"; ctx.lineWidth=2.5; ctx.lineCap="round"; ctx.stroke();
  } else {
    const mh = R*0.08 + open*R*0.14;
    ctx.beginPath(); ctx.ellipse(cx,my+mh*0.4,mw,mh,0,0,Math.PI*2);
    ctx.fillStyle="#6b3a3a"; ctx.fill(); ctx.strokeStyle="#8b7060"; ctx.lineWidth=1.5; ctx.stroke();
    ctx.beginPath(); ctx.rect(cx-mw*0.5,my,mw,mh*0.35);
    ctx.fillStyle="rgba(255,252,248,0.9)"; ctx.fill();
  }
}

function _zzz(ctx, x, y, R) {
  const t = Date.now()/1000;
  [R*0.1,R*0.14,R*0.18].forEach((sz,i) => {
    const off = ((t*0.5+i*0.33)%1);
    const a   = off<0.7 ? off/0.7 : 1-(off-0.7)/0.3;
    ctx.save(); ctx.globalAlpha*=a*0.85; ctx.fillStyle="#7a6e62";
    ctx.font=`${sz}px Georgia,serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("z", x+i*sz*0.8, y-off*R*0.5); ctx.restore();
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWebSocket() {
  setConnStatus("connecting");
  ws = new WebSocket(`${WS_BASE}/ws/${code}`);

  ws.addEventListener("open", () => setConnStatus("connected"));

  ws.addEventListener("close", (e) => {
    setConnStatus("disconnected");
    clearInterval(timerTick);
    if (e.code !== 4004) setTimeout(connectWebSocket, 3000);
    else showBanner("Room not found or expired.");
  });

  ws.addEventListener("error", () => setConnStatus("disconnected"));

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {

    case "welcome":
      myUserId = msg.user_id;
      updateUserCount(msg.user_count);
      startLocalTick();
      break;

    case "room_state":
      msg.timers.forEach(t => {
        if (t.user_id === myUserId) handleMyTimerUpdate(t);
        else renderOtherTimer(t);
      });
      msg.todos.forEach(td => {
        if (td.user_id !== myUserId) renderOtherTodos(td);
      });
      break;

    case "user_joined":
      updateUserCount(msg.user_count);
      ensureOtherPanel(msg.user_id);
      break;

    case "user_left":
      updateUserCount(msg.user_count);
      removeOtherPanel(msg.user_id);
      delete timerStates[msg.user_id];
      break;

    case "timer_update":
      if (msg.timer.user_id === myUserId) handleMyTimerUpdate(msg.timer);
      else renderOtherTimer(msg.timer);
      break;

    case "todo_update":
      if (msg.todo.user_id === myUserId) renderMyTodos(msg.todo.items);
      else renderOtherTodos(msg.todo);
      break;

    case "face_metrics":
      if (msg.user_id && msg.user_id !== myUserId) {
        renderRemoteFaceForUser(msg.user_id, msg.metrics);
      }
      break;
  }
}

// ── Connection status ─────────────────────────────────────────────────────────

function setConnStatus(state) {
  connStatusEl.textContent = state;
  connStatusEl.className = `conn-status conn-${state}`;
}

function updateUserCount(count) {
  userCountEl.textContent = `${count}/5`;
}

function showBanner(text) {
  const banner = document.createElement("div");
  banner.className = "room-banner";
  banner.textContent = text;
  document.body.prepend(banner);
}

// ── Timer: local tick ─────────────────────────────────────────────────────────

function startLocalTick() {
  clearInterval(timerTick);
  timerTick = setInterval(() => {
    const mine = timerStates[myUserId];
    if (mine) {
      const d = computeDisplayRemaining(mine);
      myTimerDisplay.textContent = formatTime(d);
      myTimerStatus.textContent  = mine.status;
      if (mine.status === "running" && d <= 0) { mine.status = "idle"; syncMyTimerButtons("idle"); }
    }
    for (const [uid, state] of Object.entries(timerStates)) {
      if (uid === myUserId) continue;
      const panel = document.getElementById(`panel-${uid}`);
      if (!panel) continue;
      const disp = panel.querySelector(".timer-display");
      const lbl  = panel.querySelector(".timer-status-label");
      if (disp) disp.textContent = formatTime(computeDisplayRemaining(state));
      if (lbl)  lbl.textContent  = state.status;
    }
  }, 500);
}

function computeDisplayRemaining(state) {
  if (state.status === "running" && state._receivedAt) {
    return Math.max(0, state.remaining - (Date.now() - state._receivedAt) / 1000);
  }
  return state.remaining;
}

// ── Timer controls ────────────────────────────────────────────────────────────

btnStart.addEventListener("click", () => send({ type: "timer_action", action: "start" }));
btnPause.addEventListener("click", () => send({ type: "timer_action", action: "pause" }));
btnReset.addEventListener("click", () => send({ type: "timer_action", action: "reset" }));
btnBreak.addEventListener("click", () => send({ type: "timer_action", action: "break" }));

function syncMyTimerButtons(status) {
  btnStart.disabled = status === "running" || status === "break";
  btnPause.disabled = status !== "running";
  btnReset.disabled = status === "idle";
  btnBreak.disabled = status === "break";
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function handleMyTimerUpdate(t) {
  timerStates[t.user_id] = { ...t, _receivedAt: Date.now() };
  syncMyTimerButtons(t.status);
  myTimerDisplay.textContent = formatTime(t.remaining);
  myTimerStatus.textContent  = t.status;
}

// ── Todo ──────────────────────────────────────────────────────────────────────

todoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
btnTodoAdd.addEventListener("click", addTodo);

function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;
  send({ type: "todo_action", action: "add", payload: { text } });
  todoInput.value = "";
}

function renderMyTodos(items) {
  myTodoList.innerHTML = "";
  items.forEach(item => myTodoList.appendChild(buildTodoItem(item, true)));
}

function buildTodoItem(item, isMine) {
  const li = document.createElement("li");
  li.className = "todo-item" + (item.done ? " done" : "");
  li.dataset.id = item.id;

  if (isMine) {
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = item.done; cb.className = "todo-check";
    cb.addEventListener("change", () =>
      send({ type: "todo_action", action: "toggle", payload: { item_id: item.id } }));

    const span = document.createElement("span");
    span.className = "todo-text"; span.textContent = item.text;
    span.addEventListener("dblclick", () => startEdit(span, item.id));

    const del = document.createElement("button");
    del.className = "todo-delete"; del.textContent = "×";
    del.setAttribute("aria-label", "Delete task");
    del.addEventListener("click", () =>
      send({ type: "todo_action", action: "delete", payload: { item_id: item.id } }));

    li.append(cb, span, del);
  } else {
    const dot = document.createElement("span");
    dot.className = "todo-dot" + (item.done ? " done" : "");
    dot.textContent = item.done ? "✓" : "·";
    const span = document.createElement("span");
    span.className = "todo-text"; span.textContent = item.text;
    li.append(dot, span);
  }
  return li;
}

function startEdit(span, itemId) {
  const input = document.createElement("input");
  input.type = "text"; input.className = "todo-edit-input"; input.value = span.textContent;
  span.replaceWith(input); input.focus();

  function commit() {
    const text = input.value.trim();
    if (text && text !== span.textContent)
      send({ type: "todo_action", action: "edit", payload: { item_id: itemId, text } });
    input.replaceWith(span);
  }
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") input.replaceWith(span);
  });
}

// ── Other user panels ─────────────────────────────────────────────────────────

function ensureOtherPanel(userId) {
  if (document.getElementById(`panel-${userId}`)) return;
  const section = document.createElement("section");
  section.id = `panel-${userId}`;
  section.className = "user-panel other-panel";
  section.innerHTML = `
    <div class="panel-header"><span class="panel-label">${userId.slice(0,4)}</span></div>
    <div class="timer-block">
      <div class="timer-display">25:00</div>
      <div class="timer-status-label">idle</div>
    </div>
    <ul class="todo-list" aria-label="Their tasks"></ul>
  `;
  othersContainer.appendChild(section);
}

function removeOtherPanel(userId) {
  document.getElementById(`panel-${userId}`)?.remove();
}

function renderOtherTimer(timerState) {
  timerStates[timerState.user_id] = { ...timerState, _receivedAt: Date.now() };
  ensureOtherPanel(timerState.user_id);
  const panel = document.getElementById(`panel-${timerState.user_id}`);
  if (!panel) return;
  const d = panel.querySelector(".timer-display");
  const l = panel.querySelector(".timer-status-label");
  if (d) d.textContent = formatTime(timerState.remaining);
  if (l) l.textContent = timerState.status;
}

function renderOtherTodos(todoState) {
  ensureOtherPanel(todoState.user_id);
  const panel = document.getElementById(`panel-${todoState.user_id}`);
  if (!panel) return;
  const list = panel.querySelector(".todo-list");
  if (!list) return;
  list.innerHTML = "";
  todoState.items.forEach(item => list.appendChild(buildTodoItem(item, false)));
}