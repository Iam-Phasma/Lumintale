let SPACING = 10;
const RADIUS = 2;
let DPR = 1, CW = 0, CH = 0; // physical pixel ratio and CSS viewport dimensions
let isLightMode = false;
let ledColor = '#ffffff';
let brightnessLevel = 1.0;
let showMapOutline = false;

const getBgColor  = () => isLightMode ? '#e0e0e0' : '#1f1f1f';
const getOffColor = () => isLightMode ? '#c2c2c2' : '#181818';

function applyBrightness(hex, extra = 1.0) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = brightnessLevel * extra;
  return `rgb(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)})`;
}

// In light mode: saturated colors stay vivid (factor 1.0); near-white would vanish
// against the pale background so push it to near-black instead.
function lightModeFactor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r > 200 && g > 200 && b > 200) ? 0.18 : 1.0;
}

const getLedColor = () => applyBrightness(ledColor, isLightMode ? lightModeFactor(ledColor) : 1.0);

const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');

// ---- World map (TopoJSON) ----
let worldGeo        = null;  // GeoJSON FeatureCollection of land
let outlineCanvas   = null;  // pre-rendered map outline (redrawn on resize)
let seismicPool     = null;  // unused — kept for legacy flicker guard
let seismicRipples  = null;  // Array of active ripple objects (top 10 by mag)
let seismicStaticDots = null; // Set of LED indices for 24h quakes beyond the top 10
let rippleColors    = null;  // per-LED color string for current ripple frame
let rippleAnimFrame = null;
let _rippleLastTime  = 0;

let recentSeismicMode   = 'off'; // 'off' | 'epicenter' | 'epicenter+info'
let recentSeismicQuakes = [];   // [{lat,lon,mag,place,time,ledIdx}] within last hour
let recentSeismicLedSet = new Set();
const RECENT_WINDOW_MS  = 3600000; // 1 hour in ms

// ---- Sub-effects (random mode) ----
let subEffect          = 'classic';
let subEffectAnimFrame = null;
let subEffectPhase     = 0;
let subEffectLastTime  = 0;
let twinkleLevels      = null;
let twinkleTargets     = null;
let rainbowHues        = null;  // per-LED hue (0–1) for rainbow mode
let rainbowSpeeds      = null;  // per-LED drift speed
let randomRipples      = null;  // Array of random ripple objects for ripple sub-effect

function hslToRgbStr(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const bl = brightnessLevel;
  return `rgb(${Math.round(f(0)*255*bl)},${Math.round(f(8)*255*bl)},${Math.round(f(4)*255*bl)})`;
}

function getSubEffectColor(idx) {
  const lm = isLightMode ? lightModeFactor(ledColor) : 1.0;
  if (subEffect === 'pulse') {
    const b = 0.15 + 0.85 * (Math.sin(subEffectPhase) * 0.5 + 0.5);
    return applyBrightness(ledColor, b * lm);
  }
  if (subEffect === 'wave') {
    const col = idx % COLS;
    const b = 0.1 + 0.9 * (Math.sin(col / COLS * Math.PI * 4 - subEffectPhase) * 0.5 + 0.5);
    return applyBrightness(ledColor, b * lm);
  }
  if (subEffect === 'rainbow') {
    const hue = rainbowHues ? rainbowHues[idx] : Math.random();
    // In light mode use L=0.4 for vivid hues that pop against the pale background
    return hslToRgbStr(hue, 1, isLightMode ? 0.4 : 0.55);
  }
  if (subEffect === 'twinkle') {
    const b = twinkleLevels ? (twinkleLevels[idx] || 0.1) : 1.0;
    return applyBrightness(ledColor, b * lm);
  }
  if (subEffect === 'ripple') {
    if (!randomRipples) return getOffColor();
    let maxI = 0;
    const col = idx % COLS, row = (idx / COLS) | 0;
    const now = performance.now();
    for (const rp of randomRipples) {
      const elapsed = now - rp.born;
      if (elapsed < 0) continue; // not yet born
      const t      = elapsed / rp.period;
      const radius = t * rp.maxRadius;
      const dist   = Math.sqrt((col - rp.col) ** 2 + (row - rp.row) ** 2);
      const diff   = Math.abs(dist - radius);
      if (diff < 2.5) {
        const v = (1 - diff / 2.5) * Math.pow(1 - t, 0.65);
        if (v > maxI) maxI = v;
      }
    }
    return maxI > 0.03 ? applyBrightness(ledColor, maxI * lm) : getOffColor();
  }
  return getLedColor();
}

