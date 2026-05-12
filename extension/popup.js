const API_BASE = "http://localhost:8000";

const btnCreate  = document.getElementById("btn-create");
const btnJoin    = document.getElementById("btn-join");
const inputCode  = document.getElementById("input-code");
const statusMsg  = document.getElementById("status-msg");

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  statusMsg.textContent = msg;
  statusMsg.className = "status-msg " + (isError ? "status-error" : "status-info");
}

function setLoading(isLoading) {
  btnCreate.disabled = isLoading;
  btnJoin.disabled   = isLoading;
}

/** Open room.html in a new tab, passing the room code via URL param. */
function openRoom(code) {
  const url = chrome.runtime.getURL(`room.html?code=${code}`);
  chrome.tabs.create({ url });
  window.close(); // close the popup
}

// ── Force uppercase as user types ────────────────────────────────────────────

inputCode.addEventListener("input", () => {
  // Strip anything that isn't a letter or digit, then uppercase
  inputCode.value = inputCode.value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
});

// Allow pressing Enter in the code input to trigger Join
inputCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnJoin.click();
});

// ── Create room ───────────────────────────────────────────────────────────────

btnCreate.addEventListener("click", async () => {
  setLoading(true);
  setStatus("Creating room…");

  try {
    const res = await fetch(`${API_BASE}/rooms`, { method: "POST" });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);

    const { code } = await res.json();
    openRoom(code);

  } catch (err) {
    setStatus("Couldn't reach the server. Is the backend running?", true);
    console.error(err);
  } finally {
    setLoading(false);
  }
});

// ── Join room ─────────────────────────────────────────────────────────────────

btnJoin.addEventListener("click", async () => {
  const code = inputCode.value.trim();

  if (code.length !== 6) {
    setStatus("Room codes are 6 characters.", true);
    return;
  }

  setLoading(true);
  setStatus("Checking room…");

  try {
    const res = await fetch(`${API_BASE}/rooms/${code}`);

    if (!res.ok) throw new Error(`Server error: ${res.status}`);

    const data = await res.json();

    if (!data.exists) {
      setStatus("Room not found or expired.", true);
    } else if (!data.joinable) {
      setStatus(`Room is full (${data.max_users}/${data.max_users}).`, true);
    } else {
      openRoom(code);
    }

  } catch (err) {
    setStatus("Couldn't reach the server. Is the backend running?", true);
    console.error(err);
  } finally {
    setLoading(false);
  }
});

// ── Restore last-used code from storage (nice-to-have) ───────────────────────

chrome.storage.local.get("lastCode", ({ lastCode }) => {
  if (lastCode) inputCode.value = lastCode;
});