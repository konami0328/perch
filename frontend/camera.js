/**
 * camera.js — Perch face tracking and cartoon overlay
 *
 * Architecture:
 *   1. MediaPipe FaceMesh detects 468 landmarks locally (raw video never leaves device).
 *   2. Kalidokit solves the landmarks into normalised rig values
 *      (head rotation, eye open ratios, mouth shape).
 *   3. A line-art SVG face is rendered, driven by those values.
 *   4. Only rig values + state are sent over WebSocket — never the video.
 *   5. Remote users render their own SVG from the rig values.
 *
 * Public API:
 *   initCamera(videoEl, svgEl, { onMetrics, onStateChange })
 *   renderRemoteFace(svgEl, metrics, state)
 *   stopCamera()
 *
 * State machine: focused → distracted → severe → away
 *   focused    : face visible, head roughly forward
 *   distracted : head turned > yaw threshold, or pitched down
 *   severe     : distracted continuously for SEVERE_DISTRACTED_MS
 *   away       : no face detected for AWAY_MS
 *
 * camera.js only reports state changes via onStateChange.
 * room.js owns the UI (border colour, labels, etc).
 */

// ── Vendor URLs ───────────────────────────────────────────────────────────────

const FACEMESH_URL     = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
const CAMERA_UTILS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js";
const KALIDOKIT_URL    = "https://cdn.jsdelivr.net/npm/kalidokit@1.1/dist/kalidokit.umd.js";

// ── Tuning constants ──────────────────────────────────────────────────────────
// Threshold values are intentionally easy to tweak during internal testing.

// Head pose thresholds in degrees (use head.degrees.y/x from kalidokit)
const YAW_DISTRACTED   = 20;  // degrees left/right → distracted
const PITCH_DISTRACTED = 15;  // degrees looking down → distracted

// State timing (milliseconds)
const SEVERE_DISTRACTED_MS = 8_000;  // distracted this long → severe
const AWAY_MS              = 8_000;  // no face this long → away
const RECOVERY_MS          = 2_000;   // must be focused this long to leave severe (hysteresis)

// Throttle: how often we emit metrics over the network (FaceMesh runs ~30fps;
// no need to flood the room with that — 10fps is plenty for cartoon smoothing).
const METRICS_EMIT_INTERVAL_MS = 100;

// MediaPipe FaceMesh options
const FACEMESH_OPTIONS = {
  maxNumFaces:            1,
  refineLandmarks:        true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence:  0.6,
};

// SVG geometry — single source of truth, used by both local and remote rendering.
const SVG_VIEWBOX = { w: 200, h: 200 };

// ── State (module-scoped) ─────────────────────────────────────────────────────

/** @typedef {'focused'|'distracted'|'severe'|'away'} FaceState */

/** @type {FaceState} */
let faceState = "focused";

let severeTimer    = null;  // distracted → severe countdown
let awayTimer      = null;  // no-face → away countdown
let recoveryTimer  = null;  // severe → focused hysteresis

let lastEmitTime = 0;

// Last rig values, used both for our own SVG and as the payload sent over WS.
// Kept at module scope so we can keep rendering the last known face during
// brief detection dropouts instead of snapping to a default pose.
let lastMetrics = {
  head:      { x: 0, y: 0, z: 0 },  // pitch, yaw, roll (radians)
  eye:       { l: 1, r: 1 },        // 1 = open, 0 = closed
  mouth:     { x: 0, y: 0 },        // x: smile/frown, y: open amount
};

// DOM + library handles
let videoEl    = null;
let svgEl      = null;
let faceMesh   = null;
let cameraUtil = null;

// Callbacks injected by room.js
let _onMetrics     = null;
let _onStateChange = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the camera. Asks for camera permission, starts FaceMesh, and
 * begins driving the local SVG. Rejects if the user denies permission.
 *
 * @param {HTMLVideoElement} video - hidden video element (sink for getUserMedia)
 * @param {SVGElement}       svg   - visible SVG element to drive
 * @param {object}           cb
 * @param {(metrics: object, state: FaceState) => void} cb.onMetrics
 *        Called on every frame, throttled to METRICS_EMIT_INTERVAL_MS.
 *        room.js should forward this to the WebSocket.
 * @param {(state: FaceState) => void} cb.onStateChange
 *        Called when the state machine transitions.
 *        room.js owns the visual response (border colour, label, etc).
 */
export async function initCamera(video, svg, { onMetrics, onStateChange } = {}) {
  videoEl        = video;
  svgEl          = svg;
  _onMetrics     = onMetrics     || (() => {});
  _onStateChange = onStateChange || (() => {});

  buildSvgSkeleton(svgEl);

  await loadVendorScripts();
  await startFaceMesh();

  // Start in focused; room.js will paint the green border accordingly.
  setState("focused");
}