function tickSubEffect(ts) {
  if (dataSource !== 'random') return;
  if (subEffect === 'classic') return;
  // Cap to ~30fps — halves CPU/GPU cost for animated sub-effects
  if (subEffectLastTime && ts - subEffectLastTime < 33) {
    subEffectAnimFrame = requestAnimationFrame(tickSubEffect);
    return;
  }
  const dt = subEffectLastTime ? Math.min(ts - subEffectLastTime, 50) : 16;
  subEffectLastTime = ts;
  if (subEffect === 'pulse')   subEffectPhase += dt * 0.0012;
  if (subEffect === 'wave')    subEffectPhase += dt * 0.0025;
  if (subEffect === 'rainbow') {
    if (!rainbowHues || rainbowHues.length !== TOTAL) {
      rainbowHues  = new Float32Array(TOTAL).map(() => Math.random());
      rainbowSpeeds = new Float32Array(TOTAL).map(() => (Math.random() * 0.6 + 0.2) * (Math.random() < 0.5 ? 1 : -1));
    }
    const step = dt * 0.00008;
    for (let i = 0; i < TOTAL; i++) {
      rainbowHues[i] = (rainbowHues[i] + rainbowSpeeds[i] * step + 1) % 1;
    }
  }
  if (subEffect === 'twinkle') {
    if (!twinkleLevels || twinkleLevels.length !== TOTAL) {
      twinkleLevels  = new Float32Array(TOTAL).fill(1);
      twinkleTargets = new Float32Array(TOTAL).fill(1);
    }
    for (let i = 0; i < TOTAL; i++) {
      if (Math.random() < 0.015) twinkleTargets[i] = 0.05 + Math.random() * 0.95;
      twinkleLevels[i] += (twinkleTargets[i] - twinkleLevels[i]) * 0.07;
    }
  }
  if (subEffect === 'ripple') {
    if (!randomRipples) randomRipples = [];
    const now = performance.now();
    // Respawn completed ripples
    randomRipples = randomRipples.filter(rp => (now - rp.born) < rp.period * 1.05);
    let spawnDelay = 0;
    while (randomRipples.length < 6) {
      const period = 2400 + Math.random() * 2000;
      randomRipples.push({
        col:       (Math.random() * COLS) | 0,
        row:       (Math.random() * ROWS) | 0,
        maxRadius: 4 + Math.random() * Math.min(COLS, ROWS) * 0.35,
        period,
        born:      now + spawnDelay  // stagger future starts so each begins from center
      });
      spawnDelay += 650;
    }
  }
  drawAll();
  subEffectAnimFrame = requestAnimationFrame(tickSubEffect);
}

function startSubEffect() {
  if (subEffectAnimFrame) { cancelAnimationFrame(subEffectAnimFrame); subEffectAnimFrame = null; }
  subEffectPhase = 0; subEffectLastTime = 0;
  twinkleLevels = null; twinkleTargets = null;
  rainbowHues = null; rainbowSpeeds = null;
  randomRipples = null;
  if (subEffect !== 'classic') subEffectAnimFrame = requestAnimationFrame(tickSubEffect);
}

function stopSubEffect() {
  if (subEffectAnimFrame) { cancelAnimationFrame(subEffectAnimFrame); subEffectAnimFrame = null; }
  twinkleLevels = null; twinkleTargets = null;
  rainbowHues = null; rainbowSpeeds = null;
  randomRipples = null;
}

// ---- Recent Seismic helpers ----
function getRecentHighlightColor() {
  // Always white; fall back to red when the LED color is white
  return ledColor.toLowerCase() === '#ffffff' ? '#ff4d4d' : '#ffffff';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateSeismicInfoOverlay() {
  const el = document.getElementById('seismic-info-overlay');
  if (!el) return;
  if (recentSeismicMode !== 'epicenter+info' || recentSeismicQuakes.length === 0) {
    el.style.display = 'none';
    return;
  }
  const hColor = getRecentHighlightColor();
  const glowRGB = hColor === '#ff4d4d' ? '255,77,77' : '255,255,255';
  el.style.display = 'flex';
  const items = recentSeismicQuakes.slice(0, 4);
  el.innerHTML = items.map((q, i) => {
    const d = new Date(q.time);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const timeStr = `${hh}:${mm}:${ss} UTC`;
    const op = (1 - i * 0.18).toFixed(2);
    return `<div class="seismic-info-item" style="opacity:${op}">
      <span class="seismic-info-place" style="color:${hColor};text-shadow:0 0 8px rgba(${glowRGB},0.7),0 0 22px rgba(${glowRGB},0.35)">${escapeHtml(q.place)}</span>
      <span class="seismic-info-time" style="color:rgba(255,255,255,0.55)">${timeStr}</span>
    </div>`;
  }).join('');
}

// ---- Day/Night ----
let landPixelData  = null; // Uint8ClampedArray of filled-land canvas (for hit testing)
let landCanvasW    = 0, landCanvasH = 0;
let daynightColors = null; // per-LED color strings (only in daynight mode)
let daynightTimer  = null; // setInterval for clock + redraw
const daynightTimeEl = document.getElementById('daynight-time');
const daynightTimeRow = document.getElementById('daynight-time-row');

// Build filled-land pixel cache for land/ocean testing
function buildLandPixelData() {
  if (!worldGeo) return;
  const lc = document.createElement('canvas');
  lc.width = CW; lc.height = CH;
  landCanvasW = lc.width;  landCanvasH = lc.height;
  const lctx = lc.getContext('2d');
  lctx.fillStyle = '#000';
  lctx.fillRect(0, 0, lc.width, lc.height);
  lctx.fillStyle = '#fff';
  worldGeo.features.forEach(f => drawGeoShape(lctx, f.geometry, true));
  landPixelData = lctx.getImageData(0, 0, lc.width, lc.height).data;
}

function isOnLand(idx) {
  if (!landPixelData) return false;
  const [x, y] = dotXY(idx);
  const px = Math.min(landCanvasW - 1, Math.max(0, Math.round(x)));
  const py = Math.min(landCanvasH - 1, Math.max(0, Math.round(y)));
  return landPixelData[(py * landCanvasW + px) * 4] > 128;
}

// Solar elevation angle in degrees for given lat/lon at current UTC time
function solarElevation(lat, lon) {
  const now  = new Date();
  const doy  = Math.floor((now - new Date(now.getUTCFullYear(), 0, 0)) / 86400000);
  const decl = -23.45 * Math.cos((360 / 365) * (doy + 10) * Math.PI / 180);
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const solar_noon = 12 - lon / 15;
  const ha   = (utcH - solar_noon) * 15; // hour angle in degrees
  const latR = lat  * Math.PI / 180;
  const decR = decl * Math.PI / 180;
  const haR  = ha   * Math.PI / 180;
  return Math.asin(
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR)
  ) * 180 / Math.PI;
}

