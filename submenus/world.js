// ---- World data sources (Seismic, Solar, ISS) ----

// ---- World map ----
// land-data.json is pre-baked by bake_land.py (replaces runtime TopoJSON rasterisation)
let worldGeo        = null;  // GeoJSON FeatureCollection of land (used only for outline canvas)
let outlineCanvas   = null;  // pre-rendered map outline (redrawn on resize)
let _landBits       = null;  // Uint8Array — packed bit-field from land-data.json
let _landW          = 0;     // reference bitmap width
let _landH          = 0;     // reference bitmap height
let seismicPool       = null;  // unused — kept for legacy flicker guard
let seismicRipples    = null;  // Array of active ripple objects (top 10 by recency)
let seismicStaticDots = null;  // Set of LED indices for 24h quakes beyond the top 10
let seismicDotPhases  = null;  // Map<ledIdx, {phase, speed}> for twinkle animation
let rippleColors      = null;  // per-LED color string for current ripple frame
let _lastSeismicData  = null;  // cached raw {lat,lon,mag,time} array for resize rebuild
let rippleAnimFrame = null;
let _rippleLastTime  = 0;

let recentSeismicMode   = 'off'; // 'off' | 'epicenter' | 'epicenter+info'
let recentSeismicQuakes = [];   // [{lat,lon,mag,place,time,ledIdx}] within last hour
let recentSeismicLedSet = new Set();
const RECENT_WINDOW_MS  = 3600000; // 1 hour in ms

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
let daynightColors = null; // per-LED color strings (only in daynight mode)
let daynightTimer  = null; // setInterval for clock + redraw
const daynightTimeEl = document.getElementById('daynight-time');
const daynightTimeRow = document.getElementById('daynight-time-row');

// ---- ISS ----
let issLat = 0, issLon = 0;
let issLedIdx = -1;
let issAnimFrame = null;
let issRippleColors = null;
let _issLastFrameTime = 0;
let issTrail    = [];   // [{lat, lon, ledIdx}] newest first — past positions
let issFuturePath = []; // [{lat, lon, ledIdx}] index 0 = nearest future position
const ISS_TRAIL_MAX    = 16;
const ISS_FUTURE_STEPS = 180;
let issVelocity       = 7.66; // km/s // 180 × 30s = 90 min ≈ full orbit
const issLatLonEl    = document.getElementById('iss-latlon');
const issLocationRow = document.getElementById('iss-location-row');

