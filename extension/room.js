const API_BASE = "http://localhost:8000";
const WS_BASE  = "ws://localhost:8000";

// ── State ─────────────────────────────────────────────────────────────────────

let myUserId = null;
let ws        = null;
let timerTick = null; // setInterval handle for local countdown display

// Per-user timer state cache (from server)
// user_id -> { status, remaining, duration }
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

// ── Init ──────────────────────────────────────────────────────────────────────

const code = new URLSearchParams(location.search).get("code")?.toUpperCase();

if (!code) {
  document.body.innerHTML = "<p style='padding:2rem'>No room code provided.</p>";
  throw new Error("No room code in URL");
}

// Show the room code and set page title
roomCodeEl.textContent = code;
document.title = `Perch — ${code}`;

// Save to storage so popup can restore it
chrome.storage.local.set({ lastCode: code });

// Click to copy room code
roomCodeEl.addEventListener("click", () => {
  navigator.clipboard.writeText(code).then(() => {
    roomCodeEl.textContent = "copied!";
    setTimeout(() => (roomCodeEl.textContent = code), 1500);
  });
});

connectWebSocket();

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWebSocket() {
  setConnStatus("connecting");
  ws = new WebSocket(`${WS_BASE}/ws/${code}`);

  ws.addEventListener("open", () => {
    setConnStatus("connected");
  });

  ws.addEventListener("close", (e) => {
    setConnStatus("disconnected");
    clearInterval(timerTick);
    // Attempt reconnect after 3s unless it was a deliberate close (4004 = room gone)
    if (e.code !== 4004) {
      setTimeout(connectWebSocket, 3000);
    } else {
      showBanner("Room not found or expired.");
    }
  });

  ws.addEventListener("error", () => {
    setConnStatus("disconnected");
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }
    handleMessage(msg);
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
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
      // Snapshot of existing users' timers and todos when we join late
      msg.timers.forEach(t => {
        if (t.user_id === myUserId) {
          handleMyTimerUpdate(t);
        } else {
          renderOtherTimer(t); // stamps _receivedAt internally
        }
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
      if (msg.timer.user_id === myUserId) {
        handleMyTimerUpdate(msg.timer);
      } else {
        renderOtherTimer(msg.timer); // stamps _receivedAt internally
      }
      break;

    case "todo_update":
      if (msg.todo.user_id === myUserId) {
        renderMyTodos(msg.todo.items);
      } else {
        renderOtherTodos(msg.todo);
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
// The server sends us `remaining` (seconds) at a point in time.
// We count down locally to avoid hammering the server for display updates.

function startLocalTick() {
  clearInterval(timerTick);
  timerTick = setInterval(() => {
    // Update my own display
    const mine = timerStates[myUserId];
    if (mine) {
      const displayed = computeDisplayRemaining(mine);
      myTimerDisplay.textContent = formatTime(displayed);
      myTimerStatus.textContent  = mine.status;

      // Auto-trigger break suggestion when timer hits 0
      if (mine.status === "running" && displayed <= 0) {
        mine.status = "idle"; // local optimistic update
        syncMyTimerButtons("idle");
      }
    }

    // Update other users' displays
    for (const [uid, state] of Object.entries(timerStates)) {
      if (uid === myUserId) continue;
      const panel = document.getElementById(`panel-${uid}`);
      if (!panel) continue;
      const display = panel.querySelector(".timer-display");
      const label   = panel.querySelector(".timer-status-label");
      if (display) display.textContent = formatTime(computeDisplayRemaining(state));
      if (label)   label.textContent   = state.status;
    }
  }, 500);
}

/**
 * Compute display remaining by decrementing from the cached state.
 * The server sends remaining at message-receive time; we track elapsed locally.
 */
function computeDisplayRemaining(state) {
  if (state.status === "running") {
    // How long since we received this state?
    const elapsed = state._receivedAt
      ? (Date.now() - state._receivedAt) / 1000
      : 0;
    return Math.max(0, state.remaining - elapsed);
  }
  return state.remaining;
}

// Stamp incoming timer states with a received-at timestamp for local display
const _origTimerStates = timerStates;
function storeTimerState(t) {
  timerStates[t.user_id] = { ...t, _receivedAt: Date.now() };
}

// Override message handler to use storeTimerState
const _handleMessage = handleMessage;

// ── Timer: controls ───────────────────────────────────────────────────────────

btnStart.addEventListener("click", () => send({ type: "timer_action", action: "start" }));
btnPause.addEventListener("click", () => send({ type: "timer_action", action: "pause" }));
btnReset.addEventListener("click", () => send({ type: "timer_action", action: "reset" }));
btnBreak.addEventListener("click", () => send({ type: "timer_action", action: "break" }));

function syncMyTimerButtons(status) {
  // Enable/disable buttons based on timer status
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

// ── Timer: patch storeTimerState into message handler ────────────────────────
// Re-define handleMessage to stamp timer states on arrival

(function patchTimerReceive() {
  const original = handleMessage;
  // We directly stamp in the message handler below for clarity.
  // timerStates assignments below use Date.now() inline.
})();

// Re-define handleMessage to stamp _receivedAt
// (JavaScript hoisting means we can reassign the function here)
{
  const _h = handleMessage;
  window._handleMessage = _h; // keep reference for debugging
}

// ── Todo: my list ─────────────────────────────────────────────────────────────

todoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addTodo();
});
btnTodoAdd.addEventListener("click", addTodo);

function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;
  send({ type: "todo_action", action: "add", payload: { text } });
  todoInput.value = "";
}

function renderMyTodos(items) {
  myTodoList.innerHTML = "";
  items.forEach(item => {
    const li = buildTodoItem(item, true);
    myTodoList.appendChild(li);
  });
}

function buildTodoItem(item, isMine) {
  const li = document.createElement("li");
  li.className = "todo-item" + (item.done ? " done" : "");
  li.dataset.id = item.id;

  if (isMine) {
    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.done;
    checkbox.className = "todo-check";
    checkbox.addEventListener("change", () => {
      send({ type: "todo_action", action: "toggle", payload: { item_id: item.id } });
    });

    // Text (double-click to edit)
    const span = document.createElement("span");
    span.className = "todo-text";
    span.textContent = item.text;
    span.addEventListener("dblclick", () => startEdit(span, item.id));

    // Delete button
    const del = document.createElement("button");
    del.className = "todo-delete";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete task");
    del.addEventListener("click", () => {
      send({ type: "todo_action", action: "delete", payload: { item_id: item.id } });
    });

    li.append(checkbox, span, del);
  } else {
    // Read-only view for other users
    const dot = document.createElement("span");
    dot.className = "todo-dot" + (item.done ? " done" : "");
    dot.textContent = item.done ? "✓" : "·";

    const span = document.createElement("span");
    span.className = "todo-text";
    span.textContent = item.text;

    li.append(dot, span);
  }

  return li;
}

function startEdit(span, itemId) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "todo-edit-input";
  input.value = span.textContent;
  span.replaceWith(input);
  input.focus();

  function commit() {
    const text = input.value.trim();
    if (text && text !== span.textContent) {
      send({ type: "todo_action", action: "edit", payload: { item_id: itemId, text } });
    }
    input.replaceWith(span); // revert display (server response will re-render)
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  commit();
    if (e.key === "Escape") input.replaceWith(span);
  });
}

// ── Other users: panels ───────────────────────────────────────────────────────

function ensureOtherPanel(userId) {
  if (document.getElementById(`panel-${userId}`)) return;

  const section = document.createElement("section");
  section.id = `panel-${userId}`;
  section.className = "user-panel other-panel";
  section.setAttribute("aria-label", `User ${userId}`);
  section.innerHTML = `
    <div class="panel-header">
      <span class="panel-label">${userId.slice(0, 4)}</span>
    </div>
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
  // Stamp received time for local display
  timerStates[timerState.user_id] = { ...timerState, _receivedAt: Date.now() };
  ensureOtherPanel(timerState.user_id);
  const panel = document.getElementById(`panel-${timerState.user_id}`);
  if (!panel) return;
  const display = panel.querySelector(".timer-display");
  const label   = panel.querySelector(".timer-status-label");
  if (display) display.textContent = formatTime(timerState.remaining);
  if (label)   label.textContent   = timerState.status;
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

// Also stamp my own timer states when received
const _rawHandleMessage = handleMessage;
// Inline stamp in timer_update case above handles this via renderOtherTimer for others.
// For mine, stamp directly:
function handleMyTimerUpdate(t) {
  timerStates[t.user_id] = { ...t, _receivedAt: Date.now() };
  syncMyTimerButtons(t.status);
  myTimerDisplay.textContent = formatTime(t.remaining);
  myTimerStatus.textContent  = t.status;
}