// LED color from solar elevation (day=white, twilight=amber, night=off)
function daynightLEDColor(elev) {
  if (isLightMode) {
    // Near-white sunlight colors are invisible on the pale bg — render as dark marks.
    // Saturated twilight/night colors stay vivid; they contrast naturally.
    if (elev > 15)  return applyBrightness('#fffde8', 0.18);  // sunlight → dark khaki
    if (elev > 6)   return applyBrightness('#fffde8', 0.13);  // softer sunlight edge
    if (elev > 0)   return applyBrightness('#ffd080', 1.0);   // golden hour — vivid amber
    if (elev > -6)  return applyBrightness('#ff7840', 1.0);   // civil twilight — vivid orange
    if (elev > -12) return applyBrightness('#7030c0', 1.0);   // nautical twilight — vivid purple
    return applyBrightness('#3b0082', 1.0);                    // night — vivid indigo
  }
  if (elev > 15)  return applyBrightness('#fffde8', 1.0);       // direct sunlight — 100%
  if (elev > 6)   return applyBrightness('#fffde8', 0.8);       // white edge near yellow PAR — 70%
  if (elev > 0)   return applyBrightness('#ffd080', 1.0);       // golden hour
  if (elev > -6)  return applyBrightness('#ff7840', 1.0);       // civil twilight
  if (elev > -12) return applyBrightness('#7030c0', 1.0);       // nautical twilight
  return applyBrightness('#3b0082', 1.0);                        // night — indigo
}

function buildDayNightState() {
  if (!landPixelData) return;
  daynightColors = new Array(TOTAL).fill(null);
  litSet.forEach(i => { state[i] = 0; });
  litSet.clear();
  for (let i = 0; i < TOTAL; i++) {
    if (!isOnLand(i)) continue;
    const col = i % COLS, row = (i / COLS) | 0;
    const lon = (col + 0.5) / COLS * 360 - 180;
    const lat = 90 - (row + 0.5) / ROWS * 180;
    const elev  = solarElevation(lat, lon);
    const color = daynightLEDColor(elev);
    daynightColors[i] = color;
    if (color) { state[i] = 1; litSet.add(i); }
  }
  TARGET_ON = litSet.size;
  drawAll();
}

function tickDayNight() {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2,'0');
  const m = String(now.getUTCMinutes()).padStart(2,'0');
  const s = String(now.getUTCSeconds()).padStart(2,'0');
  daynightTimeEl.textContent = `${h}:${m}:${s}`;
  // Rebuild solar state every 10 minutes
  if (now.getUTCSeconds() === 0 && now.getUTCMinutes() % 10 === 0) buildDayNightState();
}

function geoProject(lon, lat) {
  return [
    ((lon + 180) / 360) * CW,
    ((90  - lat) / 180) * CH
  ];
}

function drawGeoShape(targetCtx, geometry, filled) {
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates.flat(1)
      : [];
  rings.forEach(ring => {
    targetCtx.beginPath();
    let prevLon = null;
    let hadJump = false;
    ring.forEach(([lon, lat]) => {
      const jump = prevLon !== null && Math.abs(lon - prevLon) > 180;
      if (jump) hadJump = true;
      const [x, y] = geoProject(lon, lat);
      jump || prevLon === null ? targetCtx.moveTo(x, y) : targetCtx.lineTo(x, y);
      prevLon = lon;
    });
    if (!hadJump) targetCtx.closePath();
    filled ? targetCtx.fill() : targetCtx.stroke();
  });
}

function buildOutlineCanvas() {
  if (!worldGeo) return;
  outlineCanvas = document.createElement('canvas');
  outlineCanvas.width  = CW;
  outlineCanvas.height = CH;
  const oc = outlineCanvas.getContext('2d');
  oc.clearRect(0, 0, outlineCanvas.width, outlineCanvas.height);
  oc.strokeStyle = isLightMode ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.22)';
  oc.lineWidth   = 0.6;
  worldGeo.features.forEach(f => drawGeoShape(oc, f.geometry, false));
}

async function loadWorldMap() {
  try {
    const topo = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json());
    worldGeo = topojson.feature(topo, topo.objects.land);
    buildOutlineCanvas();
    buildLandPixelData();
    if (dataSource === 'daynight') buildDayNightState();
  } catch { /* silently skip if offline */ }
}

// Map a geographic coordinate to the nearest LED index
function geoToLedIdx(lat, lon) {
  const [x, y] = geoProject(lon, lat);
  const col = Math.min(COLS - 1, Math.max(0, Math.round(x / SPACING - 0.5)));
  const row = Math.min(ROWS - 1, Math.max(0, Math.round(y / SPACING - 0.5)));
  return row * COLS + col;
}

// Build ripple objects from a list of {lat, lon, mag} quake objects
function buildSeismicRipples(quakes) {
  const sorted = quakes.slice().sort((a, b) => b.mag - a.mag);
  const top    = sorted.slice(0, 10);  // only top 10 get animated ripples
  const rest   = sorted.slice(10);     // older/smaller quakes become static dots
  seismicStaticDots = new Set(rest.map(({ lat, lon }) => geoToLedIdx(lat, lon)));
  seismicRipples = top.map(({ lat, lon, mag }) => {
    const [x, y] = geoProject(lon, lat);
    const col = Math.min(COLS - 1, Math.max(0, (x / SPACING - 0.5) | 0));
    const row = Math.min(ROWS - 1, Math.max(0, (y / SPACING - 0.5) | 0));
    const maxRadius = Math.max(3, mag * 2.2);
    const period    = 2800 + mag * 360; // larger quakes pulse slower
    const offset    = Math.random() * period;
    return { col, row, maxRadius, period, offset };
  });
  state.fill(0); litSet.clear();
  if (!rippleAnimFrame) tickRipple();
}