// ── 3-D spherical helpers for great-circle propagation ──
function _llToVec(lat, lon) {
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}
function _vecToLL(v) {
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180 / Math.PI,
    lon: Math.atan2(v[1], v[0]) * 180 / Math.PI
  };
}
function _dot(a, b)   { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function _cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _norm(v)     { const l = Math.sqrt(v[0]**2+v[1]**2+v[2]**2); return l>0?[v[0]/l,v[1]/l,v[2]/l]:v; }
// Rodrigues' rotation: rotate v by θ around unit axis k
function _rot(v, k, θ) {
  const c = Math.cos(θ), s = Math.sin(θ), d = _dot(k, v), x = _cross(k, v);
  return [v[0]*c + x[0]*s + k[0]*d*(1-c),
          v[1]*c + x[1]*s + k[1]*d*(1-c),
          v[2]*c + x[2]*s + k[2]*d*(1-c)];
}

// Project future ground track as a great-circle arc (proper orbital curve).
function buildISSFuturePath() {
  issFuturePath = [];
  if (issTrail.length === 0) return;

  const v1 = _llToVec(issTrail[0].lat, issTrail[0].lon);

  // θ is ALWAYS derived from velocity, calibrated to a 30-second step.
  // This ensures the path arc is full-orbit-sized from the very first fetch,
  // regardless of how close together consecutive trail samples are in time.
  const R = 6371 + 415; // Earth radius + avg ISS altitude (km)
  const θ = (issVelocity * 30) / R; // radians per 30-second projected step

  let axis;
  if (issTrail.length >= 2) {
    // Use real position delta to determine the orbital plane axis (direction).
    // Even 1-second-apart samples give a valid direction — only θ was unreliable.
    const v0  = _llToVec(issTrail[1].lat, issTrail[1].lon);
    const raw = _norm(_cross(v0, v1));
    axis = (raw[0]===0 && raw[1]===0 && raw[2]===0) ? null : raw;
  }
  if (!axis) {
    // Bootstrap: use ISS inclination (~51.6°) to estimate prograde heading
    const east = _norm(_cross([0, 0, 1], v1));
    const safeEast = (east[0]===0 && east[1]===0 && east[2]===0) ? [0, 1, 0] : east;
    axis = _norm(_rot(safeEast, v1, 51.6 * Math.PI / 180));
  }

  // θ is from the inertial frame; subtract Earth's rotation so projected
  // longitudes track the surface (≈ 0.125° west per 30-second step).
  const EARTH_DEG_PER_STEP = 360 / 86400 * 30;

  let vCurr = v1;
  for (let i = 0; i < ISS_FUTURE_STEPS; i++) {
    vCurr = _rot(vCurr, axis, θ);
    const { lat, lon } = _vecToLL(vCurr);
    let adjLon = lon - (i + 1) * EARTH_DEG_PER_STEP;
    adjLon = ((adjLon + 180) % 360 + 360) % 360 - 180;
    issFuturePath.push({ lat, lon: adjLon, ledIdx: geoToLedIdx(lat, adjLon) });
  }
  // Close the loop back to the ISS's current position
  const cur = issTrail[0];
  issFuturePath.push({ lat: cur.lat, lon: cur.lon, ledIdx: cur.ledIdx });
}

async function fetchISS() {
  try {
    const data = await fetch('https://api.wheretheiss.at/v1/satellites/25544').then(r => r.json());
    issLat = data.latitude;
    issLon = data.longitude;
    const newIdx = geoToLedIdx(issLat, issLon);
    if (issTrail.length === 0 || newIdx !== issTrail[0].ledIdx) {
      issTrail.unshift({ lat: issLat, lon: issLon, ledIdx: newIdx });
      if (issTrail.length > ISS_TRAIL_MAX) issTrail.length = ISS_TRAIL_MAX;
    }
    issLedIdx = newIdx;
    buildISSFuturePath();
    const latStr = (issLat >= 0 ? '+' : '') + issLat.toFixed(2) + '\u00b0';
    const lonStr = (issLon >= 0 ? '+' : '') + issLon.toFixed(2) + '\u00b0';
    const altStr = Math.round(data.altitude) + ' km';
    if (issLatLonEl) issLatLonEl.textContent = `${latStr} ${lonStr}`;
    setSourceStatus(`${latStr} ${lonStr} \u00b7 ${altStr} alt`);
  } catch { setSourceStatus('unavailable'); }
}

function tickISS(ts) {
  if (dataSource !== 'iss') return;
  // Cap to ~30 fps
  if (_issLastFrameTime && ts - _issLastFrameTime < 33) {
    issAnimFrame = requestAnimationFrame(tickISS);
    return;
  }
  _issLastFrameTime = ts;

  issRippleColors = new Array(TOTAL).fill(null);

  // Still waiting for first fetch — show blank grid (map outline visible if on)
  if (issLedIdx < 0 || issLedIdx >= TOTAL) {
    drawAll();
    issAnimFrame = requestAnimationFrame(tickISS);
    return;
  }

  const lm  = isLightMode ? lightModeFactor(ledColor) : 1.0;
  const now = performance.now();
  const N   = issFuturePath.length;

  // ── Past trail: static fading dots behind current position ──
  const trailLen = issTrail.length;
  for (let i = trailLen - 1; i >= 1; i--) {
    const { ledIdx } = issTrail[i];
    if (ledIdx < 0 || ledIdx >= TOTAL) continue;
    const fade = (1 - i / trailLen) * 0.30;
    issRippleColors[ledIdx] = applyBrightness(ledColor, fade * lm);
  }

  if (N > 0) {
    // ── Ghost guide: all future dots dimly visible so you can see the full path ──
    for (let i = 0; i < N; i++) {
      const { ledIdx } = issFuturePath[i];
      if (ledIdx < 0 || ledIdx >= TOTAL) continue;
      const ghost = (1 - i / N) * 0.10;
      issRippleColors[ledIdx] = applyBrightness(ledColor, ghost * lm);
    }

    // ── Snake: a bright body travels from current pos → end of path, loops ──
    // headPos travels 0 → N continuously over PERIOD ms
    const PERIOD    = 10000; // 10 s to traverse the full ~90-min arc
    const BODY_SIZE = 14.0;  // tail length in path-steps
    const headPos   = ((now % PERIOD) / PERIOD) * N;

    for (let i = 0; i < N; i++) {
      const { ledIdx } = issFuturePath[i];
      if (ledIdx < 0 || ledIdx >= TOTAL) continue;
      const ahead  = i - headPos; // positive = this dot is ahead of the head (not yet reached)
      const behind = headPos - i; // positive = this dot is behind the head (tail zone)
      let v = 0;
      if (ahead >= 0 && ahead < 0.8) {
        // Sharp bright leading edge — the head of the snake
        v = (1 - ahead / 0.8) * 0.95;
      } else if (behind > 0 && behind < BODY_SIZE) {
        // Gradual fade toward the tail
        v = Math.pow(1 - behind / BODY_SIZE, 1.6) * 0.85;
      }
      if (v > 0.02) issRippleColors[ledIdx] = applyBrightness(ledColor, v * lm);
    }
  }

  // ── Current ISS position: always fully lit ──
  issRippleColors[issLedIdx] = applyBrightness(ledColor, lm);

  drawAll();
  issAnimFrame = requestAnimationFrame(tickISS);
}

// isOnLand: O(1) lookup against the pre-baked bit-field from land-data.json.
// Each bit corresponds to one 0.5°×0.5° cell in the _landW × _landH reference
// grid.  Bits are stored MSB-first (same packing as Python's PIL mode "1").
function isOnLand(idx) {
  if (!_landBits) return false;
  const col = idx % COLS, row = (idx / COLS) | 0;
  const rc  = Math.min(_landW - 1, ((col + 0.5) / COLS * _landW) | 0);
  const rr  = Math.min(_landH - 1, ((row + 0.5) / ROWS * _landH) | 0);
  const bit = rr * _landW + rc;
  return (_landBits[bit >> 3] & (128 >> (bit & 7))) !== 0;
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
  if (!_landBits) return;
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

// loadLandData: fetch the pre-baked land bitmap (generated by bake_land.py).
// Falls back silently when offline so the app stays functional without the file.
async function loadLandData() {
  try {
    const json = await fetch('land-data.json').then(r => r.json());
    _landW = json.w;
    _landH = json.h;
    // Decode the base64-packed bit-field into a Uint8Array.
    const binaryStr = atob(json.data);
    _landBits = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) _landBits[i] = binaryStr.charCodeAt(i);
  } catch { /* silently skip — isOnLand() returns false when _landBits is null */ }
  if (dataSource === 'daynight') buildDayNightState();
}

// loadWorldMap: fetch the TopoJSON for the cosmetic outline canvas only.
// Land/ocean hit-testing now uses loadLandData() instead.
async function loadWorldMap() {
  try {
    const topo = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json());
    worldGeo = topojson.feature(topo, topo.objects.land);
    buildOutlineCanvas();
  } catch { /* silently skip if offline */ }
}

