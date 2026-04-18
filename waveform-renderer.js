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
  const styleChipsEl   = document.getElementById('wfr-style-chips');
  const waveColorPicker= document.getElementById('wfr-wave-color');
  const waveOpacity    = document.getElementById('wfr-wave-opacity');
  const opacityVal     = document.getElementById('wfr-opacity-val');
  const waveHeight     = document.getElementById('wfr-wave-height');
  const playBtn        = document.getElementById('wfr-play-btn');
  const exportBtn      = document.getElementById('wfr-export-btn');
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
      bgColorRow.style.display = bgMode === 'color' ? '' : 'none';
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

    playBtn.disabled   = false;
    exportBtn.disabled = false;
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
    c.fillStyle = waveColor();
    c.strokeStyle = waveColor();

    if (selectedStyle === 'line') {
      c.beginPath();
      c.lineWidth = Math.max(1, W / 300);
      for (let i = 0; i < W; i++) {
        const amp = peaks[i] * maxAmp;
        const y   = H / 2 - amp;
        i === 0 ? c.moveTo(i, y) : c.lineTo(i, y);
      }
      c.stroke();
      return;
    }

    for (let i = 0; i < W; i++) {
      const amp = peaks[i] * maxAmp;
      if (selectedStyle === 'bars') {
        c.fillRect(i, H / 2 - amp, 1, amp || 1);
      } else { // mirrored
        c.fillRect(i, H / 2 - amp, 1, amp * 2 || 1);
      }
    }
  }

  function drawLiveWave(c, W, H, data) {
    // data = Uint8Array from analyser.getByteTimeDomainData
    const heightFrac = Number(waveHeight.value) / 100;
    const maxAmp = (H / 2) * heightFrac;
    c.fillStyle = waveColor();
    c.strokeStyle = waveColor();
    const step = data.length / W;

    if (selectedStyle === 'line') {
      c.beginPath();
      c.lineWidth = Math.max(1, W / 300);
      for (let i = 0; i < W; i++) {
        const sample = (data[Math.floor(i * step)] / 128.0) - 1.0;
        const y = H / 2 - sample * maxAmp;
        i === 0 ? c.moveTo(i, y) : c.lineTo(i, y);
      }
      c.stroke();
      return;
    }

    for (let i = 0; i < W; i++) {
      const sample = Math.abs((data[Math.floor(i * step)] / 128.0) - 1.0);
      const amp = sample * maxAmp;
      if (selectedStyle === 'bars') {
        c.fillRect(i, H / 2 - amp, 1, amp || 1);
      } else {
        c.fillRect(i, H / 2 - amp, 1, amp * 2 || 1);
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
    analyser = null;
    playBtn.textContent = '▶ Preview';
    redrawStatic();
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  exportBtn.addEventListener('click', () => { if (!isExporting) exportVideo(); });

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