function tickRipple(ts) {
  if (dataSource !== 'seismic' || !seismicRipples) return;
  // Cap to ~30fps — halves CPU/GPU cost for seismic ripple animation
  if (_rippleLastTime && ts - _rippleLastTime < 33) {
    rippleAnimFrame = requestAnimationFrame(tickRipple);
    return;
  }
  _rippleLastTime = ts;
  const now = performance.now();
  const intensity = new Float32Array(TOTAL);

  for (const rp of seismicRipples) {
    const t         = ((now + rp.offset) % rp.period) / rp.period; // 0→1 within cycle
    const radius    = t * rp.maxRadius;
    const bandwidth = 1.5;
    const fade      = Math.pow(1 - t, 0.65); // ring fades as it expands

    const rMin = Math.max(0, Math.ceil(rp.row  - rp.maxRadius - 2));
    const rMax = Math.min(ROWS - 1, Math.floor(rp.row  + rp.maxRadius + 2));
    const cMin = Math.max(0, Math.ceil(rp.col  - rp.maxRadius - 2));
    const cMax = Math.min(COLS - 1, Math.floor(rp.col  + rp.maxRadius + 2));

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const dist = Math.sqrt((c - rp.col) ** 2 + (r - rp.row) ** 2);
        const diff = Math.abs(dist - radius);
        if (diff < bandwidth) {
          const v = (1 - diff / bandwidth) * fade;
          const idx = r * COLS + c;
          if (v > intensity[idx]) intensity[idx] = v;
        }
      }
    }
  }

  rippleColors = new Array(TOTAL).fill(null);
  for (let i = 0; i < TOTAL; i++) {
    if (intensity[i] > 0.03) {
      rippleColors[i] = applyBrightness(ledColor, intensity[i] * (isLightMode ? lightModeFactor(ledColor) : 1.0));
    }
  }

  // Static dots for 24h quakes that are not in the top-10 animated set
  if (seismicStaticDots && seismicStaticDots.size > 0) {
    const lm = isLightMode ? lightModeFactor(ledColor) : 1.0;
    const dotColor = applyBrightness(ledColor, 0.3 * lm);
    for (const idx of seismicStaticDots) {
      if (idx >= 0 && idx < TOTAL && !rippleColors[idx]) rippleColors[idx] = dotColor;
    }
  }

  // Overlay recent epicentres with highlight color
  if (recentSeismicMode !== 'off' && recentSeismicLedSet.size > 0) {
    const hColor = getRecentHighlightColor();
    const hStr   = applyBrightness(hColor, isLightMode ? lightModeFactor(hColor) : 1.0);
    for (const idx of recentSeismicLedSet) {
      if (idx >= 0 && idx < TOTAL) rippleColors[idx] = hStr;
    }
  }

  drawAll();
  rippleAnimFrame = requestAnimationFrame(tickRipple);
}

let COLS, ROWS, TOTAL;

function resize() {
  DPR = window.devicePixelRatio || 1;
  CW  = window.innerWidth;
  CH  = window.innerHeight;
  canvas.width  = CW * DPR;
  canvas.height = CH * DPR;
  canvas.style.width  = CW + 'px';
  canvas.style.height = CH + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  COLS  = Math.floor(CW / SPACING);
  ROWS  = Math.floor(CH / SPACING);
  TOTAL = COLS * ROWS;
  buildOutlineCanvas();
  buildLandPixelData();
  init();
}

let state, litSet, TARGET_ON;
let TARGET_RATIO = 0.03;

function init() {
  state     = new Uint8Array(TOTAL);
  litSet    = new Set();
  TARGET_ON = Math.floor(TOTAL * TARGET_RATIO);
  for (let i = 0; i < TARGET_ON; i++) turnOnRandom();
  drawAll();
}

function turnOnRandom() {
  if (seismicPool) {
    if (litSet.size >= seismicPool.size) return;
    const candidates = [...seismicPool].filter(i => state[i] === 0);
    if (!candidates.length) return;
    const idx = candidates[(Math.random() * candidates.length) | 0];
    state[idx] = 1; litSet.add(idx);
  } else {
    if (litSet.size >= TOTAL) return;
    let idx;
    do { idx = (Math.random() * TOTAL) | 0; } while (state[idx] !== 0);
    state[idx] = 1; litSet.add(idx);
  }
}

function dotXY(idx) {
  const col = idx % COLS;
  const row = (idx / COLS) | 0;
  // Snap to physical pixel boundaries to prevent sub-pixel antialiasing blur
  const x = Math.round((col + 0.5) * SPACING * DPR) / DPR;
  const y = Math.round((row + 0.5) * SPACING * DPR) / DPR;
  return [x, y];
}

function drawDot(idx) {
  const [x, y] = dotXY(idx);
  ctx.beginPath();
  ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
  if (dataSource === 'daynight' && daynightColors) {
    ctx.fillStyle = daynightColors[idx] || getOffColor();
  } else if (dataSource === 'seismic' && rippleColors) {
    ctx.fillStyle = rippleColors[idx] || getOffColor();
  } else if (state[idx] && subEffect !== 'classic') {
    ctx.fillStyle = getSubEffectColor(idx);
  } else {
    ctx.fillStyle = state[idx] ? getLedColor() : getOffColor();
  }
  ctx.fill();
}