// Map a geographic coordinate to the nearest LED index
function geoToLedIdx(lat, lon) {
  const [x, y] = geoProject(lon, lat);
  const col = Math.min(COLS - 1, Math.max(0, Math.round(x / SPACING - 0.5)));
  const row = Math.min(ROWS - 1, Math.max(0, Math.round(y / SPACING - 0.5)));
  return row * COLS + col;
}

// Build ripple objects from a list of {lat, lon, mag, time} quake objects
function buildSeismicRipples(quakes) {
  const sorted = quakes.slice().sort((a, b) => b.time - a.time); // newest first
  const top    = sorted.slice(0, 10);  // 10 most recent get animated ripples
  const rest   = sorted.slice(10);     // older quakes become twinkling dots
  seismicStaticDots = new Set(rest.map(({ lat, lon }) => geoToLedIdx(lat, lon)));
  // Assign each dot a unique random twinkle phase and speed
  seismicDotPhases = new Map();
  for (const idx of seismicStaticDots) {
    seismicDotPhases.set(idx, { phase: Math.random() * Math.PI * 2, speed: 0.0008 + Math.random() * 0.0016 });
  }
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

  // Twinkling dots for 24h quakes that are not in the 10 most-recent animated set
  if (seismicStaticDots && seismicStaticDots.size > 0) {
    const lm = isLightMode ? lightModeFactor(ledColor) : 1.0;
    const elapsed = now - (_rippleLastTime || now);
    for (const idx of seismicStaticDots) {
      if (idx < 0 || idx >= TOTAL || rippleColors[idx]) continue;
      const p = seismicDotPhases.get(idx);
      if (p) p.phase += elapsed * p.speed;
      const brightness = p ? (0.35 + 0.65 * (Math.sin(p ? p.phase : 0) * 0.5 + 0.5)) : 1.0;
      rippleColors[idx] = applyBrightness(ledColor, brightness * lm);
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

// — Seismic via USGS (no key, CORS open) — last 24 hours —
async function fetchSeismic() {
  try {
    const data   = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson').then(r => r.json());
    const quakes = data.features.filter(q => (q.properties.mag || 0) >= 1.5);
    const count  = quakes.length;
    const maxMag = count > 0 ? Math.max(...quakes.map(q => q.properties.mag || 0)) : 0;
    const mapped = quakes.map(q => ({
      lat:  q.geometry.coordinates[1],
      lon:  q.geometry.coordinates[0],
      mag:  q.properties.mag || 1.5,
      time: q.properties.time || 0
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

    _lastSeismicData = { mapped, quakes };
    buildSeismicRipples(mapped);
    setSourceStatus(`${count} quake${count !== 1 ? 's' : ''} · M${maxMag.toFixed(1)} max (24h)`);
  } catch { setSourceStatus('unavailable'); }
}

const DATA_FETCHERS = { seismic: fetchSeismic, iss: fetchISS };
