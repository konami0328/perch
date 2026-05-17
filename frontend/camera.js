/**
 * camera.js — Perch face tracking with blob avatar
 *
 * Avatar: round colored blob with large eyes and small mouth.
 * Configurable background color via window.PERCH_AVATAR_COLOR (defaults to coral).
 *
 * Renders:
 *   - Two large eyes with pupils that follow gaze direction
 *   - Blush circles that intensify with smile
 *   - Closed-eye arc for blinks
 *   - Half-closed lids for away/sleepy state
 *   - Small mouth with curve for smile/frown, opens when speaking, narrows when pouting
 *   - Spring easing on all values so motion feels natural
 */

const FACEMESH_URL     = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
const CAMERA_UTILS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js";
const KALIDOKIT_URL    = "https://cdn.jsdelivr.net/npm/kalidokit@1.1/dist/kalidokit.umd.js";

// ── Tuning constants ──────────────────────────────────────────────────────────

const YAW_DISTRACTED       = 20;
const PITCH_DISTRACTED     = 15;
const SEVERE_DISTRACTED_MS = 15_000;
const AWAY_MS              = 10_000;
const RECOVERY_MS          = 2_000;
const METRICS_EMIT_INTERVAL_MS = 100;
const REF_CHEEK_SPAN       = 0.38;

// Spring smoothing factor (0 = no smoothing, 1 = instant). Lower = more inertia.
const EASE_HEAD   = 0.18;
const EASE_EYE    = 0.10;   // reduced — was 0.35, high value leaked landmark noise
const EASE_PUPIL  = 0.25;
const EASE_MOUTH  = 0.10;
const EASE_BLUSH  = 0.25;

// Default avatar color (can be overridden via window.PERCH_AVATAR_COLOR)
const DEFAULT_BG = "#F28C8C";

const FACEMESH_OPTIONS = {
  maxNumFaces: 1, refineLandmarks: true,
  minDetectionConfidence: 0.6, minTrackingConfidence: 0.6,
};

// ── State ─────────────────────────────────────────────────────────────────────

/** @typedef {'focused'|'distracted'|'severe'|'away'} FaceState */
/** @type {FaceState} */
let faceState = "focused";
let severeTimer = null, awayTimer = null, recoveryTimer = null, lastEmitTime = 0;

let lastMetrics = {
  head:  { x: 0, y: 0, z: 0, degrees: { x: 0, y: 0, z: 0 } },
  eye:   { l: 1, r: 1 },
  pupil: { x: 0, y: 0 },
  mouth: { y: 0, cornerL: 0, cornerR: 0, pout: 0 },
  scale: 1,
};

// Eased (smoothed) values used for rendering. Updated each animation frame.
let eased = {
  yawDeg: 0, pitchDeg: 0, rollDeg: 0, faceScale: 1,
  eyeL: 1, eyeR: 1,
  pupilX: 0, pupilY: 0,
  mouthY: 0, cornerL: 0, cornerR: 0, pout: 0,
  blush: 0.3,
};

let videoEl = null, svgEl = null, faceMesh = null, cameraUtil = null;
let _onMetrics = null, _onStateChange = null;
let animationFrameId = null;

// ── Public API ────────────────────────────────────────────────────────────────

export async function initCamera(video, svg, { onMetrics, onStateChange } = {}) {
  videoEl = video; svgEl = svg;
  _onMetrics     = onMetrics     || (() => {});
  _onStateChange = onStateChange || (() => {});

  buildSvgSkeleton(svgEl);
  startAnimationLoop(svgEl);

  await loadVendorScripts();
  await startFaceMesh();
  setState("focused");
}

export function renderRemoteFace(svg, metrics, state) {
  if (!svg.dataset.skeletonBuilt) buildSvgSkeleton(svg);
  drawFace(svg, metrics, state, /* useEased */ false);
}

export function stopCamera() {
  if (cameraUtil) { try { cameraUtil.stop(); } catch {} cameraUtil = null; }
  if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
  clearAllTimers();
  faceState = "focused";
}