function drawAll() {
  ctx.fillStyle = getBgColor();
  ctx.fillRect(0, 0, CW, CH);
  if (dataSource === 'random' && subEffect === 'classic') {
    // Batch all off-LEDs in one path, all on-LEDs in another — reduces GPU submissions
    // from ~14k fill() calls down to just 2, which is dramatically faster.
    ctx.fillStyle = getOffColor();
    ctx.beginPath();
    for (let i = 0; i < TOTAL; i++) {
      if (!state[i]) {
        const [x, y] = dotXY(i);
        ctx.moveTo(x + RADIUS, y);
        ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    if (litSet.size > 0) {
      ctx.fillStyle = getLedColor();
      ctx.beginPath();
      for (const i of litSet) {
        const [x, y] = dotXY(i);
        ctx.moveTo(x + RADIUS, y);
        ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  } else {
    for (let i = 0; i < TOTAL; i++) drawDot(i);
  }
  if ((dataSource === 'seismic' || dataSource === 'daynight') && outlineCanvas && showMapOutline) {
    ctx.drawImage(outlineCanvas, 0, 0);
  }
}

const dirty = new Set();

function flicker() {
  const delta = Math.abs(litSet.size - TARGET_ON);
  const changes = Math.min(Math.max(4, delta >> 3), 300);
  for (let c = 0; c < changes; c++) {
    if (litSet.size < TARGET_ON) {
      const prev = litSet.size;
      turnOnRandom();
      if (litSet.size > prev) dirty.add([...litSet][litSet.size - 1]);
    } else if (litSet.size > TARGET_ON || Math.random() < 0.5) {
      if (litSet.size > 0) {
        const arr = [...litSet];
        const idx = arr[(Math.random() * arr.length) | 0];
        dirty.add(idx); state[idx] = 0; litSet.delete(idx);
      }
    } else {
      if (litSet.size > 0) {
        const arr = [...litSet];
        const offIdx = arr[(Math.random() * arr.length) | 0];
        dirty.add(offIdx); state[offIdx] = 0; litSet.delete(offIdx);
      }
      // swap: turn on one from the correct pool
      if (seismicPool) {
        const candidates = [...seismicPool].filter(i => state[i] === 0);
        if (candidates.length) {
          const idx = candidates[(Math.random() * candidates.length) | 0];
          state[idx] = 1; litSet.add(idx); dirty.add(idx);
        }
      } else {
        let idx;
        do { idx = (Math.random() * TOTAL) | 0; } while (state[idx] !== 0);
        state[idx] = 1; litSet.add(idx); dirty.add(idx);
      }
    }
  }
  for (const idx of dirty) {
    const [x, y] = dotXY(idx);
    const r = RADIUS + 1;
    ctx.fillStyle = getBgColor();
    ctx.fillRect(x - r, y - r, r * 2, r * 2); // CSS coords — correct after setTransform
    drawDot(idx);
  }
  dirty.clear();
}

// ---- Settings ----
const settingsBtn   = document.getElementById('settings-btn');
const infoBtn       = document.getElementById('info-btn');
const infoModal     = document.getElementById('info-modal');
const settingsPanel = document.getElementById('settings-panel');
const densitySlider  = document.getElementById('density-slider');
const densityValEl   = document.getElementById('density-val');
const coverageSlider = document.getElementById('coverage-slider');
const coverageValEl  = document.getElementById('coverage-val');
const modeToggle     = document.getElementById('mode-toggle');
let panelOpen = false;

const fullscreenBtn = document.getElementById('fullscreen-btn');
const fsExpand   = document.getElementById('fs-expand');
const fsCollapse = document.getElementById('fs-collapse');

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function updateFsIcon() {
  const fs = isFullscreen();
  fsExpand.style.display   = fs ? 'none'  : '';
  fsCollapse.style.display = fs ? ''      : 'none';
}

fullscreenBtn.addEventListener('click', () => {
  if (!isFullscreen()) {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
});

document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);

document.addEventListener('mousemove', (e) => {
  const rs = settingsBtn.getBoundingClientRect();
  const rf = fullscreenBtn.getBoundingClientRect();
  const ri = infoBtn.getBoundingClientRect();
  const distS = Math.hypot(e.clientX - (rs.left + rs.width / 2), e.clientY - (rs.top + rs.height / 2));
  const distF = Math.hypot(e.clientX - (rf.left + rf.width / 2), e.clientY - (rf.top + rf.height / 2));
  const distI = Math.hypot(e.clientX - (ri.left + ri.width / 2), e.clientY - (ri.top + ri.height / 2));
  const nearTop = panelOpen || distS < 160 || distF < 160;
  const nearInfo = infoOpen || distI < 160;
  settingsBtn.classList.toggle('near', nearTop);
  fullscreenBtn.classList.toggle('near', nearTop);
  infoBtn.classList.toggle('near', nearInfo);
});

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  panelOpen ? closePanel() : openPanel();
});

function openPanel() {
  panelOpen = true;
  settingsPanel.classList.remove('closing');
  settingsPanel.classList.add('open');
  settingsBtn.classList.add('near');
  fullscreenBtn.classList.add('near');
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  settingsPanel.classList.add('closing');
  settingsPanel.addEventListener('animationend', () => {
    settingsPanel.classList.remove('open', 'closing');
  }, { once: true });
}

let infoOpen = false;

function openInfoModal() {
  infoOpen = true;
  infoModal.classList.remove('closing');
  infoModal.classList.add('open');
  infoBtn.classList.add('near');
}

function closeInfoModal() {
  if (!infoOpen) return;
  infoOpen = false;
  infoModal.classList.add('closing');
  infoModal.addEventListener('animationend', () => {
    infoModal.classList.remove('open', 'closing');
  }, { once: true });
}

document.addEventListener('click', (e) => {
  if (panelOpen && !settingsPanel.contains(e.target) && e.target !== settingsBtn) closePanel();
  if (infoOpen && !infoModal.contains(e.target) && e.target !== infoBtn) closeInfoModal();
  if (!e.target.closest('.source-cat-wrap')) {
    document.querySelectorAll('.source-cat-wrap').forEach(w => w.classList.remove('open'));
  }
});

infoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  infoOpen ? closeInfoModal() : openInfoModal();
});

