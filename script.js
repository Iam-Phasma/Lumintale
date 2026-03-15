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
  // No need to rebuild land data on resize — the pre-baked bitmap is viewport-independent.
  // Rebuild solar/day-night state with the new grid dimensions
  if (dataSource === 'daynight') {
    state = new Uint8Array(TOTAL);
    litSet = new Set();
    buildDayNightState();
    return;
  }
  // Reproject ISS dot to new grid dimensions
  if (dataSource === 'iss' && issLat !== undefined) {
    issLedIdx = geoToLedIdx(issLat, issLon);
    issTrail      = issTrail.map(p => ({ ...p, ledIdx: geoToLedIdx(p.lat, p.lon) }));
    // Future path stores Earth-rotation-corrected lon, so just reproject directly
    issFuturePath = issFuturePath.map(p => ({ ...p, ledIdx: geoToLedIdx(p.lat, p.lon) }));
    issRippleColors = null;
    return;
  }
  // Rebuild seismic positions with the new grid dimensions
  if (dataSource === 'seismic' && _lastSeismicData) {
    const { mapped, quakes } = _lastSeismicData;
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
    return; // buildSeismicRipples calls drawAll via tickRipple
  }
  if (dataSource === 'clock')  { renderClock(); return; }
  if (dataSource === 'webcam') { return; } // tickWebcam picks up the new COLS/ROWS on its next frame
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
  } else if (dataSource === 'iss' && issRippleColors) {
    ctx.fillStyle = issRippleColors[idx] || getOffColor();
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
  if ((dataSource === 'seismic' || dataSource === 'daynight' || dataSource === 'iss') && outlineCanvas && showMapOutline) {
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

function setSourceStatus(text) { sourceStatusEl.textContent = text; }

function stopDataSource() {
  if (dataFetchTimer)  { clearInterval(dataFetchTimer); dataFetchTimer = null; }
  if (daynightTimer)   { clearInterval(daynightTimer); daynightTimer = null; }
  if (flickerTimer)    { clearInterval(flickerTimer); flickerTimer = null; }
  if (rippleAnimFrame) { cancelAnimationFrame(rippleAnimFrame); rippleAnimFrame = null; }
  _rippleLastTime = 0;
  if (issAnimFrame)    { cancelAnimationFrame(issAnimFrame); issAnimFrame = null; }
  _issLastFrameTime = 0;
  if (micAnimFrame)    { cancelAnimationFrame(micAnimFrame); micAnimFrame = null; }
  if (micStream)       { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (micAudioCtx)     { micAudioCtx.close(); micAudioCtx = null; }
  micAnalyser    = null;
  stopClock();
  stopWebcam();
  seismicPool       = null;
  seismicRipples    = null;
  seismicStaticDots = null;
  seismicDotPhases  = null;
  rippleColors      = null;
  _lastSeismicData  = null;
  daynightColors = null;
  issRippleColors = null;
  issLedIdx = -1;
  issVelocity = 7.66;
  issTrail = [];
  issFuturePath = [];
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
  mapToggleRow.style.display          = (src === 'seismic' || src === 'daynight' || src === 'iss') ? 'flex' : 'none';
  recentSeismicToggleRow.style.display = src === 'seismic' ? 'flex' : 'none';
  daynightTimeRow.style.display        = src === 'daynight' ? 'flex' : 'none';
  if (issLocationRow) issLocationRow.style.display = src === 'iss' ? 'flex' : 'none';
  if (src === 'seismic' || src === 'daynight' || src === 'iss') {
    showMapOutline = src === 'seismic' || src === 'iss';
    mapToggle.classList.toggle('active', showMapOutline);
  }
  setGeoSlidersDisabled(src === 'seismic' || src === 'daynight' || src === 'iss');
  // Clock disables coverage + speed; webcam disables speed (coverage = exposure threshold)
  if (src === 'clock' || src === 'webcam') {
    speedSlider.disabled = true;
    speedSlider.closest('.setting-group').classList.add('disabled-row');
  }
  if (src === 'clock') {
    coverageSlider.disabled = true;
    coverageSlider.closest('.setting-group').classList.add('disabled-row');
  }
  // World + Others: lock density to 8 so geo/clock/webcam renders are always readable
  if (src !== 'random') {
    const densityChanged = parseInt(densitySlider.value) !== 8;
    densitySlider.value = 8;
    densityValEl.textContent = '8 /in';
    SPACING = Math.max(5, Math.round(96 / 8));
    densitySlider.disabled = true;
    densitySlider.closest('.setting-group').classList.add('disabled-row');
    if (densityChanged) resize(); // rebuild COLS/ROWS before source starts
  }
  setSolarControlsDisabled(src === 'daynight' || src === 'iss');
  setLightModeDisabled(src === 'seismic' || src === 'daynight' || src === 'iss');
  if (src === 'random' || src === 'mic') {
    // clear geo-shaped state so flicker redistributes from scratch
    state.fill(0);
    litSet.clear();
    TARGET_ON = Math.floor(TOTAL * TARGET_RATIO);
  }
  if (src === 'random') { startFlicker(); startSubEffect(); drawAll(); return; }
  if (src === 'mic') { startFlicker(); setSourceStatus('listening…'); startMic(); drawAll(); return; }
  if (src === 'clock')  { startClock();  return; }
  if (src === 'webcam') { state.fill(0); litSet.clear(); startWebcam(); return; }
  if (src === 'daynight') {
    tickDayNight();
    buildDayNightState();
    daynightTimer = setInterval(tickDayNight, 1000);
    return;
  }
  if (src === 'iss') {
    setSourceStatus('locating…');
    issAnimFrame = requestAnimationFrame(tickISS);
    // First fetch: shows path immediately using velocity-derived angle
    // Second fetch (1 s later): locks in real velocity vector from two position samples
    fetchISS().then(() => setTimeout(fetchISS, 1000));
    dataFetchTimer = setInterval(fetchISS, 30000);
    return;
  }
  setSourceStatus('fetching…');
  DATA_FETCHERS[src]();
  dataFetchTimer = setInterval(DATA_FETCHERS[src], 180000);
}


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
  if (issLocationRow) issLocationRow.style.display = 'none';
  if (issLatLonEl) issLatLonEl.textContent = '--';
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