// ── Vendor loading ────────────────────────────────────────────────────────────

async function loadVendorScripts() {
  await loadScript(FACEMESH_URL);
  await loadScript(CAMERA_UTILS_URL);
  await loadScript(KALIDOKIT_URL);
  if (!window.FaceMesh)   throw new Error("FaceMesh failed to load");
  if (!window.Camera)     throw new Error("Camera utils failed to load");
  if (!window.Kalidokit) throw new Error("Kalidokit failed to load");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
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
    onFrame: async () => { await faceMesh.send({ image: videoEl }); },
    width: 640, height: 480,
  });
  await cameraUtil.start();
}

// ── Landmark helpers ──────────────────────────────────────────────────────────

function computeMAR(lm) {
  const vert   = Math.hypot(lm[13].x - lm[14].x, lm[13].y - lm[14].y);
  const horiz = Math.hypot(lm[78].x - lm[308].x, lm[78].y - lm[308].y);
  return horiz > 0 ? clamp01(vert / horiz * 3) : 0;
}

function computeMouthCorners(lm) {
  const mouthMidY = (lm[13].y + lm[14].y) / 2;
  const cornerR   = clamp((mouthMidY - lm[61].y)  * 30, -1, 1);
  const cornerL   = clamp((mouthMidY - lm[291].y) * 30, -1, 1);

  const faceWidth  = Math.hypot(lm[234].x - lm[454].x, lm[234].y - lm[454].y);
  const mouthWidth = Math.hypot(lm[78].x  - lm[308].x, lm[78].y  - lm[308].y);
  const normWidth  = faceWidth > 0 ? mouthWidth / faceWidth : 0.35;
  const pout       = clamp01((0.32 - normWidth) * 12);

  return { cornerL, cornerR, pout };
}

function computeFaceScale(lm) {
  const span = Math.hypot(lm[234].x - lm[454].x, lm[234].y - lm[454].y);
  return clamp(span / REF_CHEEK_SPAN, 0.5, 2.0);
}

function computePupilGaze(lm) {
  if (!lm[468] || !lm[473]) return { x: 0, y: 0 };
  const eyeLcx = (lm[33].x + lm[133].x) / 2;
  const eyeLcy = (lm[33].y + lm[133].y) / 2;
  const eyeLw   = Math.abs(lm[33].x - lm[133].x);
  const eyeRcx = (lm[362].x + lm[263].x) / 2;
  const eyeRcy = (lm[362].y + lm[263].y) / 2;
  const eyeRw   = Math.abs(lm[362].x - lm[263].x);

  const dxL = eyeLw > 0 ? (lm[468].x - eyeLcx) / (eyeLw / 2) : 0;
  const dyL = eyeLw > 0 ? (lm[468].y - eyeLcy) / (eyeLw / 2) : 0;
  const dxR = eyeRw > 0 ? (lm[473].x - eyeRcx) / (eyeRw / 2) : 0;
  const dyR = eyeRw > 0 ? (lm[473].y - eyeRcy) / (eyeRw / 2) : 0;

  return {
    x: clamp(-(dxL + dxR) / 2 * 1.5, -1, 1),
    y: clamp( (dyL + dyR) / 2 * 1.5, -1, 1),
  };
}

// ── Frame handler ─────────────────────────────────────────────────────────────

