/**
 * waveform-renderer.js — animated waveform over image/video, export as WebM.
 * Supports bars, mirrored bars, and line styles.
 * Social size presets: 9:16, 1:1, 4:5, 16:9.
 * Transparent background option for use in NLEs (Final Cut Pro, Premiere).
 */

const SIZE_PRESETS = [
  { label: '9:16',  w: 1080, h: 1920 },
  { label: '1:1',   w: 1080, h: 1080 },
  { label: '4:5',   w: 1080, h: 1350 },
  { label: '16:9',  w: 1920, h: 1080 },
];

const WAVE_STYLES = [
  { label: 'Bars',     id: 'bars'     },
  { label: 'Mirrored', id: 'mirrored' },
  { label: 'Line',     id: 'line'     },
];

const BAR_WIDTHS = [
  { label: 'Fine',   px: 1, gap: 0 },
  { label: 'Normal', px: 3, gap: 1 },
  { label: 'Thick',  px: 6, gap: 1 },
  { label: 'EQ',     px: 8, gap: 2 },
];

// Decay multiplier applied per frame (1.0 = no decay / instant drop)
const DECAY_MODES = [
  { label: 'Off',    rate: 1.00  },   // bars track audio directly
  { label: 'Fast',   rate: 0.82  },   // quick fall, still responsive
  { label: 'Smooth', rate: 0.92  },   // medium — classic VU feel
  { label: 'Hold',   rate: 0.975 },   // very slow fall, dramatic
];

const BG_MODES = [
  { label: 'Colour',      id: 'color'       },
  { label: 'Transparent', id: 'transparent' },
];

