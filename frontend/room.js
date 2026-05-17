/**
 * room.js — Perch Web App room logic
 * No chrome.* dependencies — pure browser APIs only.
 */

window.PERCH_AVATAR_COLOR = "#A8D8EA";  // 蓝色，自己换

import { initCamera, renderRemoteFace, stopCamera } from "./camera.js";

// ── Config ────────────────────────────────────────────────────────────────────
// In production, these point to your VPS. During local dev, localhost is fine.

const WS_BASE = location.protocol === "https:"
  ? `wss://${location.host}`
  : `ws://${location.host}`;

// ── Room code from URL (?code=ABC123 or /room/ABC123) ─────────────────────────

const code = new URLSearchParams(location.search).get("code")?.toUpperCase();

if (!code) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace">
      <p>无效的房间号。<a href="/">返回首页</a></p>
    </div>`;
  throw new Error("No valid room code");
}

document.title = `PERCH | ${code}`;

// ── State ─────────────────────────────────────────────────────────────────────

let myUserId  = null;
let ws        = null;
let timerTick = null;
let cameraOn  = false;

const timerStates = {};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const roomCodeBtn     = document.getElementById("room-code-btn");
const connDot         = document.getElementById("conn-dot");
const connLabel       = document.getElementById("conn-label");
const userCountEl     = document.getElementById("user-count");
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
const emptyState      = document.getElementById("empty-state");
const myFaceContainer = document.getElementById("my-face-container");
const myFaceSvg       = document.getElementById("my-face-svg");
const cameraVideo     = document.getElementById("camera-video");
const bannerContainer = document.getElementById("banner-container");

// Two camera buttons (one inside face container, one always-visible row)
const btnCamera  = document.getElementById("btn-camera");
const btnCamera2 = document.getElementById("btn-camera-2");

// ── Init ──────────────────────────────────────────────────────────────────────

roomCodeBtn.textContent = code;
roomCodeBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(code).then(() => {
    roomCodeBtn.textContent = "已复制！";
    setTimeout(() => (roomCodeBtn.textContent = code), 1500);
  });
});

connectWebSocket();

// ── Camera ────────────────────────────────────────────────────────────────────

[btnCamera, btnCamera2].forEach(btn => btn?.addEventListener("click", toggleCamera));

async function toggleCamera() {
  if (cameraOn) {
    cameraOn = false;
    stopCamera();
    myFaceContainer.style.display = "none";
    document.getElementById("camera-toggle-row").style.display = "";
    setCameraButtonState(false);
    send({ type: "face_metrics", metrics: null, state: null });
    return;
  }

  cameraOn = true;
  setCameraButtonState(true, true);

  try {
    await initCamera(cameraVideo, myFaceSvg, {
      onMetrics:     (metrics, state) => send({ type: "face_metrics", metrics, state }),
      onStateChange: (_state) => {},  // local panel never shows state colour
    });
    myFaceContainer.style.display = "";
    document.getElementById("camera-toggle-row").style.display = "none";
    setCameraButtonState(true, false);
  } catch (err) {
    cameraOn = false;
    setCameraButtonState(false);
    showBanner("无法启动摄像头，请检查权限设置。");
    console.error("[room] camera init failed:", err);
  }
}

function setCameraButtonState(on, loading = false) {
  const pairs = [
    [document.getElementById("camera-icon"),   document.getElementById("camera-label")],
    [document.getElementById("camera-icon-2"), document.getElementById("camera-label-2")],
  ];
  for (const [icon, label] of pairs) {
    if (!icon || !label) continue;
    if (loading)    { icon.textContent = "◌"; label.textContent = "启动中…"; }
    else if (on)    { icon.textContent = "◉"; label.textContent = "camera on"; }
    else            { icon.textContent = "◎"; label.textContent = "camera off"; }
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWebSocket() {
  setConnStatus("connecting");
  ws = new WebSocket(`${WS_BASE}/ws/${code}`);

  ws.addEventListener("open",  () => setConnStatus("connected"));
  ws.addEventListener("error", () => setConnStatus("disconnected"));
  ws.addEventListener("close", (e) => {
    setConnStatus("disconnected");
    clearInterval(timerTick);
    if (e.code !== 4004) setTimeout(connectWebSocket, 3000);
    else showBanner("房间不存在或已过期。");
  });
  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  });
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
      updateEmptyState();
      break;

    case "user_left":
      updateUserCount(msg.user_count);
      removeOtherPanel(msg.user_id);
      delete timerStates[msg.user_id];
      updateEmptyState();
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
      if (msg.user_id && msg.user_id !== myUserId)
        handleRemoteFaceMetrics(msg.user_id, msg.metrics, msg.state);
      break;
  }
}

// ── Remote face ───────────────────────────────────────────────────────────────

function handleRemoteFaceMetrics(userId, metrics, state) {
  ensureOtherPanel(userId);
  const panel = document.getElementById(`panel-${userId}`);
  if (!panel) return;

  let wrapper = panel.querySelector(".face-container");
  let svg     = panel.querySelector(".face-svg");

  if (!svg) {
    wrapper = document.createElement("div");
    wrapper.className = "face-container border-b border-outline/20 p-4 flex justify-center";
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    svg.setAttribute("class", "face-svg w-28 h-28");
    svg.setAttribute("aria-hidden", "true");
    wrapper.appendChild(svg);
    panel.querySelector(".panel-header").insertAdjacentElement("afterend", wrapper);
  }

  if (!metrics) {
    wrapper.hidden = true;
    setFrameState(panel, null);
    return;
  }

  wrapper.hidden = false;
  renderRemoteFace(svg, metrics, state ?? "focused");
  setFrameState(panel, state);
}

function setFrameState(panel, state) {
  panel.classList.remove(
    "face-state--focused", "face-state--distracted",
    "face-state--severe",  "face-state--away",
  );
  if (state) panel.classList.add(`face-state--${state}`);
}

// ── Conn status ───────────────────────────────────────────────────────────────

function setConnStatus(s) {
  connDot.className   = `conn-dot ${s}`;
  connLabel.textContent = s === "connected" ? "已连接" : s === "connecting" ? "连接中" : "已断开";
}

function updateUserCount(count) {
  userCountEl.textContent = `${count}/5`;
}

function showBanner(text) {
  const b = document.createElement("div");
  b.className   = "px-[48px] py-3 bg-linen border-b border-secondary/30 font-label-mono text-[11px] text-secondary uppercase";
  b.textContent = text;
  bannerContainer.prepend(b);
}

function updateEmptyState() {
  const hasPanels = othersContainer.querySelector(".other-panel");
  emptyState.style.display = hasPanels ? "none" : "";
}

// ── Timer tick ────────────────────────────────────────────────────────────────

function startLocalTick() {
  clearInterval(timerTick);
  timerTick = setInterval(() => {
    const mine = timerStates[myUserId];
    if (mine) {
      const d = computeDisplayRemaining(mine);
      myTimerDisplay.textContent = formatTime(d);
      if (mine.status === "running" && d <= 0) {
        mine.status = "idle";
        syncTimerButtons("idle");
      }
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
  if (state.status === "running" && state._receivedAt)
    return Math.max(0, state.remaining - (Date.now() - state._receivedAt) / 1000);
  return state.remaining;
}

// ── Timer controls ────────────────────────────────────────────────────────────

btnStart.addEventListener("click", () => send({ type: "timer_action", action: "start" }));
btnPause.addEventListener("click", () => send({ type: "timer_action", action: "pause" }));
btnReset.addEventListener("click", () => send({ type: "timer_action", action: "reset" }));
btnBreak.addEventListener("click", () => send({ type: "timer_action", action: "break" }));

function syncTimerButtons(status) {
  const on  = "border-charcoal text-charcoal opacity-100";
  const off = "border-charcoal/20 text-charcoal/30";
  btnStart.disabled = status === "running" || status === "break";
  btnPause.disabled = status !== "running";
  btnReset.disabled = status === "idle";
  btnBreak.disabled = status === "break";
  [btnStart, btnPause, btnReset, btnBreak].forEach(b => {
    b.className = b.className.replace(/(border-charcoal\/20|text-charcoal\/30|border-charcoal\b|text-charcoal\b)/g, "");
  });
}

function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function handleMyTimerUpdate(t) {
  timerStates[t.user_id] = { ...t, _receivedAt: Date.now() };
  syncTimerButtons(t.status);
  myTimerDisplay.textContent = formatTime(t.remaining);
  myTimerStatus.textContent  = t.status === "idle"    ? "idle"
                             : t.status === "running" ? "专注中"
                             : t.status === "paused"  ? "已暂停"
                             : "休息中";
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
  li.className  = "todo-item" + (item.done ? " done" : "");
  li.dataset.id = item.id;

  if (isMine) {
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = item.done;
    cb.className = "rounded-none border-outline/60 text-charcoal focus:ring-0 cursor-pointer shrink-0";
    cb.addEventListener("change", () =>
      send({ type: "todo_action", action: "toggle", payload: { item_id: item.id } }));

    const span = document.createElement("span");
    span.className = "todo-text flex-grow text-sm"; span.textContent = item.text;
    span.addEventListener("dblclick", () => startEdit(span, item.id));

    const del = document.createElement("button");
    del.className = "font-label-mono text-charcoal/20 hover:text-secondary transition-colors text-base shrink-0";
    del.textContent = "×";
    del.addEventListener("click", () =>
      send({ type: "todo_action", action: "delete", payload: { item_id: item.id } }));

    li.append(cb, span, del);
  } else {
    const dot = document.createElement("span");
    dot.className   = "font-label-mono text-xs shrink-0 " + (item.done ? "text-charcoal/30" : "text-charcoal/20");
    dot.textContent = item.done ? "✓" : "·";
    const span = document.createElement("span");
    span.className = "todo-text flex-grow text-sm"; span.textContent = item.text;
    li.append(dot, span);
  }
  return li;
}

function startEdit(span, itemId) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "flex-grow bg-transparent border-none border-b border-outline p-0 focus:ring-0 text-sm";
  input.value = span.textContent;
  span.replaceWith(input); input.focus();

  function commit() {
    const text = input.value.trim();
    if (text && text !== span.textContent)
      send({ type: "todo_action", action: "edit", payload: { item_id: itemId, text } });
    input.replaceWith(span);
  }
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  commit();
    if (e.key === "Escape") input.replaceWith(span);
  });
}

// ── Other panels ──────────────────────────────────────────────────────────────

function ensureOtherPanel(userId) {
  if (document.getElementById(`panel-${userId}`)) return;
  const section = document.createElement("section");
  section.id        = `panel-${userId}`;
  section.className = "other-panel w-64 shrink-0 border-r border-outline/30 flex flex-col overflow-y-auto";
  section.innerHTML = `
    <div class="panel-header px-6 py-6 border-b border-outline/30">
      <p class="font-label-mono text-[9px] text-charcoal/30 uppercase tracking-[0.3em] mb-3">TA</p>
      <div class="timer-display timer-digits font-headline-lg text-4xl mb-1">25:00</div>
      <div class="timer-status-label font-label-mono text-[10px] text-charcoal/30 uppercase">idle</div>
    </div>
    <div class="px-6 py-4 flex-grow">
      <ul class="todo-list"></ul>
    </div>
  `;
  // Insert before empty state
  othersContainer.insertBefore(section, emptyState);
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