function onFaceResults(results) {
  const landmarks = results.multiFaceLandmarks?.[0];
  if (!landmarks) { handleFaceLost(); return; }

  clearAwayTimer();

  let rig;
  try {
    rig = window.Kalidokit.Face.solve(landmarks, { runtime: "mediapipe", video: videoEl });
  } catch (e) {
    console.error("[camera] Kalidokit.Face.solve failed:", e);
    handleFaceLost(); return;
  }
  if (!rig) { handleFaceLost(); return; }

  const { cornerL, cornerR, pout } = computeMouthCorners(landmarks);

  // Raw eye openness from Kalidokit. Note: Kalidokit swaps l/r vs MediaPipe convention.
  let rawEyeL = rig.eye?.r ?? 1;
  let rawEyeR = rig.eye?.l ?? 1;

  // Pitch-aware symmetry correction:
  // When looking down, FaceMesh landmark accuracy degrades asymmetrically — one eye's
  // lid points occlude before the other, causing one eye to appear more closed.
  // Fix: blend each eye toward their average proportionally to how much we're pitched down.
  const pitchDeg  = rig.head?.degrees?.x ?? (rig.head?.x ?? 0) * 57.3;
  const pitchDown = clamp01(-pitchDeg / 30);           // 0 at neutral, 1 at 30° down
  const eyeAvg    = (rawEyeL + rawEyeR) / 2;
  rawEyeL = lerp(rawEyeL, eyeAvg, pitchDown * 0.7);   // pull toward average when pitched
  rawEyeR = lerp(rawEyeR, eyeAvg, pitchDown * 0.7);

  // Symmetry clamp: if the two eyes differ by more than 0.25, pull the outlier inward.
  // This catches one-eye-open frames without flattening natural winks.
  const eyeDiff = Math.abs(rawEyeL - rawEyeR);
  if (eyeDiff > 0.25) {
    const pull = (eyeDiff - 0.25) * 0.6;
    if (rawEyeL > rawEyeR) rawEyeL -= pull; else rawEyeR -= pull;
  }

  lastMetrics = {
    head: {
      x: rig.head?.x ?? 0, y: rig.head?.y ?? 0, z: rig.head?.z ?? 0,
      degrees: rig.head?.degrees ?? { x: 0, y: 0, z: 0 },
    },
    eye:   { l: clamp01(rawEyeL), r: clamp01(rawEyeR) },
    pupil: computePupilGaze(landmarks),
    mouth: { y: computeMAR(landmarks), cornerL, cornerR, pout },
    scale: computeFaceScale(landmarks),
  };

  updateStateFromPose(rig.head);

  const now = performance.now();
  if (now - lastEmitTime >= METRICS_EMIT_INTERVAL_MS) {
    lastEmitTime = now;
    _onMetrics(lastMetrics, faceState);
  }
}

function handleFaceLost() {
  if (!awayTimer && faceState !== "away") {
    awayTimer = setTimeout(() => setState("away"), AWAY_MS);
  }
}

// ── State machine ─────────────────────────────────────────────────────────────

function updateStateFromPose(head) {
  const absYaw    = Math.abs(head.degrees?.y ?? head.y * 57.3);
  const pitch     = head.degrees?.x ?? head.x * 57.3;
  const looksAway = absYaw > YAW_DISTRACTED || pitch < -PITCH_DISTRACTED;

  if (looksAway) {
    if (faceState === "focused" || faceState === "away") {
      setState("distracted"); scheduleSevere();
    }
    clearRecoveryTimer();
  } else {
    if (faceState === "distracted") {
      setState("focused"); clearSevereTimer();
    } else if (faceState === "severe") {
      if (!recoveryTimer) {
        recoveryTimer = setTimeout(() => {
          setState("focused"); clearSevereTimer(); recoveryTimer = null;
        }, RECOVERY_MS);
      }
    } else if (faceState === "away") {
      setState("focused");
    }
  }
}

function scheduleSevere() {
  if (severeTimer) return;
  severeTimer = setTimeout(() => { setState("severe"); severeTimer = null; }, SEVERE_DISTRACTED_MS);
}
function setState(next) {
  if (faceState === next) return;
  faceState = next;
  _onStateChange(next);
}
function clearSevereTimer()   { if (severeTimer)   { clearTimeout(severeTimer);   severeTimer   = null; } }
function clearAwayTimer()     { if (awayTimer)     { clearTimeout(awayTimer);     awayTimer     = null; } }
function clearRecoveryTimer() { if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; } }
function clearAllTimers()     { clearSevereTimer(); clearAwayTimer(); clearRecoveryTimer(); }

// ── Anti-flicker helpers ──────────────────────────────────────────────────────

