/**
 * camera.js — Perch face detection and cartoon overlay
 *
 * Architecture:
 *   1. MediaPipe FaceMesh detects 468 landmarks locally (raw video never leaves device)
 *   2. Landmarks are used to compute face metrics (EAR, MAR, yaw, pitch)
 *   3. A SVG cartoon face is rendered on a canvas overlay, driven by those metrics
 *   4. Only the computed metrics are sent to the room via WebSocket (not video)
 *   5. Remote users render their own SVG cartoon from received metrics
 *
 * States: INACTIVE → ACTIVE → AWAY (substate: DISTRACTED → SLEEPING) | OFF_FRAME
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const FACEMESH_CDN     = chrome.runtime.getURL("vendor/face_mesh.js");
const CAMERA_UTILS_CDN = chrome.runtime.getURL("vendor/camera_utils.js");

// Eye Aspect Ratio thresholds
const EAR_BLINK_THRESHOLD = 0.21;     // below this = eye closed
const EAR_OPEN_THRESHOLD  = 0.26;     // above this = eye open

// Mouth Aspect Ratio thresholds
const MAR_OPEN_THRESHOLD  = 0.35;     // above this = mouth open

// Head pose thresholds (degrees)
const YAW_SIDE_START  = 30;           // start tilting cartoon
const YAW_SIDE_FADE   = 70;           // start fading out
const PITCH_DOWN_FADE = 25;           // looking down: start fade

// Timing (milliseconds)
const DISTRACTED_TIMEOUT_MS = 20_000; // low head/out-of-frame before "sleeping"
const AWAY_TIMEOUT_MS       = 10_000; // off-frame before "away" label shows
const FADE_DURATION_MS      = 400;    // opacity transition duration

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {'inactive'|'tracking'|'lowhead'|'sleeping'|'offframe'|'away'} */
let faceState = "inactive";

let distractedTimer  = null;  // timeout handle for sleeping transition
let awayTimer        = null;  // timeout handle for away label
let currentOpacity   = 1.0;   // current cartoon face opacity (0–1)
let targetOpacity    = 1.0;   // animated target opacity

// Last valid face metrics (used to freeze when face temporarily lost)
let lastMetrics = {
  yaw:        0,   // head left/right rotation in degrees (negative = left)
  pitch:      0,   // head up/down rotation in degrees (negative = down)
  eyeLeft:    1,   // 0 (closed) to 1 (open)
  eyeRight:   1,
  mouthOpen:  0,   // 0 (closed) to 1 (wide open)
  isSleeping: false,
};

// Camera/canvas elements
let videoEl    = null;
let canvasEl   = null;
let ctx        = null;
let faceMesh   = null;
let cameraUtil = null;

// WebSocket send function — injected by room.js
let _wsSend = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the camera module.
 *
 * @param {HTMLVideoElement} video  - hidden video element to capture from
 * @param {HTMLCanvasElement} canvas - visible canvas for cartoon overlay
 * @param {function} sendFn - WebSocket send function from room.js
 */
export async function initCamera(video, canvas, sendFn) {
  videoEl   = video;
  canvasEl  = canvas;
  ctx       = canvas.getContext("2d");
  _wsSend   = sendFn;

  await loadMediaPipe();
  await startCamera();
  startRenderLoop();
}

/**
 * Render a remote user's cartoon face from metrics data received over WebSocket.
 *
 * @param {HTMLCanvasElement} canvas - the canvas inside that user's panel
 * @param {object} metrics           - face metrics from the remote user
 */
export function renderRemoteFace(canvas, metrics) {
  const remoteCtx = canvas.getContext("2d");
  remoteCtx.clearRect(0, 0, canvas.width, canvas.height);
  drawCartoonFace(remoteCtx, canvas.width, canvas.height, metrics, 1.0);
}

/**
 * Stop the camera and release resources.
 */
export function stopCamera() {
  if (cameraUtil) cameraUtil.stop();
  clearTimeout(distractedTimer);
  clearTimeout(awayTimer);
  faceState = "inactive";
}

// ── MediaPipe setup ───────────────────────────────────────────────────────────