densitySlider.addEventListener('input', () => {
  const lpi = parseInt(densitySlider.value);
  densityValEl.textContent = lpi + ' /in';
  SPACING = Math.max(5, Math.round(96 / lpi));
  resize();
});

coverageSlider.addEventListener('input', () => {
  const pct = parseInt(coverageSlider.value);
  coverageValEl.textContent = pct + '%';
  TARGET_RATIO = pct / 100;
  TARGET_ON = Math.floor(TOTAL * TARGET_RATIO);
});

modeToggle.addEventListener('click', () => {
  isLightMode = !isLightMode;
  modeToggle.classList.toggle('active', isLightMode);
  document.body.classList.toggle('light-mode', isLightMode);
  buildOutlineCanvas();
  drawAll();
});

const speedSlider = document.getElementById('speed-slider');
const speedValEl  = document.getElementById('speed-val');

const SPEED_MAP    = [20, 50, 80, 160, 320];
const SPEED_LABELS = ['Fast', 'Faster', 'Normal', 'Slower', 'Slow'];
let flickerInterval = SPEED_MAP[2];
let flickerTimer = null;

function startFlicker() {
  if (flickerTimer) clearInterval(flickerTimer);
  flickerTimer = setInterval(flicker, flickerInterval);
}

speedSlider.addEventListener('input', () => {
  const idx = parseInt(speedSlider.value) - 1;
  flickerInterval = SPEED_MAP[idx];
  speedValEl.textContent = SPEED_LABELS[idx];
  startFlicker();
});

// ---- Brightness ----
const brightnessSlider = document.getElementById('brightness-slider');
const brightnessValEl  = document.getElementById('brightness-val');

brightnessSlider.addEventListener('input', () => {
  brightnessLevel = parseInt(brightnessSlider.value) / 100;
  brightnessValEl.textContent = brightnessSlider.value + '%';
  drawAll();
});

// ---- Color grid ----
const colorSwatches = document.querySelectorAll('.color-swatch');
colorSwatches.forEach(swatch => {
  swatch.addEventListener('click', () => {
    colorSwatches.forEach(s => s.classList.remove('selected'));
    swatch.classList.add('selected');
    ledColor = swatch.dataset.color;
    drawAll();
    if (dataSource === 'seismic') updateSeismicInfoOverlay();
  });
});

// ---- Map outline toggle ----
const mapToggle    = document.getElementById('map-toggle');
const mapToggleRow = document.getElementById('map-toggle-row');
const recentSeismicToggleRow = document.getElementById('recent-seismic-toggle-row');
const recentSeismicSelect    = document.getElementById('recent-seismic-select');

mapToggle.addEventListener('click', () => {
  showMapOutline = !showMapOutline;
  mapToggle.classList.toggle('active', showMapOutline);
  drawAll();
});

recentSeismicSelect.addEventListener('change', () => {
  recentSeismicMode = recentSeismicSelect.value;
  updateSeismicInfoOverlay();
});

// ---- Data Source ----
const sourceStatusEl = document.getElementById('source-status');
const sourceCatBtns  = document.querySelectorAll('.source-cat-btn');
const sourceSubBtns  = document.querySelectorAll('.source-sub-btn');
let dataSource    = 'random';
let dataFetchTimer = null;
let micStream     = null;
let micAudioCtx   = null;
let micAnalyser   = null;
let micAnimFrame  = null;

function setSourceStatus(text) { sourceStatusEl.textContent = text; }