// Only write to the DOM when the string value actually changes.
// Keyed per element+attribute via WeakMap to avoid string allocation overhead.
const _attrCache = new WeakMap();
function setAttr(el, name, val) {
  if (!el) return;
  let m = _attrCache.get(el);
  if (!m) { m = Object.create(null); _attrCache.set(el, m); }
  if (m[name] === val) return;
  m[name] = val;
  el.setAttribute(name, val);
}

// Cache avatar color so we don't re-read window every frame.
let _cachedAvatarColor = null;
function getAvatarColor() {
  const c = window.PERCH_AVATAR_COLOR || DEFAULT_BG;
  if (c !== _cachedAvatarColor) _cachedAvatarColor = c;
  return _cachedAvatarColor;
}

// ── Animation loop ────────────────────────────────────────────────────────────

// How close eased values must be to their targets before we stop drawing.
const SETTLE_EPS = 0.002;

function startAnimationLoop(svg) {
  function tick() {
    const isAway = faceState === "away";

    const targetYaw   = lastMetrics.head.degrees?.y ?? lastMetrics.head.y * 57.3;
    const targetPitch = lastMetrics.head.degrees?.x ?? lastMetrics.head.x * 57.3;
    const targetRoll  = (lastMetrics.head.z * 180) / Math.PI;
    const targetScale = lastMetrics.scale ?? 1;
    const targetEyeL  = isAway ? 0 : lastMetrics.eye.l;
    const targetEyeR  = isAway ? 0 : lastMetrics.eye.r;
    const targetPupilX = isAway ? 0 : lastMetrics.pupil.x;
    const targetPupilY = isAway ? 0 : lastMetrics.pupil.y;
    const targetMouthY  = isAway ? 0 : lastMetrics.mouth.y;
    const targetCornerL = isAway ? 0 : lastMetrics.mouth.cornerL;
    const targetCornerR = isAway ? 0 : lastMetrics.mouth.cornerR;
    const targetPout    = isAway ? 0 : lastMetrics.mouth.pout;
    const smileTarget   = clamp01((targetCornerL + targetCornerR) / 2);
    const targetBlush   = isAway ? 0 : 0.25 + smileTarget * 0.55;

    eased.yawDeg    = lerp(eased.yawDeg,    targetYaw,    EASE_HEAD);
    eased.pitchDeg  = lerp(eased.pitchDeg,  targetPitch,  EASE_HEAD);
    eased.rollDeg   = lerp(eased.rollDeg,   targetRoll,   EASE_HEAD);
    eased.faceScale = lerp(eased.faceScale, targetScale,  EASE_HEAD);

    // How much we're looking down (0 = neutral/up, 1 = 30°+ down).
    // Used to increase smoothing where FaceMesh is least accurate.
    const pitchDownFactor = clamp01(-targetPitch / 30);

    // Dynamic eye easing: slow down more when pitched down, where landmark noise is worst.
    const dynEaseEye = lerp(EASE_EYE, EASE_EYE * 0.4, pitchDownFactor);

    eased.eyeL = lerp(eased.eyeL, targetEyeL, dynEaseEye);
    eased.eyeR = lerp(eased.eyeR, targetEyeR, dynEaseEye);

    eased.pupilX = lerp(eased.pupilX, targetPupilX, EASE_PUPIL);
    eased.pupilY = lerp(eased.pupilY, targetPupilY, EASE_PUPIL);

    // Dynamic mouth easing: also dampen when pitched — MAR is perspective-distorted.
    const dynEaseMouth = lerp(EASE_MOUTH, EASE_MOUTH * 0.35, pitchDownFactor);

    eased.mouthY  = lerp(eased.mouthY,  targetMouthY,  dynEaseMouth);
    eased.cornerL = lerp(eased.cornerL, targetCornerL, dynEaseMouth);
    eased.cornerR = lerp(eased.cornerR, targetCornerR, dynEaseMouth);
    eased.pout    = lerp(eased.pout,    targetPout,    dynEaseMouth);
    eased.blush   = lerp(eased.blush,   targetBlush,   EASE_BLUSH);

    // Skip DOM writes once all values have converged — eliminates resting flicker.
    const settled =
      Math.abs(eased.yawDeg   - targetYaw)    < SETTLE_EPS &&
      Math.abs(eased.pitchDeg - targetPitch)  < SETTLE_EPS &&
      Math.abs(eased.eyeL     - targetEyeL)   < SETTLE_EPS &&
      Math.abs(eased.eyeR     - targetEyeR)   < SETTLE_EPS &&
      Math.abs(eased.mouthY   - targetMouthY) < SETTLE_EPS &&
      Math.abs(eased.blush    - targetBlush)  < SETTLE_EPS;

    if (!settled) drawFaceFromEased(svg, isAway);

    animationFrameId = requestAnimationFrame(tick);
  }
  tick();
}

