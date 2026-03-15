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

