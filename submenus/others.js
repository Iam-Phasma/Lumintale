// ---- Others - Microphone ----

let micStream     = null;
let micAudioCtx   = null;
let micAnalyser   = null;
let micAnimFrame  = null;

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

// ---- Clock ----
let clockTimer = null;

// Bold 7-wide × 9-tall pixel font for flip clock.
// 1 = digit stroke (OFF / dark).  0 = card background (ON / lit).
// Row 4 is always 0 — the hinge gap row (entirely dark, never lit).
// Strokes are 2 pixels wide for a heavy flip-clock look.
const CLOCK_FONT = {
  '0': [ 62,  62,  99,  99, 0,  99,  99,  62,  62],
  '1': [ 28,  28,  28,  28, 0,  28,  28, 127, 127],
  '2': [ 62,  62,   3,   3, 0,  62,  96, 127, 127],
  '3': [ 62,  62,   3,  62, 0,  62,   3,  62,  62],
  '4': [ 99,  99,  99, 127, 0,   3,   3,   3,   3],
  '5': [127, 127,  96,  62, 0,   3,   3,  62,  62],
  '6': [ 62,  62,  96,  62, 0,  99,  99,  62,  62],
  '7': [127, 127,   3,   3, 0,  28,  28,  28,  28],
  '8': [ 62,  62,  99,  62, 0,  62,  99,  62,  62],
  '9': [ 62,  62,  99,  62, 0,   3,   3,  62,  62],
};
const GLYPH_W = 7; // bitmap column count

function renderClock() {
  if (dataSource !== 'clock') return;

  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, '0');   // military 00–23
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const colonOn = (now.getSeconds() % 2 === 0);
  const digits = [hh[0], hh[1], mm[0], mm[1]];

  // Layout: [H][H] [colon-gap] [M][M]
  // Each card = 1 padding cell + 7 glyph cols + 1 padding cell = 9 cells wide
  // Gap between paired digits: 1 dark cell
  // Colon gap: 2 dark cells
  const PAD    = 1;
  const PAD_V  = 2;
  const CW     = GLYPH_W + 2 * PAD;   // 9 cells wide per card
  const GLYPH_H = 9;
  const CARD_H  = GLYPH_H + 2 * PAD_V; // 11 rows tall
  const DGAP   = 1;
  const CGAP   = 2;

  const totalCells = 4 * CW + 2 * DGAP + CGAP; // 4*9+2+2 = 40
  const scale = Math.max(1, Math.floor(Math.min(
    COLS * 0.96 / totalCells,
    ROWS * 0.92 / CARD_H
  )));

  const cw = CW     * scale;
  const ch = CARD_H * scale;
  const dg = DGAP   * scale;
  const cg = CGAP   * scale;

  const totalW = 4 * cw + 2 * dg + cg;
  const sx     = Math.floor((COLS - totalW) / 2);
  const sy     = Math.floor((ROWS - ch) / 2);

  const cardX = [
    sx,
    sx + cw + dg,
    sx + 2 * cw + dg + cg + scale,
    sx + 3 * cw + 2 * dg + cg + scale,
  ];

  state.fill(0);
  litSet.clear();

  // ── render each digit card (card background lit, digit strokes dark) ──
  for (let d = 0; d < 4; d++) {
    const bitmap = CLOCK_FONT[digits[d]];
    const cx     = cardX[d];

    for (let r = 0; r < CARD_H; r++) {
      const glyphRow = r - PAD_V;

      if (glyphRow === 4) continue; // hinge gap — all dark

      const bits = (glyphRow >= 0 && glyphRow < GLYPH_H && bitmap)
        ? bitmap[glyphRow]
        : 0;

      for (let pr = 0; pr < scale; pr++) {
        const row = sy + r * scale + pr;
        if (row < 0 || row >= ROWS) continue;

        for (let c = 0; c < CW; c++) {
          // ── 1-cell rounded corners: skip the 4 corner cells of each card ──
          if ((r === 0 || r === CARD_H - 1) && (c === 0 || c === CW - 1)) continue;

          const glyphCol = c - PAD;
          const isStroke = glyphCol >= 0 && glyphCol < GLYPH_W &&
                           !!(bits & (1 << (GLYPH_W - 1 - glyphCol)));
          if (isStroke) continue;

          for (let pc = 0; pc < scale; pc++) {
            const col = cx + c * scale + pc;
            if (col < 0 || col >= COLS) continue;
            const idx = row * COLS + col;
            state[idx] = 1; litSet.add(idx);
          }
        }
      }
    }
  }

  // ── colon: two lit dots centred in the gap at glyph rows 2 and 6 — blink each second ──
  if (colonOn) {
    const dotX = sx + 2 * cw + dg + Math.floor((cg - scale) / 2) + scale - 1;
    for (const dotRow of [2 + PAD_V, 6 + PAD_V]) {
      for (let pr = 0; pr < scale; pr++) {
        const row = sy + dotRow * scale + pr;
        if (row < 0 || row >= ROWS) continue;
        for (let pc = 0; pc < scale; pc++) {
          const col = dotX + pc;
          if (col < 0 || col >= COLS) continue;
          const idx = row * COLS + col;
          state[idx] = 1; litSet.add(idx);
        }
      }
    }
  }

  drawAll();
}