function stopDataSource() {
  if (dataFetchTimer)  { clearInterval(dataFetchTimer); dataFetchTimer = null; }
  if (daynightTimer)   { clearInterval(daynightTimer); daynightTimer = null; }
  if (flickerTimer)    { clearInterval(flickerTimer); flickerTimer = null; }
  if (rippleAnimFrame) { cancelAnimationFrame(rippleAnimFrame); rippleAnimFrame = null; }
  _rippleLastTime = 0;
  if (micAnimFrame)    { cancelAnimationFrame(micAnimFrame); micAnimFrame = null; }
  if (micStream)       { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (micAudioCtx)     { micAudioCtx.close(); micAudioCtx = null; }
  micAnalyser    = null;
  seismicPool       = null;
  seismicRipples    = null;
  seismicStaticDots = null;
  rippleColors      = null;
  daynightColors = null;
  recentSeismicQuakes = [];
  recentSeismicLedSet = new Set();
  updateSeismicInfoOverlay();
  stopSubEffect();
  setSourceStatus('');
}

function applySourceColor(hex) {
  ledColor = hex;
  colorSwatches.forEach(s => s.classList.remove('selected'));
  const m = document.querySelector(`.color-swatch[data-color="${hex}"]`);
  if (m) m.classList.add('selected');
  drawAll();
}

function applySourceCoverage(ratio) {
  TARGET_RATIO = Math.min(0.90, Math.max(0.01, ratio));
  TARGET_ON    = Math.floor(TOTAL * TARGET_RATIO);
  const pct    = Math.round(TARGET_RATIO * 100);
  coverageSlider.value    = Math.min(90, Math.max(1, pct));
  coverageValEl.textContent = pct + '%';
}

function applySourceSpeed(idx) {
  idx = Math.max(0, Math.min(4, idx));
  flickerInterval = SPEED_MAP[idx];
  speedSlider.value       = idx + 1;
  speedValEl.textContent  = SPEED_LABELS[idx];
  startFlicker();
}

// — Seismic via USGS (no key, CORS open) — last 24 hours —
async function fetchSeismic() {
  try {
    const data   = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson').then(r => r.json());
    const quakes = data.features.filter(q => (q.properties.mag || 0) >= 1.5);
    const count  = quakes.length;
    const maxMag = count > 0 ? Math.max(...quakes.map(q => q.properties.mag || 0)) : 0;
    const mapped = quakes.map(q => ({
      lat: q.geometry.coordinates[1],
      lon: q.geometry.coordinates[0],
      mag: q.properties.mag || 1.5
    }));

    // Collect recent quakes (last hour) with display info
    const now = Date.now();
    recentSeismicQuakes = quakes
      .filter(q => (now - q.properties.time) < RECENT_WINDOW_MS)
      .map(q => ({
        lat:    q.geometry.coordinates[1],
        lon:    q.geometry.coordinates[0],
        mag:    q.properties.mag || 1.5,
        place:  q.properties.place || 'Unknown location',
        time:   q.properties.time,
        ledIdx: geoToLedIdx(q.geometry.coordinates[1], q.geometry.coordinates[0])
      }))
      .sort((a, b) => b.time - a.time);
    recentSeismicLedSet = new Set(recentSeismicQuakes.map(q => q.ledIdx));
    updateSeismicInfoOverlay();

    buildSeismicRipples(mapped);
    setSourceStatus(`${count} quake${count !== 1 ? 's' : ''} · M${maxMag.toFixed(1)} max (24h)`);
  } catch { setSourceStatus('unavailable'); }
}

// — Microphone via Web Audio API —
async function startMic() {
  try {
    micStream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src   = micAudioCtx.createMediaStreamSource(micStream);
    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    src.connect(micAnalyser);
    const buf = new Uint8Array(micAnalyser.frequencyBinCount);
    function tick() {
      if (dataSource !== 'mic') return;
      micAnalyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      applySourceCoverage(0.01 + (avg / 255) * 0.89);
      setSourceStatus(`lvl ${Math.round(avg)}`);
      micAnimFrame = requestAnimationFrame(tick);
    }
    tick();
  } catch {
    setSourceStatus('mic denied');
    activateSource('random');
  }
}

const DATA_FETCHERS = { seismic: fetchSeismic };

function setGeoSlidersDisabled(disabled) {
  densitySlider.disabled  = disabled;
  coverageSlider.disabled = disabled;
  speedSlider.disabled    = disabled;
  densitySlider.closest('.setting-group').classList.toggle('disabled-row', disabled);
  coverageSlider.closest('.setting-group').classList.toggle('disabled-row', disabled);
  speedSlider.closest('.setting-group').classList.toggle('disabled-row', disabled);
}

const lightModeRow = document.getElementById('light-mode-row');

function setLightModeDisabled(disabled) {
  lightModeRow.classList.toggle('disabled-row', disabled);
  modeToggle.style.pointerEvents = disabled ? 'none' : '';
  if (disabled && isLightMode) {
    isLightMode = false;
    modeToggle.classList.remove('active');
    document.body.classList.remove('light-mode');
    buildOutlineCanvas();
    drawAll();
  }
}

function activateSource(src) {
  stopDataSource();
  dataSource = src;
  const cat = categoryForSource(src);
  sourceCatBtns.forEach(b => b.classList.toggle('active', b.dataset.category === cat));
  sourceSubBtns.forEach(b => {
    const isActive = src === 'random'
      ? (b.dataset.source === 'random' && b.dataset.effect === subEffect)
      : b.dataset.source === src;
    b.classList.toggle('active', isActive);
  });
  mapToggleRow.style.display          = (src === 'seismic' || src === 'daynight') ? 'flex' : 'none';
  recentSeismicToggleRow.style.display = src === 'seismic' ? 'flex' : 'none';
  daynightTimeRow.style.display        = src === 'daynight' ? 'flex' : 'none';
  if (src === 'seismic' || src === 'daynight') {
    showMapOutline = src === 'seismic';
    mapToggle.classList.toggle('active', showMapOutline);
  }
  setGeoSlidersDisabled(src === 'seismic' || src === 'daynight');
  setSolarControlsDisabled(src === 'daynight');
  setLightModeDisabled(src === 'seismic' || src === 'daynight');
  if (src === 'random' || src === 'mic') {
    // clear geo-shaped state so flicker redistributes from scratch
    state.fill(0);
    litSet.clear();
    TARGET_ON = Math.floor(TOTAL * TARGET_RATIO);
  }
  if (src === 'random') { startFlicker(); startSubEffect(); drawAll(); return; }
  if (src === 'mic') { startFlicker(); setSourceStatus('listening…'); startMic(); drawAll(); return; }
  if (src === 'daynight') {
    tickDayNight();
    buildDayNightState();
    daynightTimer = setInterval(tickDayNight, 1000);
    return;
  }
  setSourceStatus('fetching…');
  DATA_FETCHERS[src]();
  dataFetchTimer = setInterval(DATA_FETCHERS[src], 180000);
}

function categoryForSource(src) {
  if (src === 'random') return 'matrix';
  if (src === 'seismic' || src === 'daynight') return 'world';
  return 'others';
}

sourceCatBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = btn.closest('.source-cat-wrap');
    const isOpen = wrap.classList.contains('open');
    document.querySelectorAll('.source-cat-wrap').forEach(w => w.classList.remove('open'));
    if (!isOpen) wrap.classList.add('open');
  });
});

sourceSubBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const src = btn.dataset.source;
    const effect = btn.dataset.effect;
    if (effect) {
      if (dataSource !== 'random') activateSource('random');
      subEffect = effect;
      setColorGroupDisabled(subEffect === 'rainbow');
      sourceSubBtns.forEach(b => b.classList.toggle('active', b === btn));
      startSubEffect();
      if (subEffect === 'classic') drawAll();
    } else {
      activateSource(src);
    }
    document.querySelectorAll('.source-cat-wrap').forEach(w => w.classList.remove('open'));
  });
});

const colorGroup      = document.getElementById('color-group');

function setColorGroupDisabled(disabled) {
  colorGroup.classList.toggle('disabled-row', disabled);
  colorGroup.querySelectorAll('.color-swatch').forEach(s => s.disabled = disabled);
}

const brightnessGroup = brightnessSlider.closest('.setting-group');
function setSolarControlsDisabled(disabled) {
  brightnessSlider.disabled = disabled;
  brightnessGroup.classList.toggle('disabled-row', disabled);
  setColorGroupDisabled(disabled);
}

function resetToDefaults() {
  densitySlider.value = 8;
  densityValEl.textContent = '8 /in';
  SPACING = Math.max(5, Math.round(96 / 8));

  coverageSlider.value = 3;
  coverageValEl.textContent = '3%';
  TARGET_RATIO = 0.03;

  speedSlider.value = 3;
  speedValEl.textContent = 'Normal';
  flickerInterval = SPEED_MAP[2];

  isLightMode = false;
  modeToggle.classList.remove('active');
  document.body.classList.remove('light-mode');

  ledColor = '#ffffff';
  colorSwatches.forEach(s => s.classList.remove('selected'));
  document.querySelector('.color-swatch[data-color="#ffffff"]').classList.add('selected');

  brightnessLevel = 1.0;
  brightnessSlider.value = 100;
  brightnessValEl.textContent = '100%';

  stopDataSource();
  dataSource = 'random';
  subEffect = 'classic';
  sourceCatBtns.forEach(b => b.classList.toggle('active', b.dataset.category === 'matrix'));
  document.querySelectorAll('.source-cat-wrap').forEach(w => w.classList.remove('open'));
  sourceSubBtns.forEach(b => b.classList.toggle('active', b.dataset.effect === 'classic'));
  showMapOutline = false;
  mapToggle.classList.remove('active');
  mapToggleRow.style.display = 'none';
  recentSeismicMode = 'off';
  if (recentSeismicSelect) recentSeismicSelect.value = 'off';
  recentSeismicToggleRow.style.display = 'none';
  recentSeismicQuakes = [];
  recentSeismicLedSet = new Set();
  daynightTimeRow.style.display = 'none';
  setGeoSlidersDisabled(false);
  setSolarControlsDisabled(false);
  setColorGroupDisabled(false);
  setLightModeDisabled(false);

  resize();
  startFlicker();
}

document.getElementById('reset-btn').addEventListener('click', resetToDefaults);

// ---- Favicon flicker ----
(function() {
  const fc = document.createElement('canvas');
  fc.width = fc.height = 32;
  const fctx = fc.getContext('2d');
  const faviconEl = document.getElementById('favicon');
  let faviconBrightness = 1.0;
  let faviconTarget = 1.0;
  let faviconTimer = 0;

  function squircle(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function tickFavicon() {
    faviconTimer++;
    if (faviconTimer % 20 === 0) {
      faviconTarget = Math.random() < 0.25 ? 0.08 + Math.random() * 0.25 : 0.8 + Math.random() * 0.2;
    }
    faviconBrightness += (faviconTarget - faviconBrightness) * 0.22;

    const color = ledColor || '#ffffff';
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const f = faviconBrightness;
    const isOn = f > 0.18;

    fctx.clearRect(0, 0, 32, 32);

    // Squircle background
    squircle(fctx, 0, 0, 32, 32, 7);
    fctx.fillStyle = '#2e2e2e';
    fctx.fill();

    if (isOn) {
      // Glow
      const grd = fctx.createRadialGradient(16, 16, 0, 16, 16, 12);
      grd.addColorStop(0, `rgba(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)},${0.4 * f})`);
      grd.addColorStop(1, `rgba(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)},0)`);
      fctx.beginPath();
      fctx.arc(16, 16, 12, 0, Math.PI * 2);
      fctx.fillStyle = grd;
      fctx.fill();
    }

    // Dot — lit color when on, dark gray when off
    fctx.beginPath();
    fctx.arc(16, 16, 5.5, 0, Math.PI * 2);
    fctx.fillStyle = isOn
      ? `rgb(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)})`
      : '#484848';
    fctx.fill();

    faviconEl.href = fc.toDataURL('image/png');
    // Throttle to ~10fps — toDataURL + href DOM update at 60fps is a major CPU drain
    setTimeout(() => requestAnimationFrame(tickFavicon), 100);
  }

  requestAnimationFrame(tickFavicon);
})();

window.addEventListener('resize', resize);

// ---- Wake Lock — keep the screen on while the page is visible ----
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* permission denied or feature unavailable */ }
}

// Re-acquire after the browser releases it (e.g. tab was hidden then re-shown)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (flickerTimer) { clearInterval(flickerTimer); flickerTimer = null; }
  } else {
    if (dataSource === 'random' || dataSource === 'mic') startFlicker();
    if (wakeLock === null || wakeLock.released) requestWakeLock();
  }
});

requestWakeLock();

resetToDefaults();
loadWorldMap();