async function loadMediaPipe() {
  await loadScript(FACEMESH_CDN);
  await loadScript(CAMERA_UTILS_CDN);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function startCamera() {
  faceMesh = new window.FaceMesh({
    locateFile: (file) => chrome.runtime.getURL(`vendor/${file}`),
  });

  faceMesh.setOptions({
    maxNumFaces:          1,
    refineLandmarks:      true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence:  0.6,
  });

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

// ── Face metrics computation ──────────────────────────────────────────────────

/**
 * MediaPipe FaceMesh landmark indices for key features.
 * Full map: https://github.com/google/mediapipe/wiki/MediaPipe-Face-Mesh
 */
const LM = {
  // Left eye (from user's perspective)
  LEFT_EYE_TOP:    159,
  LEFT_EYE_BOTTOM: 145,
  LEFT_EYE_LEFT:   33,
  LEFT_EYE_RIGHT:  133,
  // Right eye
  RIGHT_EYE_TOP:   386,
  RIGHT_EYE_BOTTOM: 374,
  RIGHT_EYE_LEFT:  362,
  RIGHT_EYE_RIGHT: 263,
  // Mouth
  MOUTH_TOP:    13,
  MOUTH_BOTTOM: 14,
  MOUTH_LEFT:   78,
  MOUTH_RIGHT:  308,
  // Head pose estimation
  NOSE_TIP:     4,
  CHIN:         152,
  LEFT_TEMPLE:  234,
  RIGHT_TEMPLE: 454,
  FOREHEAD:     10,
};

/**
 * Eye Aspect Ratio — classic blink detection metric.
 * EAR = (vertical_dist) / (horizontal_dist)
 */
function computeEAR(lm, top, bottom, left, right) {
  const vert  = dist(lm[top], lm[bottom]);
  const horiz = dist(lm[left], lm[right]);
  return horiz > 0 ? vert / horiz : 1;
}

/**
 * Mouth Aspect Ratio — same principle as EAR.
 */
function computeMAR(lm) {
  const vert  = dist(lm[LM.MOUTH_TOP], lm[LM.MOUTH_BOTTOM]);
  const horiz = dist(lm[LM.MOUTH_LEFT], lm[LM.MOUTH_RIGHT]);
  return horiz > 0 ? vert / horiz : 0;
}

/**
 * Estimate head yaw (left/right) and pitch (up/down) from landmark geometry.
 *
 * Yaw:   compare horizontal position of nose tip vs. midpoint of temples
 *         positive = facing right, negative = facing left
 * Pitch: compare vertical position of nose tip vs. chin-to-forehead midline
 *         positive = looking up, negative = looking down
 *
 * These are rough estimates (not true 3D pose), but good enough for our states.
 */
function computeHeadPose(lm) {
  const midX  = (lm[LM.LEFT_TEMPLE].x + lm[LM.RIGHT_TEMPLE].x) / 2;
  const templeWidth = dist2D(lm[LM.LEFT_TEMPLE], lm[LM.RIGHT_TEMPLE]);

  // Yaw: how far is nose from face center, relative to face width
  const yawNorm = (lm[LM.NOSE_TIP].x - midX) / (templeWidth / 2);
  const yaw     = yawNorm * 90; // scale to rough degrees

  // Pitch: how far nose tip is below the chin-forehead midpoint
  const midY   = (lm[LM.FOREHEAD].y + lm[LM.CHIN].y) / 2;
  const faceH  = Math.abs(lm[LM.CHIN].y - lm[LM.FOREHEAD].y);
  const pitchNorm = (midY - lm[LM.NOSE_TIP].y) / (faceH / 2);
  const pitch      = pitchNorm * 60; // scale to rough degrees

  return { yaw, pitch };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Face state machine ────────────────────────────────────────────────────────

function onFaceResults(results) {
  const lm = results.multiFaceLandmarks?.[0];

  if (!lm) {
    handleNoFace();
    return;
  }

  // Face is visible — cancel any away timer
  clearTimeout(awayTimer);
  awayTimer = null;

  const earLeft  = computeEAR(lm, LM.LEFT_EYE_TOP, LM.LEFT_EYE_BOTTOM,
                                   LM.LEFT_EYE_LEFT, LM.LEFT_EYE_RIGHT);
  const earRight = computeEAR(lm, LM.RIGHT_EYE_TOP, LM.RIGHT_EYE_BOTTOM,
                                   LM.RIGHT_EYE_LEFT, LM.RIGHT_EYE_RIGHT);
  const mar      = computeMAR(lm);
  const { yaw, pitch } = computeHeadPose(lm);

  const absYaw   = Math.abs(yaw);
  const absPitch = pitch; // negative = looking down

  // Determine state based on pose
  if (absYaw > YAW_SIDE_FADE || absPitch < -PITCH_DOWN_FADE) {
    // Head turned far away or looking down
    setTargetOpacity(0.0);
    transitionTo("lowhead");
    scheduleDistracted();
  } else {
    // Face is in a reasonable tracking range
    clearDistractedTimer();
    if (faceState !== "tracking") transitionTo("tracking");
    setTargetOpacity(absYaw > YAW_SIDE_START ? lerpOpacity(absYaw) : 1.0);
  }

  // Update last valid metrics
  lastMetrics = {
    yaw,
    pitch,
    eyeLeft:   clamp01(earLeft  / EAR_OPEN_THRESHOLD),
    eyeRight:  clamp01(earRight / EAR_OPEN_THRESHOLD),
    mouthOpen: clamp01(mar      / MAR_OPEN_THRESHOLD),
    isSleeping: faceState === "sleeping",
  };

  // Broadcast metrics to room (throttled — we only send on animation frame anyway)
  broadcastMetrics(lastMetrics);
}

function handleNoFace() {
  if (faceState === "offframe" || faceState === "away") return;

  transitionTo("offframe");
  setTargetOpacity(0.2); // ghost/placeholder opacity

  if (!awayTimer) {
    awayTimer = setTimeout(() => {
      transitionTo("away");
      lastMetrics.isSleeping = false; // reset sleep when truly away
    }, AWAY_TIMEOUT_MS);
  }
}

function scheduleDistracted() {
  if (distractedTimer) return;
  distractedTimer = setTimeout(() => {
    transitionTo("sleeping");
    lastMetrics.isSleeping = true;
    broadcastMetrics(lastMetrics);
  }, DISTRACTED_TIMEOUT_MS);
}

function clearDistractedTimer() {
  clearTimeout(distractedTimer);
  distractedTimer = null;
  if (faceState === "sleeping") {
    lastMetrics.isSleeping = false;
  }
}

function transitionTo(newState) {
  faceState = newState;
}

// Opacity fades out between YAW_SIDE_START and YAW_SIDE_FADE degrees
function lerpOpacity(absYaw) {
  const t = (absYaw - YAW_SIDE_START) / (YAW_SIDE_FADE - YAW_SIDE_START);
  return clamp01(1 - t);
}

function setTargetOpacity(target) {
  targetOpacity = target;
}

// ── Render loop ───────────────────────────────────────────────────────────────

function startRenderLoop() {
  let lastTime = 0;

  function frame(ts) {
    const dt = ts - lastTime;
    lastTime = ts;

    // Smooth opacity toward target
    const step = dt / FADE_DURATION_MS;
    if (currentOpacity < targetOpacity) {
      currentOpacity = Math.min(targetOpacity, currentOpacity + step);
    } else if (currentOpacity > targetOpacity) {
      currentOpacity = Math.max(targetOpacity, currentOpacity - step);
    }

    // Draw
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (currentOpacity > 0.01) {
      drawCartoonFace(ctx, canvasEl.width, canvasEl.height, lastMetrics, currentOpacity);
    }

    // Draw state overlay label if away
    if (faceState === "away") {
      drawAwayLabel(ctx, canvasEl.width, canvasEl.height);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

// ── SVG-style cartoon face drawing ───────────────────────────────────────────

/**
 * Draw the cartoon face onto a 2D canvas context.
 *
 * The face is drawn centered at (cx, cy) with a radius of ~faceR pixels.
 * Yaw tilts/skews the face horizontally; pitch has limited effect.
 * The face squishes slightly when the eye blink.
 */
function drawCartoonFace(ctx, w, h, metrics, opacity) {
  const cx    = w / 2;
  const cy    = h / 2;
  const faceR = Math.min(w, h) * 0.34;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Apply yaw as a horizontal skew transform
  const yawRad = (metrics.yaw * Math.PI) / 180;
  ctx.translate(cx, cy);
  ctx.transform(1, 0, Math.sin(yawRad) * 0.3, 1, 0, 0);
  ctx.translate(-cx, -cy);

  // ── Face base ────────────────────────────────────────────────────────────────
  const grad = ctx.createRadialGradient(cx, cy - faceR * 0.1, faceR * 0.2,
                                         cx, cy,                faceR * 1.05);
  grad.addColorStop(0,   "#f5f0e8");
  grad.addColorStop(0.7, "#ede6d6");
  grad.addColorStop(1,   "#d9cfc0");

  ctx.beginPath();
  ctx.ellipse(cx, cy, faceR * 0.88, faceR, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "#c4b89a";
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // ── Cheek blush ──────────────────────────────────────────────────────────────
  drawBlush(ctx, cx - faceR * 0.52, cy + faceR * 0.08, faceR * 0.18);
  drawBlush(ctx, cx + faceR * 0.52, cy + faceR * 0.08, faceR * 0.18);

  // ── Eyes ─────────────────────────────────────────────────────────────────────
  const eyeY     = cy - faceR * 0.15;
  const eyeOffX  = faceR * 0.32;
  const eyeOpenL = metrics.eyeLeft;
  const eyeOpenR = metrics.eyeRight;

  drawEye(ctx, cx - eyeOffX, eyeY, faceR * 0.14, eyeOpenL, metrics.isSleeping);
  drawEye(ctx, cx + eyeOffX, eyeY, faceR * 0.14, eyeOpenR, metrics.isSleeping);

  // ── Eyebrows ─────────────────────────────────────────────────────────────────
  const browY = eyeY - faceR * 0.22;
  drawBrow(ctx, cx - eyeOffX, browY, faceR * 0.16, metrics.isSleeping ? -1 : 0);
  drawBrow(ctx, cx + eyeOffX, browY, faceR * 0.16, metrics.isSleeping ? -1 : 0);

  // ── Nose (minimal) ───────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy + faceR * 0.06, faceR * 0.035, 0, Math.PI * 2);
  ctx.fillStyle = "#c4a882";
  ctx.fill();

  // ── Mouth ────────────────────────────────────────────────────────────────────
  drawMouth(ctx, cx, cy + faceR * 0.35, faceR, metrics.mouthOpen, metrics.isSleeping);

  // ── Sleeping Z's ─────────────────────────────────────────────────────────────
  if (metrics.isSleeping) {
    drawSleepingZs(ctx, cx + faceR * 0.6, cy - faceR * 0.5, faceR);
  }

  ctx.restore();
}

function drawBlush(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0,   "rgba(220, 150, 130, 0.35)");
  g.addColorStop(1,   "rgba(220, 150, 130, 0)");
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

function drawEye(ctx, x, y, r, openAmount, isSleeping) {
  // openAmount: 1 = fully open, 0 = fully closed

  if (isSleeping) {
    // Simple closed line for sleeping
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.quadraticCurveTo(x, y + r * 0.4, x + r, y);
    ctx.strokeStyle = "#5a4a3a";
    ctx.lineWidth   = r * 0.25;
    ctx.lineCap     = "round";
    ctx.stroke();
    return;
  }

  const eyeH = r * openAmount;

  if (eyeH < r * 0.08) {
    // Blink: just a line
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x + r, y);
    ctx.strokeStyle = "#5a4a3a";
    ctx.lineWidth   = r * 0.2;
    ctx.lineCap     = "round";
    ctx.stroke();
    return;
  }

  // White sclera
  ctx.beginPath();
  ctx.ellipse(x, y, r, eyeH, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = "#c4b89a";
  ctx.lineWidth   = 0.8;
  ctx.stroke();

  // Iris
  const irisR = eyeH * 0.75;
  const irisGrad = ctx.createRadialGradient(x - irisR * 0.25, y - irisR * 0.25, irisR * 0.05,
                                             x, y, irisR);
  irisGrad.addColorStop(0, "#6b8c74");
  irisGrad.addColorStop(1, "#3d5a47");
  ctx.beginPath();
  ctx.ellipse(x, y, irisR * 0.8, Math.min(irisR, eyeH * 0.9), 0, 0, Math.PI * 2);
  ctx.fillStyle = irisGrad;
  ctx.fill();

  // Pupil
  ctx.beginPath();
  ctx.ellipse(x, y, irisR * 0.4, Math.min(irisR * 0.4, eyeH * 0.6), 0, 0, Math.PI * 2);
  ctx.fillStyle = "#1a2a20";
  ctx.fill();

  // Highlight
  ctx.beginPath();
  ctx.arc(x - irisR * 0.28, y - irisR * 0.28, irisR * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fill();
}

function drawBrow(ctx, x, y, w, droop) {
  // droop: 0 = neutral, -1 = drooping (sleeping/sad)
  ctx.beginPath();
  ctx.moveTo(x - w, y + droop * 4);
  ctx.quadraticCurveTo(x, y - w * 0.25 + droop * 6, x + w, y + droop * 4);
  ctx.strokeStyle = "#6b5a48";
  ctx.lineWidth   = w * 0.22;
  ctx.lineCap     = "round";
  ctx.stroke();
}

function drawMouth(ctx, cx, my, faceR, openAmount, isSleeping) {
  if (isSleeping) {
    // Small neutral line
    ctx.beginPath();
    ctx.moveTo(cx - faceR * 0.12, my);
    ctx.lineTo(cx + faceR * 0.12, my);
    ctx.strokeStyle = "#8b7060";
    ctx.lineWidth   = 2;
    ctx.lineCap     = "round";
    ctx.stroke();
    return;
  }

  const mw = faceR * 0.28;

  if (openAmount < 0.1) {
    // Closed smile
    ctx.beginPath();
    ctx.moveTo(cx - mw, my - faceR * 0.02);
    ctx.quadraticCurveTo(cx, my + faceR * 0.1, cx + mw, my - faceR * 0.02);
    ctx.strokeStyle = "#8b7060";
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = "round";
    ctx.stroke();
  } else {
    // Open mouth — ellipse that grows with openAmount
    const mouthH = faceR * 0.08 + openAmount * faceR * 0.14;
    ctx.beginPath();
    ctx.ellipse(cx, my + mouthH * 0.4, mw, mouthH, 0, 0, Math.PI * 2);
    ctx.fillStyle   = "#6b3a3a";
    ctx.fill();
    ctx.strokeStyle = "#8b7060";
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Tiny teeth hint
    ctx.beginPath();
    ctx.rect(cx - mw * 0.5, my, mw, mouthH * 0.35);
    ctx.fillStyle = "rgba(255,252,248,0.9)";
    ctx.fill();
  }
}

function drawAwayLabel(ctx, w, h) {
  const cx = w / 2;
  const cy = h / 2;

  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle   = "rgba(245, 242, 235, 0.85)";
  ctx.beginPath();
  ctx.roundRect(cx - 38, cy - 14, 76, 28, 6);
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.fillStyle   = "#7a6e62";
  ctx.font        = "12px Georgia, serif";
  ctx.textAlign   = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("暂离", cx, cy);
  ctx.restore();
}

function drawSleepingZs(ctx, x, y, faceR) {
  const sizes = [faceR * 0.1, faceR * 0.14, faceR * 0.18];
  const t = Date.now() / 1000;

  sizes.forEach((size, i) => {
    // Each Z floats upward on a staggered cycle
    const offset = ((t * 0.5 + i * 0.33) % 1);
    const drawX  = x + i * size * 0.8;
    const drawY  = y - offset * faceR * 0.5;
    const alpha  = offset < 0.7 ? offset / 0.7 : 1 - (offset - 0.7) / 0.3;

    ctx.save();
    ctx.globalAlpha *= alpha * 0.85;
    ctx.fillStyle   = "#7a6e62";
    ctx.font        = `${size}px Georgia, serif`;
    ctx.textAlign   = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("z", drawX, drawY);
    ctx.restore();
  });
}

// ── WebSocket broadcast ───────────────────────────────────────────────────────

// Throttle broadcasts to ~15 fps
let lastBroadcastTime = 0;

function broadcastMetrics(metrics) {
  if (!_wsSend) return;
  const now = Date.now();
  if (now - lastBroadcastTime < 66) return; // ~15 fps
  lastBroadcastTime = now;

  _wsSend({
    type:    "face_metrics",
    metrics: {
      yaw:       Math.round(metrics.yaw),
      pitch:     Math.round(metrics.pitch),
      eyeLeft:   +metrics.eyeLeft.toFixed(2),
      eyeRight:  +metrics.eyeRight.toFixed(2),
      mouthOpen: +metrics.mouthOpen.toFixed(2),
      isSleeping: metrics.isSleeping,
    },
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}