function startClock() {
  setSourceStatus('military time');
  renderClock();
  clockTimer = setInterval(renderClock, 1000);
}

function stopClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}

// ---- Webcam ----
let webcamStream    = null;
let webcamVideo     = null;
let webcamOffCanvas = null;
let webcamOffCtx    = null;
let webcamAnimFrame = null;

async function startWebcam() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    webcamVideo  = document.createElement('video');
    webcamVideo.srcObject  = webcamStream;
    webcamVideo.playsInline = true;
    webcamVideo.muted       = true;
    await webcamVideo.play();
    webcamOffCanvas = document.createElement('canvas');
    webcamOffCtx    = webcamOffCanvas.getContext('2d', { willReadFrequently: true });
    setSourceStatus('live');
    tickWebcam();
  } catch {
    setSourceStatus('denied');
    activateSource('random');
  }
}

function tickWebcam() {
  if (dataSource !== 'webcam') return;
  if (webcamOffCanvas.width !== COLS || webcamOffCanvas.height !== ROWS) {
    webcamOffCanvas.width  = COLS;
    webcamOffCanvas.height = ROWS;
  }
  // Mirror horizontally for a natural selfie-camera feel
  webcamOffCtx.save();
  webcamOffCtx.translate(COLS, 0);
  webcamOffCtx.scale(-1, 1);
  webcamOffCtx.drawImage(webcamVideo, 0, 0, COLS, ROWS);
  webcamOffCtx.restore();
  const pixels = webcamOffCtx.getImageData(0, 0, COLS, ROWS).data;
  // Coverage slider acts as exposure: higher coverage = lower threshold = more LEDs lit
  const threshold = Math.max(5, 255 * (1 - TARGET_RATIO * 1.4));
  state.fill(0);
  litSet.clear();
  for (let i = 0; i < TOTAL; i++) {
    const p    = i * 4;
    const luma = 0.2126 * pixels[p] + 0.7152 * pixels[p + 1] + 0.0722 * pixels[p + 2];
    if (luma > threshold) {
      state[i] = 1;
      litSet.add(i);
    }
  }
  drawAll();
  webcamAnimFrame = requestAnimationFrame(tickWebcam);
}

function stopWebcam() {
  if (webcamAnimFrame) { cancelAnimationFrame(webcamAnimFrame); webcamAnimFrame = null; }
  if (webcamStream)    { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  if (webcamVideo)     { webcamVideo.srcObject = null; webcamVideo = null; }
  webcamOffCanvas = null;
  webcamOffCtx    = null;
}