export function initWaveformRenderer() {
  // ── DOM refs ────────────────────────────────────────────────────────────────
  const sizeChipsEl    = document.getElementById('wfr-size-chips');
  const audioDrop      = document.getElementById('wfr-audio-drop');
  const audioInput     = document.getElementById('wfr-audio-input');
  const audioDropText  = document.getElementById('wfr-audio-drop-text');
  const bgDrop         = document.getElementById('wfr-bg-drop');
  const bgInput        = document.getElementById('wfr-bg-input');
  const bgDropText     = document.getElementById('wfr-bg-drop-text');
  const bgChipsEl      = document.getElementById('wfr-bg-chips');
  const bgColorRow     = document.getElementById('wfr-bg-color-row');
  const bgColorPicker  = document.getElementById('wfr-bg-color');
  const styleChipsEl    = document.getElementById('wfr-style-chips');
  const barWidthChipsEl = document.getElementById('wfr-barwidth-chips');
  const decayChipsEl    = document.getElementById('wfr-decay-chips');
  const waveColorPicker= document.getElementById('wfr-wave-color');
  const waveOpacity    = document.getElementById('wfr-wave-opacity');
  const opacityVal     = document.getElementById('wfr-opacity-val');
  const waveHeight     = document.getElementById('wfr-wave-height');
  const playBtn        = document.getElementById('wfr-play-btn');
  const exportBtn      = document.getElementById('wfr-export-btn');
  const exportPngBtn   = document.getElementById('wfr-export-png');
  const progressWrap   = document.getElementById('wfr-progress-wrap');
  const progressBar    = document.getElementById('wfr-progress-bar');
  const progressLabel  = document.getElementById('wfr-progress-label');
  const canvas         = document.getElementById('wfr-canvas');
  const canvasHint     = document.getElementById('wfr-canvas-hint');
  const ctx            = canvas.getContext('2d');

  // ── State ───────────────────────────────────────────────────────────────────
  let audioBuffer    = null;   // decoded AudioBuffer (for static preview)
  let audioEl        = null;   // <audio> element for live playback
  let audioBlobUrl   = null;
  let bgImage        = null;   // ImageBitmap
  let bgVideoEl      = null;   // <video>
  let bgBlobUrl      = null;
  let selectedSize   = SIZE_PRESETS[0];  // default 9:16
  let selectedStyle  = 'bars';
  let selectedBar    = BAR_WIDTHS[0];    // { px, gap }
  let selectedDecay  = DECAY_MODES[0];  // { rate }
  let decayBuffer    = null;            // Float32Array, one entry per bar
  let bgMode         = 'color';          // 'color' | 'transparent'
  let analyser       = null;
  let audioCtxLive   = null;
  let animFrame      = null;
  let isPlaying      = false;
  let isExporting    = false;
  let staticPeaks    = null;

  // ── Build size chips ────────────────────────────────────────────────────────
  SIZE_PRESETS.forEach((preset, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      setChip(sizeChipsEl, btn);
      selectedSize = preset;
      resizePreviewCanvas();
      redrawStatic();
    });
    sizeChipsEl.appendChild(btn);
  });

  // ── Build BG mode chips ─────────────────────────────────────────────────────
  BG_MODES.forEach((mode, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = mode.label;
    btn.addEventListener('click', () => {
      setChip(bgChipsEl, btn);
      bgMode = mode.id;
      const showColor = bgMode === 'color';
      bgColorRow.style.display = showColor ? '' : 'none';
      document.getElementById('wfr-bg-swatches').style.display = showColor ? '' : 'none';
      redrawStatic();
    });
    bgChipsEl.appendChild(btn);
  });

  // ── Build style chips ───────────────────────────────────────────────────────
  WAVE_STYLES.forEach((style, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = style.label;
    btn.addEventListener('click', () => {
      setChip(styleChipsEl, btn);
      selectedStyle = style.id;
      redrawStatic();
    });
    styleChipsEl.appendChild(btn);
  });

  // ── Build bar-width chips ───────────────────────────────────────────────────
  BAR_WIDTHS.forEach((bw, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = bw.label;
    btn.addEventListener('click', () => {
      setChip(barWidthChipsEl, btn);
      selectedBar = bw;
      redrawStatic();
    });
    barWidthChipsEl.appendChild(btn);
  });

  // ── Build decay chips ───────────────────────────────────────────────────────
  DECAY_MODES.forEach((mode, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = mode.label;
    btn.addEventListener('click', () => {
      setChip(decayChipsEl, btn);
      selectedDecay = mode;
      decayBuffer   = null; // reset on mode change
    });
    decayChipsEl.appendChild(btn);
  });

  // ── Colour swatches (reuse e-swatch pattern) ────────────────────────────────
  document.getElementById('panel-waveform').addEventListener('click', e => {
    const swatch = e.target.closest('.e-swatch');
    if (!swatch) return;
    const target = document.getElementById(swatch.closest('.e-swatches').dataset.target);
    if (target) { target.value = swatch.dataset.color; target.dispatchEvent(new Event('input')); }
  });

  // ── Controls → redraw ───────────────────────────────────────────────────────
  bgColorPicker.addEventListener('input', redrawStatic);
  waveColorPicker.addEventListener('input', redrawStatic);
  waveOpacity.addEventListener('input', () => {
    opacityVal.textContent = waveOpacity.value + '%';
    redrawStatic();
  });
  waveHeight.addEventListener('input', redrawStatic);

  // ── Initial canvas size ─────────────────────────────────────────────────────
  resizePreviewCanvas();

  function resizePreviewCanvas() {
    // Show at max 480px wide in preview, maintaining aspect ratio
    const maxW = Math.min(canvas.parentElement.clientWidth || 480, 480);
    const ratio = selectedSize.h / selectedSize.w;
    canvas.style.width  = maxW + 'px';
    canvas.style.height = Math.round(maxW * ratio) + 'px';
    // Internal resolution stays at preview scale for efficiency
    canvas.width  = maxW;
    canvas.height = Math.round(maxW * ratio);
    redrawStatic();
  }

  window.addEventListener('resize', () => {
    if (!document.getElementById('panel-waveform').classList.contains('visible')) return;
    resizePreviewCanvas();
  });

  // ── Audio drop ──────────────────────────────────────────────────────────────
  audioDrop.addEventListener('click', () => audioInput.click());
  audioInput.addEventListener('change', () => { if (audioInput.files[0]) loadAudio(audioInput.files[0]); });
  wireDropzone(audioDrop, f => f.type.startsWith('audio/') || f.type.startsWith('video/'), loadAudio);

  async function loadAudio(file) {
    stopPreview();
    if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
    audioBlobUrl = URL.createObjectURL(file);

    if (audioEl) { audioEl.pause(); audioEl.src = ''; }
    audioEl = new Audio(audioBlobUrl);

    audioDropText.textContent = file.name;
    audioDrop.classList.add('has-file');

    try {
      const ab = await file.arrayBuffer();
      const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioBuffer = await tmpCtx.decodeAudioData(ab);
      await tmpCtx.close();
      buildStaticPeaks();
      redrawStatic();
    } catch (e) {
      console.warn('[wfr] audio decode failed', e);
    }

    playBtn.disabled      = false;
    exportBtn.disabled    = false;
    exportPngBtn.disabled = false;
    canvasHint.style.display = 'none';
  }

  function buildStaticPeaks() {
    if (!audioBuffer) return;
    const raw = audioBuffer.getChannelData(0);
    const W   = canvas.width;
    const step = Math.max(1, Math.floor(raw.length / W));
    const peaks = new Float32Array(W);
    for (let i = 0; i < W; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += raw[i * step + j] ** 2;
      peaks[i] = Math.sqrt(sum / step);
    }
    let max = 0.001;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
    for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    staticPeaks = peaks;
  }

  // ── Background drop ─────────────────────────────────────────────────────────
  bgDrop.addEventListener('click', () => bgInput.click());
  bgInput.addEventListener('change', () => { if (bgInput.files[0]) loadBackground(bgInput.files[0]); });
  wireDropzone(bgDrop, f => f.type.startsWith('image/') || f.type.startsWith('video/'), loadBackground);

  async function loadBackground(file) {
    if (bgBlobUrl) URL.revokeObjectURL(bgBlobUrl);
    bgBlobUrl = URL.createObjectURL(file);
    bgImage = null;
    if (bgVideoEl) { bgVideoEl.pause(); bgVideoEl.src = ''; bgVideoEl = null; }

    if (file.type.startsWith('image/')) {
      bgImage = await createImageBitmap(file);
    } else {
      bgVideoEl = document.createElement('video');
      bgVideoEl.src = bgBlobUrl;
      bgVideoEl.loop = true;
      bgVideoEl.muted = true;
      bgVideoEl.preload = 'auto';
    }
    bgDropText.textContent = file.name;
    bgDrop.classList.add('has-file');
    redrawStatic();
  }

  // ── Static redraw ───────────────────────────────────────────────────────────
  function redrawStatic() {
    if (isPlaying) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    drawBg(ctx, W, H);
    if (staticPeaks) drawStaticWave(ctx, W, H, staticPeaks);
  }

  function drawBg(c, W, H, forExport = false) {
    if (bgMode === 'transparent' && !forExport) {
      // Show a checkerboard hint in preview
      const sz = 12;
      for (let y = 0; y < H; y += sz) {
        for (let x = 0; x < W; x += sz) {
          c.fillStyle = ((x / sz + y / sz) % 2 === 0) ? '#2a2a2a' : '#1a1a1a';
          c.fillRect(x, y, sz, sz);
        }
      }
      return;
    }
    if (bgMode !== 'transparent') {
      c.fillStyle = bgColorPicker.value;
      c.fillRect(0, 0, W, H);
    }
    const src = bgImage || bgVideoEl;
    if (!src) return;
    const sw = bgImage ? bgImage.width : bgVideoEl.videoWidth;
    const sh = bgImage ? bgImage.height : bgVideoEl.videoHeight;
    if (!sw || !sh) return;
    const scale = Math.max(W / sw, H / sh);
    const dw = sw * scale, dh = sh * scale;
    c.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function waveColor() {
    const hex = waveColorPicker.value;
    const alpha = Number(waveOpacity.value) / 100;
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function drawStaticWave(c, W, H, peaks) {
    const heightFrac = Number(waveHeight.value) / 100;
    const maxAmp = (H / 2) * heightFrac;
    const col = waveColor();
    c.fillStyle   = col;
    c.strokeStyle = col;

    if (selectedStyle === 'line') {
      c.beginPath();
      c.lineWidth = Math.max(1, selectedBar.px);
      for (let i = 0; i < W; i++) {
        const amp = peaks[i] * maxAmp;
        const y   = H / 2 - amp;
        i === 0 ? c.moveTo(i, y) : c.lineTo(i, y);
      }
      c.stroke();
      return;
    }

    const bw   = selectedBar.px;
    const gap  = selectedBar.gap;
    const step = bw + gap;
    // Downsample peaks to bar count when bars are wide
    const barCount = Math.floor(W / step);
    const buckW    = peaks.length / barCount;

    for (let b = 0; b < barCount; b++) {
      // Average peaks across this bar's bucket
      let sum = 0, cnt = 0;
      const s = Math.floor(b * buckW), e = Math.min(peaks.length, Math.floor((b + 1) * buckW));
      for (let i = s; i < e; i++) { sum += peaks[i]; cnt++; }
      const amp = (cnt ? sum / cnt : 0) * maxAmp;
      const x   = b * step;

      if (selectedStyle === 'bars') {
        c.fillRect(x, H / 2 - amp, bw, amp || 1);
      } else { // mirrored
        c.fillRect(x, H / 2 - amp, bw, amp * 2 || 1);
      }
    }
  }

  function drawLiveWave(c, W, H, data) {
    // data = Uint8Array from analyser.getByteTimeDomainData
    const heightFrac = Number(waveHeight.value) / 100;
    const maxAmp = (H / 2) * heightFrac;
    const col = waveColor();
    c.fillStyle   = col;
    c.strokeStyle = col;

    if (selectedStyle === 'line') {
      c.beginPath();
      c.lineWidth = Math.max(1, selectedBar.px);
      for (let i = 0; i < W; i++) {
        const sample = (data[Math.floor(i * data.length / W)] / 128.0) - 1.0;
        const y = H / 2 - sample * maxAmp;
        i === 0 ? c.moveTo(i, y) : c.lineTo(i, y);
      }
      c.stroke();
      return;
    }

    const bw       = selectedBar.px;
    const gap      = selectedBar.gap;
    const step     = bw + gap;
    const barCount = Math.floor(W / step);
    const buckW    = data.length / barCount;
    const rate     = selectedDecay.rate;

    // Initialise or resize decay buffer when bar count changes
    if (!decayBuffer || decayBuffer.length !== barCount) {
      decayBuffer = new Float32Array(barCount);
    }

    for (let b = 0; b < barCount; b++) {
      let sum = 0, cnt = 0;
      const s = Math.floor(b * buckW), e = Math.min(data.length, Math.floor((b + 1) * buckW));
      for (let i = s; i < e; i++) { sum += Math.abs((data[i] / 128.0) - 1.0); cnt++; }
      const raw = (cnt ? sum / cnt : 0) * maxAmp;

      // Rise instantly, decay at selected rate
      if (raw >= decayBuffer[b]) {
        decayBuffer[b] = raw;
      } else {
        decayBuffer[b] = Math.max(0, decayBuffer[b] * rate);
      }
      const amp = decayBuffer[b];
      const x   = b * step;

      if (selectedStyle === 'bars') {
        c.fillRect(x, H / 2 - amp, bw, amp || 1);
      } else {
        c.fillRect(x, H / 2 - amp, bw, amp * 2 || 1);
      }
    }
  }

  // ── Preview playback ────────────────────────────────────────────────────────
  playBtn.addEventListener('click', togglePreview);

  function togglePreview() {
    if (isPlaying) stopPreview();
    else startPreview();
  }

  function startPreview() {
    if (!audioEl) return;
    stopPreview();

    audioCtxLive = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtxLive.createMediaElementSource(audioEl);
    analyser = audioCtxLive.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyser.connect(audioCtxLive.destination);

    audioEl.currentTime = 0;
    audioEl.play();
    isPlaying = true;
    playBtn.textContent = '⏹ Stop';

    if (bgVideoEl) bgVideoEl.play();

    const dataArray = new Uint8Array(analyser.fftSize);
    function loop() {
      if (!isPlaying) return;
      analyser.getByteTimeDomainData(dataArray);
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      drawBg(ctx, W, H);
      drawLiveWave(ctx, W, H, dataArray);
      animFrame = requestAnimationFrame(loop);
    }
    animFrame = requestAnimationFrame(loop);

    audioEl.onended = () => stopPreview();
  }

  function stopPreview() {
    isPlaying = false;
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    if (audioEl)   { audioEl.pause(); audioEl.onended = null; }
    if (bgVideoEl) bgVideoEl.pause();
    if (audioCtxLive) { audioCtxLive.close(); audioCtxLive = null; }
    analyser    = null;
    decayBuffer = null;
    playBtn.textContent = '▶ Preview';
    redrawStatic();
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  exportBtn.addEventListener('click',    () => { if (!isExporting) exportVideo(); });
  exportPngBtn.addEventListener('click', () => { if (!isExporting) exportPngSequence(); });

  async function exportVideo() {
    if (!audioEl) return;
    stopPreview();
    isExporting = true;
    exportBtn.disabled = true;
    playBtn.disabled   = true;
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    progressLabel.textContent = 'Recording…';

    // Use full output resolution for export
    const EW = selectedSize.w, EH = selectedSize.h;
    const offscreen = document.createElement('canvas');
    offscreen.width  = EW;
    offscreen.height = EH;
    const ec = offscreen.getContext('2d', { alpha: bgMode === 'transparent' });

    // Build static peaks at export resolution
    const exportPeaks = buildExportPeaks(EW);

    // Set up audio routing
    const exportCtx  = new (window.AudioContext || window.webkitAudioContext)();
    const source     = exportCtx.createMediaElementSource(audioEl);
    const expAnalyser = exportCtx.createAnalyser();
    expAnalyser.fftSize = 2048;
    const dest = exportCtx.createMediaStreamDestination();
    source.connect(expAnalyser);
    source.connect(dest);
    // Don't connect to speakers during export

    // Combine canvas stream + audio
    const fps = 30;
    const canvasStream = offscreen.captureStream(fps);
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    // Pick best supported MIME
    const mimeType = bgMode === 'transparent'
      ? (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm')
      : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');

    const chunks = [];
    const recorder = new MediaRecorder(combined, { mimeType });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mimeType });
      const ext  = 'webm';
      const name = 'waveform_' + selectedSize.label.replace(':', 'x') + '.' + ext;
      await saveFile(blob, name, mimeType);
      exportCtx.close();
      isExporting = false;
      exportBtn.disabled = false;
      playBtn.disabled   = false;
      progressWrap.style.display = 'none';
    };

    // Draw loop for export
    const dataArray = new Uint8Array(expAnalyser.fftSize);
    let duration = audioBuffer ? audioBuffer.duration : 0;
    let elapsed  = 0;
    const startTime = performance.now();

    function exportLoop() {
      if (!isExporting) { recorder.stop(); return; }
      expAnalyser.getByteTimeDomainData(dataArray);
      ec.clearRect(0, 0, EW, EH);
      drawBg(ec, EW, EH, true);
      drawLiveWave(ec, EW, EH, dataArray);

      elapsed = (performance.now() - startTime) / 1000;
      const pct = duration > 0 ? Math.min(elapsed / duration, 1) : 0;
      progressBar.style.width = Math.round(pct * 100) + '%';
      progressLabel.textContent = 'Recording… ' + Math.round(pct * 100) + '%';

      animFrame = requestAnimationFrame(exportLoop);
    }

    audioEl.currentTime = 0;
    if (bgVideoEl) { bgVideoEl.currentTime = 0; bgVideoEl.play(); }
    recorder.start();
    audioEl.play();
    animFrame = requestAnimationFrame(exportLoop);

    audioEl.onended = () => {
      isExporting = false;
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      if (bgVideoEl) bgVideoEl.pause();
      recorder.stop();
    };
  }

  // ── PNG sequence export ────────────────────────────────────────────────────
  async function exportPngSequence() {
    if (!audioBuffer) return;
    if (typeof JSZip === 'undefined') {
      alert('JSZip not loaded — check your internet connection and reload.');
      return;
    }

    stopPreview();
    isExporting = true;
    exportBtn.disabled    = true;
    exportPngBtn.disabled = true;
    playBtn.disabled      = true;
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    progressLabel.textContent = 'Rendering frames…';

    const FPS      = 30;
    const EW       = selectedSize.w;
    const EH       = selectedSize.h;
    const duration = audioBuffer.duration;
    const total    = Math.ceil(duration * FPS);
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);
    const windowSize  = 2048; // samples per frame (~46ms at 44.1kHz)

    const off = document.createElement('canvas');
    off.width  = EW;
    off.height = EH;
    const ec = off.getContext('2d', { alpha: true });

    const zip = new JSZip();
    const folder = zip.folder('frames');

    // Also export audio as WAV for NLE sync
    const wavBlob = encodeWav(audioBuffer);
    zip.file('audio.wav', wavBlob);

    for (let frame = 0; frame < total; frame++) {
      // Get waveform data at this frame's time position
      const t           = frame / FPS;
      const centerSamp  = Math.floor(t * sampleRate);
      const startSamp   = Math.max(0, centerSamp - windowSize / 2);
      const frameData   = new Uint8Array(windowSize);
      for (let i = 0; i < windowSize; i++) {
        const idx = startSamp + i;
        frameData[i] = idx < channelData.length
          ? Math.round(Math.max(-1, Math.min(1, channelData[idx])) * 127 + 128)
          : 128;
      }

      // Draw frame
      ec.clearRect(0, 0, EW, EH);
      drawBg(ec, EW, EH, true);
      drawLiveWave(ec, EW, EH, frameData);

      // Collect PNG blob
      const pngBlob = await new Promise(res => off.toBlob(res, 'image/png'));
      const pngBuf  = await pngBlob.arrayBuffer();
      const name    = 'frame_' + String(frame + 1).padStart(6, '0') + '.png';
      folder.file(name, pngBuf);

      // Update progress every 10 frames
      if (frame % 10 === 0) {
        const pct = Math.round((frame / total) * 100);
        progressBar.style.width = pct + '%';
        progressLabel.textContent = `Rendering frame ${frame + 1} / ${total}…`;
        // Yield to keep UI responsive
        await new Promise(r => setTimeout(r, 0));
      }
    }

    progressLabel.textContent = 'Zipping…';
    progressBar.style.width = '95%';
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    const zipName = 'waveform_' + selectedSize.label.replace(':', 'x') + '_png_seq.zip';
    await saveFile(zipBlob, zipName, 'application/zip');

    isExporting = false;
    exportBtn.disabled    = false;
    exportPngBtn.disabled = false;
    playBtn.disabled      = false;
    progressWrap.style.display = 'none';
  }

  /** Encode AudioBuffer as a minimal 16-bit PCM WAV blob */
  function encodeWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate  = buffer.sampleRate;
    const numSamples  = buffer.length;
    const byteDepth   = 2; // 16-bit
    const dataLen     = numSamples * numChannels * byteDepth;
    const ab          = new ArrayBuffer(44 + dataLen);
    const view        = new DataView(ab);

    function write(off, str) { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); }
    write(0,  'RIFF');
    view.setUint32(4,  36 + dataLen, true);
    write(8,  'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                        // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * byteDepth, true);
    view.setUint16(32, numChannels * byteDepth, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, dataLen, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  function buildExportPeaks(W) {
    if (!audioBuffer) return new Float32Array(W);
    const raw  = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(raw.length / W));
    const peaks = new Float32Array(W);
    for (let i = 0; i < W; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += raw[i * step + j] ** 2;
      peaks[i] = Math.sqrt(sum / step);
    }
    let max = 0.001;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
    for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    return peaks;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveFile(blob, name, mime) {
    const ext = name.split('.').pop();
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile && navigator.canShare) {
      const shareFile = new File([blob], name, { type: mime });
      if (navigator.canShare({ files: [shareFile] })) {
        try { await navigator.share({ files: [shareFile], title: name }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }
    }
    if ('showSaveFilePicker' in window) {
      try {
        const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'WebM video', accept: { [mime]: ['.' + ext] } }] });
        const w  = await fh.createWritable();
        await w.write(blob); await w.close(); return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setChip(container, active) {
    container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    active.classList.add('active');
  }

  function wireDropzone(el, filter, handler) {
    el.addEventListener('dragover',  e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const f = [...e.dataTransfer.files].find(filter);
      if (f) handler(f);
    });
  }
}