// ── SVG rendering ─────────────────────────────────────────────────────────────

const NS = "http://www.w3.org/2000/svg";

const BLOB_CX = 100, BLOB_CY = 100, BLOB_R = 78;
const EYE_DX  = 47;
const EYE_CY  = 92;
const EYE_W_R = 24;
const PUPIL_R = 14;
const PUPIL_RANGE = 15;
const MOUTH_CY = 130;
const BLUSH_DX = 55;
const BLUSH_CY = 122;

function mkEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function buildSvgSkeleton(svg) {
  if (svg.dataset.skeletonBuilt) return;

  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("xmlns", NS);
  svg.innerHTML = "";

  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "radialGradient");
  grad.setAttribute("id", "perch-blush");
  grad.setAttribute("cx", "50%"); grad.setAttribute("cy", "50%"); grad.setAttribute("r", "50%");
  const s1 = document.createElementNS(NS, "stop");
  s1.setAttribute("offset", "0%"); s1.setAttribute("stop-color", "#e85a7a"); s1.setAttribute("stop-opacity", "0.55");
  const s2 = document.createElementNS(NS, "stop");
  s2.setAttribute("offset", "100%"); s2.setAttribute("stop-color", "#e85a7a"); s2.setAttribute("stop-opacity", "0");
  grad.appendChild(s1); grad.appendChild(s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  ["l", "r"].forEach(side => {
    const cx = BLOB_CX + (side === "l" ? -EYE_DX : EYE_DX);
    const clipPath = document.createElementNS(NS, "clipPath");
    clipPath.setAttribute("id", `clip-eye-${side}`);
    clipPath.appendChild(mkEl("circle", { cx, cy: EYE_CY, r: EYE_W_R }));
    defs.appendChild(clipPath);
  });

  const baseBlob = mkEl("circle", {
    "data-role": "blob",
    cx: BLOB_CX, cy: BLOB_CY, r: BLOB_R,
    fill: getAvatarColor(),
  });
  svg.appendChild(baseBlob);

  const g = document.createElementNS(NS, "g");
  g.setAttribute("data-role", "head");
  g.setAttribute("transform-origin", `${BLOB_CX} ${BLOB_CY}`);
  svg.appendChild(g);

  g.appendChild(mkEl("ellipse", {
    "data-role": "blush-l",
    cx: BLOB_CX - BLUSH_DX, cy: BLUSH_CY, rx: 16, ry: 10,
    fill: "url(#perch-blush)", opacity: 0.3,
  }));
  g.appendChild(mkEl("ellipse", {
    "data-role": "blush-r",
    cx: BLOB_CX + BLUSH_DX, cy: BLUSH_CY, rx: 16, ry: 10,
    fill: "url(#perch-blush)", opacity: 0.3,
  }));

  ["l", "r"].forEach(side => {
    const cx = BLOB_CX + (side === "l" ? -EYE_DX : EYE_DX);

    const eyeGroup = document.createElementNS(NS, "g");
    g.appendChild(eyeGroup);

    eyeGroup.appendChild(mkEl("circle", {
      "data-role": `eye-${side}`,
      cx, cy: EYE_CY, r: EYE_W_R, fill: "white",
    }));
    eyeGroup.appendChild(mkEl("circle", {
      "data-role": `pupil-${side}`,
      cx, cy: EYE_CY, r: PUPIL_R, fill: "#2C2C2A",
    }));
    eyeGroup.appendChild(mkEl("circle", {
      "data-role": `highlight-${side}`,
      cx: cx + 6, cy: EYE_CY - 6, r: 4, fill: "white",
    }));
    eyeGroup.appendChild(mkEl("rect", {
      "data-role": `lid-${side}`,
      x: cx - EYE_W_R - 5, y: EYE_CY - EYE_W_R - 5,
      width: EYE_W_R * 2 + 10, height: 0,
      fill: getAvatarColor(),
      "clip-path": `url(#clip-eye-${side})`
    }));
    eyeGroup.appendChild(mkEl("path", {
      "data-role": `closed-${side}`,
      d: `M ${cx - EYE_W_R + 2} ${EYE_CY} Q ${cx} ${EYE_CY - 10} ${cx + EYE_W_R - 2} ${EYE_CY}`,
      fill: "none", stroke: "#2C2C2A", "stroke-width": 3, "stroke-linecap": "round",
      opacity: 0,
    }));
  });

  g.appendChild(mkEl("path", {
    "data-role": "mouth",
    d: `M ${BLOB_CX - 12} ${MOUTH_CY} Q ${BLOB_CX} ${MOUTH_CY} ${BLOB_CX + 12} ${MOUTH_CY}`,
    fill: "none", stroke: "#2C2C2A", "stroke-width": 3.5, "stroke-linecap": "round",
  }));

  svg.dataset.skeletonBuilt = "1";
}

