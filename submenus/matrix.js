// ---- Matrix sub-effects (random mode) ----

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

