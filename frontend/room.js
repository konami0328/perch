/**
 * room.js — Perch Web App room logic (v2)
 *
 * Layout: dynamic grid (1–4 users including self), self fixed top-left.
 * Features: session duration, break mode, todo undo, end-session banner,
 *           leave confirm, bird placeholder, remote face metrics.
 */

import { initCamera, renderRemoteFace, stopCamera } from "./camera.js";

// ── Config ────────────────────────────────────────────────────────────────────

const WS_BASE = location.protocol === "https:"
  ? `wss://${location.host}`
  : `ws://${location.host}`;

// ── Room code ─────────────────────────────────────────────────────────────────

const code = new URLSearchParams(location.search).get("code")?.toUpperCase();

if (!code) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:13px;">
      无效的房间号。<a href="/" style="margin-left:8px;">返回首页</a>
    </div>`;
  throw new Error("No valid room code");
}
document.title = `PERCH | ${code}`;

// ── State ─────────────────────────────────────────────────────────────────────

let myUserId       = null;
let ws             = null;
let timerTick      = null;
let cameraOn       = false;
let iAmBreaking    = false;
let sessionStarted = false;
let endBannerShown = false;

const timerStates = {};
const breakStates = {};
const otherUsers  = [];   // ordered by join time

// undo for last toggle
let lastToggle = null;
let undoTimer  = null;

// messages buffered before welcome arrives
const pendingMsgs = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const roomMain      = document.getElementById("room-main");
const roomCodeBtn   = document.getElementById("room-code-btn");
const connDot       = document.getElementById("conn-dot");
const connLabel     = document.getElementById("conn-label");
const userCountEl   = document.getElementById("user-count");
const myToolbar     = document.getElementById("my-toolbar");
const sessionDurEl  = document.getElementById("session-duration");
const btnStart      = document.getElementById("btn-start");
const btnPause      = document.getElementById("btn-pause");
const btnReset      = document.getElementById("btn-reset");
const btnBreak      = document.getElementById("btn-break");
const btnLeave      = document.getElementById("btn-leave");
const todoInput     = document.getElementById("todo-input");
const btnTodoAdd    = document.getElementById("btn-todo-add");
const undoBadge     = document.getElementById("undo-badge");
const endBanner     = document.getElementById("end-banner");
const endBannerMsg  = document.getElementById("end-banner-msg");
const endBtnBreak   = document.getElementById("end-btn-break");
const endBtnLeave   = document.getElementById("end-btn-leave");
const leaveConfirm  = document.getElementById("leave-confirm");
const leaveCancel   = document.getElementById("leave-cancel");
const leaveOk       = document.getElementById("leave-ok");
const errStrip      = document.getElementById("err-strip");
const btnCameraNav  = document.getElementById("btn-camera-nav");
const camIconNav    = document.getElementById("cam-icon-nav");
const camLabelNav   = document.getElementById("cam-label-nav");
const cameraVideo   = document.getElementById("camera-video");

// ── Init ──────────────────────────────────────────────────────────────────────

roomCodeBtn.textContent = code;
roomCodeBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(code).then(() => {
    roomCodeBtn.textContent = "已复制！";
    setTimeout(() => (roomCodeBtn.textContent = code), 1500);
  });
});

connectWebSocket();
bindToolbarEvents();

// ── Grid layout ───────────────────────────────────────────────────────────────

/**
 * Rebuild grid order by physically moving DOM nodes.
 * Never uses innerHTML="" — that destroys nodes and breaks references.
 * Guard: does nothing until cell-me exists.
 */
function rebuildLayout() {
  const myCell = document.getElementById("cell-me");
  if (!myCell) return;   // not ready yet

  const n = 1 + otherUsers.length;

  // CSS grid dimensions
  if (n <= 2) {
    roomMain.style.gridTemplateColumns = "1fr 1fr";
    roomMain.style.gridTemplateRows    = "1fr";
  } else {
    roomMain.style.gridTemplateColumns = "1fr 1fr";
    roomMain.style.gridTemplateRows    = "1fr 1fr";
  }

  // Self: span left column when 3 people
  if (n === 3) {
    myCell.style.gridRow    = "1 / 3";
    myCell.style.gridColumn = "1";
  } else {
    myCell.style.gridRow    = "";
    myCell.style.gridColumn = "";
  }

  // Re-order by appending (moves without destroying)
  roomMain.appendChild(myCell);

  otherUsers.forEach(uid => {
    const el = document.getElementById(`cell-${uid}`);
    if (el) {
      el.style.gridRow    = "";
      el.style.gridColumn = "";
      roomMain.appendChild(el);
    }
  });

  // Bird slot: present only when alone
  let bird = document.getElementById("cell-bird");
  if (n === 1) {
    if (!bird) bird = makeBirdSlot();
    roomMain.appendChild(bird);
  } else if (bird) {
    bird.remove();
  }
}

function makeBirdSlot() {
  const div = document.createElement("div");
  div.id        = "cell-bird";
  div.className = "cell-wrap";
  div.style.borderRight = "none";
  div.innerHTML = `
    <div class="cell-face">
      <div class="bird-cell">
        <span class="bird-icon">🐦</span>
        <span class="bird-label">等待加入</span>
      </div>
    </div>`;
  return div;
}

// ── My cell ───────────────────────────────────────────────────────────────────

function buildMyCell() {
  if (document.getElementById("cell-me")) return;
  const wrap = document.createElement("div");
  wrap.id        = "cell-me";
  wrap.className = "cell-wrap";
  wrap.innerHTML = `
    <div class="cell-face" id="my-cell-face">
      <svg id="my-face-svg" class="face-svg" viewBox="0 0 200 200"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
      <div class="cell-timer" id="my-cell-timer">25:00</div>
      <span class="you-label">you</span>
    </div>
    <div class="cell-todos" id="my-cell-todos"></div>
    <div class="break-overlay" id="my-break-overlay">
      <span class="break-overlay-icon">☕</span>
      <span class="break-overlay-text">休息中</span>
    </div>`;
  roomMain.appendChild(wrap);
}

// ── Other cells ───────────────────────────────────────────────────────────────

function ensureOtherCell(userId) {
  if (userId === myUserId) return;                         // never create for self
  if (!myUserId) return;                                   // not ready yet
  if (document.getElementById(`cell-${userId}`)) return;  // already exists

  const wrap = document.createElement("div");
  wrap.id        = `cell-${userId}`;
  wrap.className = "cell-wrap other-cell";
  wrap.innerHTML = `
    <div class="cell-face">
      <svg class="face-svg" viewBox="0 0 200 200"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
      <div class="cell-timer">—:——</div>
    </div>
    <div class="cell-todos"></div>
    <div class="break-overlay">
      <span class="break-overlay-icon">☕</span>
      <span class="break-overlay-text">休息中</span>
    </div>`;

  if (!otherUsers.includes(userId)) otherUsers.push(userId);
  roomMain.appendChild(wrap);  // append first, then rebuild order
  rebuildLayout();
}

function removeOtherCell(userId) {
  const el = document.getElementById(`cell-${userId}`);
  if (el) {
    el.style.transition = "opacity 0.4s ease, transform 0.4s ease";
    el.style.opacity    = "0";
    el.style.transform  = "scale(0.95)";
    setTimeout(() => { el.remove(); rebuildLayout(); }, 420);
  }
  const idx = otherUsers.indexOf(userId);
  if (idx !== -1) otherUsers.splice(idx, 1);
  delete timerStates[userId];
  delete breakStates[userId];
}

// ── Break overlay helpers ─────────────────────────────────────────────────────

function setMyBreakOverlay(on) {
  document.getElementById("my-break-overlay")?.classList.toggle("on", on);
}

function setOtherBreakOverlay(userId, on) {
  document.getElementById(`cell-${userId}`)
    ?.querySelector(".break-overlay")
    ?.classList.toggle("on", on);
}

// ── Camera ────────────────────────────────────────────────────────────────────

btnCameraNav.addEventListener("click", toggleCamera);

async function toggleCamera() {
  if (cameraOn) {
    cameraOn = false;
    stopCamera();
    setCamUI(false);
    send({ type: "face_metrics", metrics: null, state: null });
    return;
  }
  cameraOn = true;
  setCamUI(null);
  try {
    await initCamera(cameraVideo, document.getElementById("my-face-svg"), {
      onMetrics:     (m, s) => send({ type: "face_metrics", metrics: m, state: s }),
      onStateChange: () => {},
    });
    setCamUI(true);
  } catch (err) {
    cameraOn = false;
    setCamUI(false);
    showErr("无法启动摄像头，请检查权限设置。");
    console.error("[room] camera init failed:", err);
  }
}

function setCamUI(on) {
  if (on === null) { camIconNav.textContent = "◌"; camLabelNav.textContent = "启动中"; }
  else if (on)     { camIconNav.textContent = "◉"; camLabelNav.textContent = "camera on"; }
  else             { camIconNav.textContent = "◎"; camLabelNav.textContent = "camera"; }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWebSocket() {
  setConn("connecting");
  ws = new WebSocket(`${WS_BASE}/ws/${code}`);
  ws.addEventListener("open",  () => setConn("connected"));
  ws.addEventListener("error", () => setConn("disconnected"));
  ws.addEventListener("close", (e) => {
    setConn("disconnected");
    clearInterval(timerTick);
    if (e.code === 4004) showErr("房间不存在或已过期。");
    else setTimeout(connectWebSocket, 3000);
  });
  ws.addEventListener("message", (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error(err); }
  });
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMsg(msg) {
  // Buffer messages that arrive before welcome
  if (!myUserId && msg.type !== "welcome") {
    pendingMsgs.push(msg);
    return;
  }

  switch (msg.type) {

    case "welcome":
      myUserId = msg.user_id;
      updateCount(msg.user_count);
      buildMyCell();
      myToolbar.classList.add("show");
      rebuildLayout();
      startLocalTick();
      // Drain buffered messages now that we know who we are
      while (pendingMsgs.length) handleMsg(pendingMsgs.shift());
      break;

    case "room_state":
      msg.timers.forEach(t => {
        if (t.user_id === myUserId) applyMyTimer(t);
        else { ensureOtherCell(t.user_id); applyOtherTimer(t); }
      });
      msg.todos.forEach(td => {
        if (td.user_id === myUserId) renderMyTodos(td.items);
        else { ensureOtherCell(td.user_id); renderOtherTodos(td); }
      });
      break;

    case "user_joined":
      updateCount(msg.user_count);
      ensureOtherCell(msg.user_id);
      break;

    case "user_left":
      updateCount(msg.user_count);
      removeOtherCell(msg.user_id);
      break;

    case "user_break":
      breakStates[msg.user_id] = msg.is_break;
      setOtherBreakOverlay(msg.user_id, msg.is_break);
      break;

    case "timer_update":
      if (msg.timer.user_id === myUserId) applyMyTimer(msg.timer);
      else { ensureOtherCell(msg.timer.user_id); applyOtherTimer(msg.timer); }
      break;

    case "todo_update":
      if (msg.todo.user_id === myUserId) renderMyTodos(msg.todo.items);
      else { ensureOtherCell(msg.todo.user_id); renderOtherTodos(msg.todo); }
      break;

    case "face_metrics":
      if (msg.user_id && msg.user_id !== myUserId)
        applyRemoteFace(msg.user_id, msg.metrics, msg.state);
      break;
  }
}

// ── Remote face ───────────────────────────────────────────────────────────────

function applyRemoteFace(userId, metrics, state) {
  ensureOtherCell(userId);
  const cell = document.getElementById(`cell-${userId}`);
  if (!cell) return;
  const svg = cell.querySelector(".face-svg");
  if (!svg) return;
  if (!metrics) { svg.style.opacity = "0.15"; setFaceState(cell, null); return; }
  svg.style.opacity = "";
  renderRemoteFace(svg, metrics, state ?? "focused");
  setFaceState(cell, state);
}

function setFaceState(cell, state) {
  cell.classList.remove(
    "face-state--focused","face-state--distracted",
    "face-state--severe", "face-state--away");
  if (state) cell.classList.add(`face-state--${state}`);
}

// ── Timer tick ────────────────────────────────────────────────────────────────

function startLocalTick() {
  clearInterval(timerTick);
  timerTick = setInterval(() => {
    const mine = timerStates[myUserId];
    if (mine) {
      const rem = displayRemaining(mine);
      const el  = document.getElementById("my-cell-timer");
      if (el) el.textContent = fmtTime(rem);
      if (mine.status === "running" && rem <= 0 && !endBannerShown)
        showEndBanner("session 结束");
    }
    otherUsers.forEach(uid => {
      const st   = timerStates[uid];
      const cell = document.getElementById(`cell-${uid}`);
      const el   = cell?.querySelector(".cell-timer");
      if (el && st) el.textContent = fmtTime(displayRemaining(st));
    });
  }, 500);
}

function displayRemaining(state) {
  if (state.status === "running" && state._at)
    return Math.max(0, state.remaining - (Date.now() - state._at) / 1000);
  return state.remaining ?? 0;
}

// ── Timer apply ───────────────────────────────────────────────────────────────

function applyMyTimer(t) {
  timerStates[t.user_id] = { ...t, _at: Date.now() };
  syncTimerBtns(t.status);
  const el = document.getElementById("my-cell-timer");
  if (el) el.textContent = fmtTime(t.remaining);
  if (t.status !== "idle") { sessionDurEl.disabled = true; sessionStarted = true; }
}

function applyOtherTimer(t) {
  timerStates[t.user_id] = { ...t, _at: Date.now() };
  const cell = document.getElementById(`cell-${t.user_id}`);
  const el   = cell?.querySelector(".cell-timer");
  if (el) el.textContent = fmtTime(t.remaining);
}

function syncTimerBtns(status) {
  btnStart.disabled = status === "running" || status === "break";
  btnPause.disabled = status !== "running";
  btnReset.disabled = status === "idle";
  btnBreak.disabled = status === "break";
  btnStart.classList.toggle("active", status === "idle" || status === "paused");
}

// ── Timer controls ────────────────────────────────────────────────────────────

btnStart.addEventListener("click", () => {
  if (!sessionStarted) {
    const dur = clampDuration(parseInt(sessionDurEl.value, 10));
    sessionDurEl.value = dur;
    send({ type: "timer_action", action: "set_duration", duration: dur * 60 });
  }
  send({ type: "timer_action", action: "start" });
});
btnPause.addEventListener("click", () => send({ type: "timer_action", action: "pause" }));
btnReset.addEventListener("click", () => {
  sessionStarted = false;
  sessionDurEl.disabled = false;
  send({ type: "timer_action", action: "reset" });
  hideEndBanner();
});
btnBreak.addEventListener("click",  enterBreak);
btnLeave.addEventListener("click",  showLeaveConfirm);
leaveCancel.addEventListener("click", hideLeaveConfirm);
leaveOk.addEventListener("click",   doLeave);
endBtnBreak.addEventListener("click", () => { hideEndBanner(); enterBreak(); });
endBtnLeave.addEventListener("click", () => { hideEndBanner(); showLeaveConfirm(); });

function enterBreak() {
  if (iAmBreaking) return;
  iAmBreaking = true;
  roomMain.classList.add("i-am-breaking");
  setMyBreakOverlay(true);
  syncTimerBtns("break");
  send({ type: "user_break",   is_break: true });
  send({ type: "timer_action", action: "break" });

  if (!document.getElementById("btn-end-break")) {
    const btn = document.createElement("button");
    btn.id          = "btn-end-break";
    btn.className   = "tb-btn active";
    btn.textContent = "结束休息";
    btn.addEventListener("click", exitBreak);
    btnBreak.insertAdjacentElement("afterend", btn);
  }
}

function exitBreak() {
  iAmBreaking = false;
  roomMain.classList.remove("i-am-breaking");
  setMyBreakOverlay(false);
  syncTimerBtns(timerStates[myUserId]?.status ?? "idle");
  send({ type: "user_break", is_break: false });
  document.getElementById("btn-end-break")?.remove();
}

function doLeave() {
  if (cameraOn) stopCamera();
  ws?.close();
  location.href = "/";
}

function showLeaveConfirm() { leaveConfirm.classList.add("on"); }
function hideLeaveConfirm() { leaveConfirm.classList.remove("on"); }

// ── End-session banner ────────────────────────────────────────────────────────

function showEndBanner(msg) {
  if (endBannerShown) return;
  endBannerShown = true;
  endBannerMsg.textContent = msg;
  endBanner.classList.add("up");
}
function hideEndBanner() {
  endBannerShown = false;
  endBanner.classList.remove("up");
}

// ── Todo: my cell ─────────────────────────────────────────────────────────────

function renderMyTodos(items) {
  const container = document.getElementById("my-cell-todos");
  if (!container) return;
  container.innerHTML = "";
  items.forEach(item => container.appendChild(buildMyTodoRow(item)));
  if (items.length > 0 && items.every(i => i.done) && !endBannerShown)
    showEndBanner("所有待办已完成 🎉");
}

function buildMyTodoRow(item) {
  const row = document.createElement("div");
  row.className  = "todo-row" + (item.done ? " done" : "");
  row.dataset.id = item.id;

  const cb = document.createElement("input");
  cb.type      = "checkbox";
  cb.className = "todo-cb";
  cb.checked   = item.done;
  cb.addEventListener("click", (e) => {
    e.stopPropagation();
    recordToggle(item.id, item.done);
    send({ type: "todo_action", action: "toggle", payload: { item_id: item.id } });
  });

  const span = document.createElement("span");
  span.className   = "todo-text";
  span.textContent = item.text;
  span.addEventListener("click", () => startInlineEdit(span, item.id));

  const del = document.createElement("button");
  del.className   = "todo-del";
  del.textContent = "×";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "todo_action", action: "delete", payload: { item_id: item.id } });
  });

  row.append(cb, span, del);
  return row;
}

function startInlineEdit(span, itemId) {
  if (span.dataset.editing) return;
  span.dataset.editing = "1";
  const input = document.createElement("input");
  input.type      = "text";
  input.className = "todo-edit-input";
  input.value     = span.textContent;
  span.replaceWith(input);
  input.focus();
  const commit = () => {
    const text = input.value.trim();
    if (text && text !== span.textContent)
      send({ type: "todo_action", action: "edit", payload: { item_id: itemId, text } });
    delete span.dataset.editing;
    input.replaceWith(span);
  };
  input.addEventListener("blur",    commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  input.blur();
    if (e.key === "Escape") { delete span.dataset.editing; input.replaceWith(span); }
  });
}

// ── Undo toggle ───────────────────────────────────────────────────────────────

function recordToggle(itemId, prevDone) {
  clearTimeout(undoTimer);
  lastToggle = { item_id: itemId, prev_done: prevDone };
  undoBadge.classList.add("visible");
  undoTimer = setTimeout(clearUndo, 3000);
}
function clearUndo() {
  lastToggle = null;
  undoBadge.classList.remove("visible");
  clearTimeout(undoTimer);
}
undoBadge.addEventListener("click", () => {
  if (!lastToggle) return;
  send({ type: "todo_action", action: "toggle", payload: { item_id: lastToggle.item_id } });
  clearUndo();
});

// ── Todo: other cells ─────────────────────────────────────────────────────────

function renderOtherTodos(todoState) {
  const cell = document.getElementById(`cell-${todoState.user_id}`);
  if (!cell) return;
  const container = cell.querySelector(".cell-todos");
  if (!container) return;
  container.innerHTML = "";
  todoState.items.slice(0, 3).forEach(item => {
    const row  = document.createElement("div");
    row.className = "todo-row" + (item.done ? " done" : "");
    const dot  = document.createElement("span");
    dot.style.cssText = "flex-shrink:0;font-size:8px;color:rgba(44,51,45,0.25);";
    dot.textContent   = item.done ? "✓" : "·";
    const span = document.createElement("span");
    span.className   = "todo-text";
    span.textContent = item.text;
    row.append(dot, span);
    container.appendChild(row);
  });
}

// ── Toolbar events ────────────────────────────────────────────────────────────

function bindToolbarEvents() {
  todoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  btnTodoAdd.addEventListener("click", addTodo);
  sessionDurEl.addEventListener("change", () => {
    sessionDurEl.value = clampDuration(parseInt(sessionDurEl.value, 10));
  });
}

function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;
  send({ type: "todo_action", action: "add", payload: { text } });
  todoInput.value = "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(s) {
  if (isNaN(s) || s < 0) return "—:——";
  const m   = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
function clampDuration(v) { return isNaN(v) ? 25 : Math.max(25, Math.min(90, v)); }
function setConn(s) {
  connDot.className     = `conn-dot ${s}`;
  connLabel.textContent = s === "connected" ? "已连接" : s === "connecting" ? "连接中" : "已断开";
}
function updateCount(n) { userCountEl.textContent = `${n} / 4`; }
function showErr(msg)   { errStrip.textContent = msg; errStrip.classList.add("on"); }