function drawFaceFromEased(svg, isAway) {
  drawFaceImpl(svg, {
    yawDeg: eased.yawDeg, pitchDeg: eased.pitchDeg, rollDeg: eased.rollDeg,
    faceScale: eased.faceScale,
    eyeL: eased.eyeL, eyeR: eased.eyeR,
    pupilX: eased.pupilX, pupilY: eased.pupilY,
    mouthY: eased.mouthY, cornerL: eased.cornerL, cornerR: eased.cornerR,
    pout: eased.pout,
    blush: eased.blush,
  }, isAway);
}

function drawFace(svg, m, state, useEased) {
  const isAway = state === "away";
  drawFaceImpl(svg, {
    yawDeg:    m.head.degrees?.y ?? m.head.y * 57.3,
    pitchDeg:  m.head.degrees?.x ?? m.head.x * 57.3,
    rollDeg:   (m.head.z * 180) / Math.PI,
    faceScale: m.scale ?? 1,
    eyeL:      isAway ? 0 : clamp01(m.eye.l),
    eyeR:      isAway ? 0 : clamp01(m.eye.r),
    pupilX:    isAway ? 0 : (m.pupil?.x ?? 0),
    pupilY:    isAway ? 0 : (m.pupil?.y ?? 0),
    mouthY:    isAway ? 0 : clamp01(m.mouth.y),
    cornerL:   isAway ? 0 : (m.mouth.cornerL ?? 0),
    cornerR:   isAway ? 0 : (m.mouth.cornerR ?? 0),
    pout:      isAway ? 0 : (m.mouth.pout ?? 0),
    blush:     isAway ? 0 : 0.25 + clamp01(((m.mouth.cornerL ?? 0) + (m.mouth.cornerR ?? 0)) / 2) * 0.55,
  }, isAway);
}