/**
 * Render a remote user's face from rig values received over WebSocket.
 * Stateless — call whenever a face_metrics message arrives.
 *
 * @param {SVGElement} svg
 * @param {object}     metrics  - rig values matching lastMetrics shape
 * @param {FaceState}  state    - so the SVG can show e.g. closed eyes when away
 */
export function renderRemoteFace(svg, metrics, state) {
  if (!svg.dataset.skeletonBuilt) buildSvgSkeleton(svg);
  drawFace(svg, metrics, state);
}

/**
 * Stop the camera and release resources. Safe to call multiple times.
 */
export function stopCamera() {
  if (cameraUtil) {
    try { cameraUtil.stop(); } catch { /* already stopped */ }
    cameraUtil = null;
  }
  clearAllTimers();
  faceState = "focused";
}

// ── Vendor loading ────────────────────────────────────────────────────────────

async function loadVendorScripts() {
  // FaceMesh and Camera utils must load before kalidokit, since kalidokit
  // doesn't depend on them but our use does.
  await loadScript(FACEMESH_URL);
  await loadScript(CAMERA_UTILS_URL);
  await loadScript(KALIDOKIT_URL);

  if (!window.FaceMesh)  throw new Error("FaceMesh failed to load");
  if (!window.Camera)    throw new Error("Camera utils failed to load");
  if (!window.Kalidokit) throw new Error("Kalidokit failed to load");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src         = src;
    s.crossOrigin = "anonymous";
    s.onload      = resolve;
    s.onerror     = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// ── FaceMesh setup ────────────────────────────────────────────────────────────

async function startFaceMesh() {
  faceMesh = new window.FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions(FACEMESH_OPTIONS);
  faceMesh.onResults(onFaceResults);

  cameraUtil = new window.Camera(videoEl, {
    onFrame: async () => {
      await faceMesh.send({ image: videoEl });
    },
    width:  640,
    height: 480,
  });

  await cameraUtil.start();
}

// ── Mouth Aspect Ratio ───────────────────────────────────────────────────────
// Computed directly from FaceMesh landmarks — more reliable than kalidokit viseme.
// Landmark indices: top=13, bottom=14, left=78, right=308
function computeMAR(lm) {
  const vert = Math.hypot(lm[13].x - lm[14].x, lm[13].y - lm[14].y);
  const horiz = Math.hypot(lm[78].x - lm[308].x, lm[78].y - lm[308].y);
  return horiz > 0 ? clamp01(vert / horiz * 3) : 0;  // *3 to amplify small openings
}

// ── Frame handler ─────────────────────────────────────────────────────────────

function onFaceResults(results) {
  const landmarks = results.multiFaceLandmarks?.[0];

  if (!landmarks) {
    handleFaceLost();
    return;
  }

  // We have a face — cancel any pending "away" countdown.
  clearAwayTimer();

  // Kalidokit solves the 468 landmarks into rig values. Using mediapipe runtime
  // because our landmarks come from FaceMesh, not tfjs.
  let rig;
  try {
    rig = window.Kalidokit.Face.solve(landmarks, {
      runtime: "mediapipe",
      video:   videoEl,
    });
  } catch (e) {
    console.error("[camera] Kalidokit.Face.solve failed:", e);
    handleFaceLost();
    return;
  }

  if (!rig) {
    console.warn("[camera] Kalidokit returned null rig");
    handleFaceLost();
    return;
  }

  // DEBUG: log rig shape once so we can verify field paths.
  // Remove after confirming eye/mouth values look correct.
  if (!window._perchRigLogged) {
    window._perchRigLogged = true;
    console.log("[camera] kalidokit rig sample:", JSON.stringify(rig, null, 2));
  }

  // Kalidokit eye values: rig.eye.l and rig.eye.r are 0..1 (1 = open).
  // mouth.y: compute MAR directly from landmarks (kalidokit viseme is unreliable).
  // mouth.x: use kalidokit mouth.x for smile/frown.
  const mouthOpen = computeMAR(landmarks);
  lastMetrics = {
    head:  { x: rig.head?.x ?? 0, y: rig.head?.y ?? 0, z: rig.head?.z ?? 0,
             degrees: rig.head?.degrees ?? { x: 0, y: 0, z: 0 } },
    eye:   { l: rig.eye?.l  ?? 1, r: rig.eye?.r  ?? 1 },
    mouth: { x: rig.mouth?.x ?? 0, y: mouthOpen },
  };

  // Decide what state we're in based on head pose.
  updateStateFromPose(rig.head);

  // Draw the local face.
  drawFace(svgEl, lastMetrics, faceState);

  // Throttle network emits — no point sending 30fps over WebSocket.
  const now = performance.now();
  if (now - lastEmitTime >= METRICS_EMIT_INTERVAL_MS) {
    lastEmitTime = now;
    _onMetrics(lastMetrics, faceState);
  }
}

function handleFaceLost() {
  // Keep showing the last known face (so the avatar doesn't snap), but start
  // the away countdown if it isn't already running.
  if (!awayTimer && faceState !== "away") {
    awayTimer = setTimeout(() => {
      setState("away");
    }, AWAY_MS);
  }
}

// ── State machine ─────────────────────────────────────────────────────────────

function updateStateFromPose(head) {
  // Use degrees (head.degrees.y/x) — human-readable and consistent across distances.
  // Pitch is negative when looking down.
  const absYaw = Math.abs(head.degrees.y);
  const pitch  = head.degrees.x;

  const looksAway = absYaw > YAW_DISTRACTED || pitch < -PITCH_DISTRACTED;

  if (looksAway) {
    if (faceState === "focused") {
      setState("distracted");
      scheduleSevere();
    } else if (faceState === "away") {
      // Came back from being away but still not focused — count as distracted.
      setState("distracted");
      scheduleSevere();
    }
    // If already distracted or severe, keep the existing severeTimer running.
    clearRecoveryTimer();
  } else {
    // Looking forward.
    if (faceState === "distracted") {
      setState("focused");
      clearSevereTimer();
    } else if (faceState === "severe") {
      // Hysteresis: require RECOVERY_MS of focused before clearing severe,
      // so a quick head-twitch doesn't flip back to green.
      if (!recoveryTimer) {
        recoveryTimer = setTimeout(() => {
          setState("focused");
          clearSevereTimer();
          recoveryTimer = null;
        }, RECOVERY_MS);
      }
    } else if (faceState === "away") {
      setState("focused");
    }
  }
}

function scheduleSevere() {
  if (severeTimer) return;
  severeTimer = setTimeout(() => {
    setState("severe");
    severeTimer = null;
  }, SEVERE_DISTRACTED_MS);
}

function setState(next) {
  if (faceState === next) return;
  faceState = next;
  _onStateChange(next);
}

function clearSevereTimer() {
  if (severeTimer) { clearTimeout(severeTimer); severeTimer = null; }
}
function clearAwayTimer() {
  if (awayTimer)   { clearTimeout(awayTimer);   awayTimer   = null; }
}
function clearRecoveryTimer() {
  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
}
function clearAllTimers() {
  clearSevereTimer();
  clearAwayTimer();
  clearRecoveryTimer();
}

// ── SVG rendering ─────────────────────────────────────────────────────────────
//
// Placeholder line-art face: just a head outline, two eyes (lines that grow
// to circles when open), and a mouth line. Designed to be replaced later by
// path data derived from a reference jpg — see TODO below.
//
// All parts are created once in buildSvgSkeleton(), then drawFace() only
// updates their attributes per frame. This is much cheaper than rebuilding
// SVG nodes on every frame.

const NS = "http://www.w3.org/2000/svg";

function buildSvgSkeleton(svg) {
  if (svg.dataset.skeletonBuilt) return;

  svg.setAttribute("viewBox", `0 0 ${SVG_VIEWBOX.w} ${SVG_VIEWBOX.h}`);
  svg.setAttribute("xmlns", NS);
  svg.innerHTML = "";  // clear any previous content

  // Group that we'll rotate/translate based on head pose.
  const g = document.createElementNS(NS, "g");
  g.setAttribute("data-role", "head");
  g.setAttribute("transform-origin", `${SVG_VIEWBOX.w / 2} ${SVG_VIEWBOX.h / 2}`);
  svg.appendChild(g);

  // ── Head outline ──
  // TODO(art): replace with a path derived from a reference jpg.
  // For now: a soft circle at the centre.
  const head = document.createElementNS(NS, "circle");
  head.setAttribute("cx", SVG_VIEWBOX.w / 2);
  head.setAttribute("cy", SVG_VIEWBOX.h / 2);
  head.setAttribute("r", 70);
  head.setAttribute("fill", "none");
  head.setAttribute("stroke", "currentColor");
  head.setAttribute("stroke-width", "2.5");
  head.setAttribute("stroke-linecap", "round");
  head.setAttribute("data-role", "head-outline");
  g.appendChild(head);

  // ── Eyes ──
  // Each eye is a single <path> we mutate per frame. The path draws an arc
  // whose vertical extent reflects how open the eye is (0 = flat line,
  // 1 = full circle).
  const eyeL = document.createElementNS(NS, "path");
  eyeL.setAttribute("data-role", "eye-l");
  eyeL.setAttribute("fill", "none");
  eyeL.setAttribute("stroke", "currentColor");
  eyeL.setAttribute("stroke-width", "2.5");
  eyeL.setAttribute("stroke-linecap", "round");
  g.appendChild(eyeL);

  const eyeR = document.createElementNS(NS, "path");
  eyeR.setAttribute("data-role", "eye-r");
  eyeR.setAttribute("fill", "none");
  eyeR.setAttribute("stroke", "currentColor");
  eyeR.setAttribute("stroke-width", "2.5");
  eyeR.setAttribute("stroke-linecap", "round");
  g.appendChild(eyeR);

  // ── Mouth ──
  const mouth = document.createElementNS(NS, "path");
  mouth.setAttribute("data-role", "mouth");
  mouth.setAttribute("fill", "none");
  mouth.setAttribute("stroke", "currentColor");
  mouth.setAttribute("stroke-width", "2.5");
  mouth.setAttribute("stroke-linecap", "round");
  g.appendChild(mouth);

  svg.dataset.skeletonBuilt = "1";
}

/**
 * Update SVG attributes from rig values. Called per frame for local face,
 * and on each face_metrics message for remote faces.
 */
function drawFace(svg, m, state) {
  const g = svg.querySelector('[data-role="head"]');
  if (!g) return;

  // Head tilt: roll around z, slight translate to suggest yaw.
  // Kalidokit head.z is roll (radians), head.y is yaw, head.x is pitch.
  const rollDeg = (m.head.z * 180) / Math.PI;
  const dx      = m.head.y * 12;   // small horizontal shift hints at yaw
  const dy      = -m.head.x * 8;   // pitch translates up/down
  g.setAttribute("transform", `translate(${dx} ${dy}) rotate(${rollDeg})`);

  // Eyes: when away/severe with no face, show closed eyes for a "resting" feel.
  // Otherwise drive openness from rig values.
  const eyeOpenL = state === "away" ? 0.05 : clamp01(m.eye.l);
  const eyeOpenR = state === "away" ? 0.05 : clamp01(m.eye.r);

  const cy = SVG_VIEWBOX.h / 2 - 12;
  drawEye(svg.querySelector('[data-role="eye-l"]'),  SVG_VIEWBOX.w / 2 - 22, cy, eyeOpenL);
  drawEye(svg.querySelector('[data-role="eye-r"]'),  SVG_VIEWBOX.w / 2 + 22, cy, eyeOpenR);

  // Mouth: y is openness (0..1), x is smile/frown (-1..1).
  drawMouth(svg.querySelector('[data-role="mouth"]'),
            SVG_VIEWBOX.w / 2,
            SVG_VIEWBOX.h / 2 + 28,
            clamp(m.mouth.x, -1, 1),
            clamp01(m.mouth.y));
}

/**
 * Draw a single eye. open=0 → flat line. open=1 → almond shape.
 * Uses two cubic curves to form an eye-like outline.
 */
function drawEye(el, cx, cy, open) {
  if (!el) return;
  const halfW = 9;
  const halfH = 1 + open * 6;  // tweak to taste once we have a reference jpg
  // Path: move to left corner, curve up to right corner, curve back down.
  const d = `M ${cx - halfW} ${cy}
             Q ${cx} ${cy - halfH} ${cx + halfW} ${cy}
             Q ${cx} ${cy + halfH} ${cx - halfW} ${cy} Z`;
  el.setAttribute("d", d);
}

/**
 * Draw the mouth. openY=0 + smileX=0 → flat line.
 * openY > 0 opens vertically, smileX > 0 curves up at corners.
 */
function drawMouth(el, cx, cy, smileX, openY) {
  if (!el) return;
  const halfW   = 14;
  const curve   = smileX * 6;   // positive = smile (curves up)
  const openAmt = openY * 10;

  if (openAmt < 1.5) {
    // Closed: a single curved line, optionally smiling.
    const d = `M ${cx - halfW} ${cy}
               Q ${cx} ${cy + 4 - curve} ${cx + halfW} ${cy}`;
    el.setAttribute("d", d);
  } else {
    // Open: an oval-ish shape.
    const d = `M ${cx - halfW} ${cy}
               Q ${cx} ${cy - openAmt - curve} ${cx + halfW} ${cy}
               Q ${cx} ${cy + openAmt}        ${cx - halfW} ${cy} Z`;
    el.setAttribute("d", d);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v)       { return Math.max(0,  Math.min(1,  v)); }