function drawFaceImpl(svg, v, isAway) {
  const blob = svg.querySelector('[data-role="blob"]');
  const g    = svg.querySelector('[data-role="head"]');
  if (!g) return;

  const color = getAvatarColor();

  const fs = clamp(v.faceScale, 0.7, 1.1);
  if (blob) {
    setAttr(blob, "fill", color);
    setAttr(blob, "transform", `scale(${fs.toFixed(3)})`);
    setAttr(blob, "transform-origin", `${BLOB_CX} ${BLOB_CY}`);
  }

  const sx = clamp(1 - Math.abs(v.yawDeg)   / 90 * 0.25, 0.75, 1);
  const sy = clamp(1 - Math.abs(v.pitchDeg) / 60 * 0.10, 0.90, 1);
  const dx = v.yawDeg   * 0.45;
  const dy = -v.pitchDeg * 0.40;

  setAttr(g, "transform-origin", `${BLOB_CX} ${BLOB_CY}`);
  setAttr(g, "transform",
    `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) ` +
    `scale(${(sx * fs).toFixed(3)} ${(sy * fs).toFixed(3)}) ` +
    `rotate(${v.rollDeg.toFixed(2)})`
  );

  updateEye(g, "l", v.eyeL, v.pupilX, v.pupilY, color);
  updateEye(g, "r", v.eyeR, v.pupilX, v.pupilY, color);
  updateMouth(g, v.mouthY, v.cornerL, v.cornerR, v.pout);

  const bl = g.querySelector('[data-role="blush-l"]');
  const br = g.querySelector('[data-role="blush-r"]');
  setAttr(bl, "opacity", v.blush.toFixed(2));
  setAttr(br, "opacity", v.blush.toFixed(2));
}

function updateEye(g, side, open, pupilX, pupilY, bgColor) {
  const cx     = BLOB_CX + (side === "l" ? -EYE_DX : EYE_DX);
  const cy     = EYE_CY;
  const pupil  = g.querySelector(`[data-role="pupil-${side}"]`);
  const hl     = g.querySelector(`[data-role="highlight-${side}"]`);
  const lid    = g.querySelector(`[data-role="lid-${side}"]`);
  const closed = g.querySelector(`[data-role="closed-${side}"]`);

  const px = cx + pupilX * PUPIL_RANGE;
  const py = cy + pupilY * PUPIL_RANGE;
  setAttr(pupil, "cx", px.toFixed(2));
  setAttr(pupil, "cy", py.toFixed(2));
  setAttr(hl,    "cx", (px + 6).toFixed(2));
  setAttr(hl,    "cy", (py - 6).toFixed(2));

  const lidH = (EYE_W_R * 2 + 10) * (1 - open);
  setAttr(lid, "height", lidH.toFixed(2));
  setAttr(lid, "fill",   bgColor);

  if (closed) {
    const arcOpacity = open < 0.15 ? clamp01((0.15 - open) / 0.15) : 0;
    setAttr(closed, "opacity", arcOpacity.toFixed(2));
  }
}

function updateMouth(g, openY, cornerL, cornerR, pout) {
  const mouth = g.querySelector('[data-role="mouth"]');
  if (!mouth) return;

  const cx = BLOB_CX;
  const cy = MOUTH_CY;

  const w     = 12 * (1 - pout * 0.62);
  const liftL = cornerL * 4.5;
  const liftR = cornerR * 4.5;
  const smile = (cornerL + cornerR) / 2;
  const open  = openY * 9;

  if (open < 1.2) {
    const midY   = cy - (smile * 6.5);
    const leftY  = cy - liftL + (pout * 1.5);
    const rightY = cy - liftR + (pout * 1.5);
    setAttr(mouth, "d",
      `M ${(cx - w).toFixed(1)} ${leftY.toFixed(1)} ` +
      `Q ${cx} ${midY.toFixed(1)} ` +
      `${(cx + w).toFixed(1)} ${rightY.toFixed(1)}`
    );
    setAttr(mouth, "fill", "none");
  } else {
    const top    = cy - open * (0.35 - pout * 0.1);
    const bottom = cy + open * (0.65 - pout * 0.2);
    const openW  = w * (1 + Math.max(0, smile) * 0.2);
    setAttr(mouth, "d",
      `M ${(cx - openW).toFixed(1)} ${cy} ` +
      `Q ${cx} ${top.toFixed(1)} ${(cx + openW).toFixed(1)} ${cy} ` +
      `Q ${cx} ${bottom.toFixed(1)} ${(cx - openW).toFixed(1)} ${cy} Z`
    );
    setAttr(mouth, "fill", "#2C2C2A");
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v)        { return Math.max(0,  Math.min(1,  v)); }