/**
 * compressor.js — browser-side H.264 video compression via FFmpeg.wasm
 * Two-pass encoding: pass 1 ultrafast (analysis), pass 2 with chosen quality preset.
 * Single-threaded core — no SharedArrayBuffer / COOP/COEP headers required.
 */

const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const UTIL_CDN   = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';
const CORE_JS    = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';
const CORE_WASM  = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';

const BITRATE_PRESETS = [1500, 2000, 2250, 2500, 3000, 5000];
const SIZE_PRESETS    = [3, 5, 10, 15, 20, 30]; // MB
const QUALITY_MAP     = { low: 'fast', medium: 'medium', high: 'slow' };
const ASSUMED_AUDIO_KBPS = 128; // assumed audio bitrate for target-size calc

export function initCompressor() {
  // ── DOM refs ────────────────────────────────────────────────────────────
  const dropzone       = document.getElementById('cmp-dropzone');
  const fileInput      = document.getElementById('cmp-file-input');
  const infoBox        = document.getElementById('cmp-info');
  const modeRadios     = document.querySelectorAll('input[name="cmp-mode"]');
  const bitrateSection = document.getElementById('cmp-bitrate-section');
  const sizeSection    = document.getElementById('cmp-size-section');
  const bitrateChips   = document.getElementById('cmp-bitrate-chips');
  const sizeChips      = document.getElementById('cmp-size-chips');
  const customBitrateWrap = document.getElementById('cmp-custom-bitrate-wrap');
  const customBitrateInput = document.getElementById('cmp-custom-bitrate');
  const customSizeWrap = document.getElementById('cmp-custom-size-wrap');
  const customSizeInput = document.getElementById('cmp-custom-size');
  const estSizeEl      = document.getElementById('cmp-est-size');
  const qualityChips   = document.getElementById('cmp-quality-chips');
  const compressBtn    = document.getElementById('cmp-compress-btn');
  const progressWrap   = document.getElementById('cmp-progress-wrap');
  const progressBar    = document.getElementById('cmp-progress-bar');
  const progressLabel  = document.getElementById('cmp-progress-label');
  const cancelBtn      = document.getElementById('cmp-cancel-btn');

  // ── State ────────────────────────────────────────────────────────────────
  let sourceFile     = null;
  let sourceDuration = 0; // seconds
  let selectedBitrate = BITRATE_PRESETS[1]; // 2000 kbps default
  let selectedSizeMB  = SIZE_PRESETS[2];    // 10 MB default
  let selectedQuality = 'medium';
  let ffmpegInstance  = null;
  let encoding        = false;
  let startTime       = 0;
  let timerInterval   = null;

  // ── Build bitrate chips ─────────────────────────────────────────────────
  BITRATE_PRESETS.forEach(kbps => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (kbps === selectedBitrate ? ' active' : '');
    btn.textContent = kbps >= 1000 ? (kbps / 1000).toLocaleString('en', { maximumFractionDigits: 1 }) + ',000' : kbps;
    btn.textContent = kbps.toLocaleString('en') + ' kbps';
    btn.addEventListener('click', () => {
      customBitrateWrap.style.display = 'none';
      setActiveChip(bitrateChips, btn);
      selectedBitrate = kbps;
      updateEstSize();
    });
    bitrateChips.appendChild(btn);
  });
  // Custom bitrate chip
  const customBitrateChip = document.createElement('button');
  customBitrateChip.type = 'button';
  customBitrateChip.className = 'chip';
  customBitrateChip.textContent = 'Custom';
  customBitrateChip.addEventListener('click', () => {
    setActiveChip(bitrateChips, customBitrateChip);
    customBitrateWrap.style.display = 'flex';
    customBitrateInput.focus();
  });
  bitrateChips.appendChild(customBitrateChip);

  customBitrateInput.addEventListener('input', () => {
    const v = Number(customBitrateInput.value);
    if (v > 0) { selectedBitrate = v; updateEstSize(); }
  });

  // ── Build size chips ────────────────────────────────────────────────────
  SIZE_PRESETS.forEach(mb => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (mb === selectedSizeMB ? ' active' : '');
    btn.textContent = mb + ' MB';
    btn.addEventListener('click', () => {
      customSizeWrap.style.display = 'none';
      setActiveChip(sizeChips, btn);
      selectedSizeMB = mb;
    });
    sizeChips.appendChild(btn);
  });
  const customSizeChip = document.createElement('button');
  customSizeChip.type = 'button';
  customSizeChip.className = 'chip';
  customSizeChip.textContent = 'Custom';
  customSizeChip.addEventListener('click', () => {
    setActiveChip(sizeChips, customSizeChip);
    customSizeWrap.style.display = 'flex';
    customSizeInput.focus();
  });
  sizeChips.appendChild(customSizeChip);

  customSizeInput.addEventListener('input', () => {
    const v = Number(customSizeInput.value);
    if (v > 0) selectedSizeMB = v;
  });

  // ── Quality chips ────────────────────────────────────────────────────────
  ['Low', 'Medium', 'High'].forEach(label => {
    const key = label.toLowerCase();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (key === selectedQuality ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      setActiveChip(qualityChips, btn);
      selectedQuality = key;
    });
    qualityChips.appendChild(btn);
  });

  // ── Mode radio switching ─────────────────────────────────────────────────
  modeRadios.forEach(r => r.addEventListener('change', () => {
    const mode = document.querySelector('input[name="cmp-mode"]:checked').value;
    bitrateSection.style.display = mode === 'bitrate' ? '' : 'none';
    sizeSection.style.display    = mode === 'size'    ? '' : 'none';
    estSizeEl.style.display      = mode === 'bitrate' ? '' : 'none';
    updateEstSize();
  }));

  // ── Dropzone ─────────────────────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) loadFile(f);
  });

  // ── Load file — probe duration via <video> ───────────────────────────────
  function loadFile(file) {
    sourceFile = file;
    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.src = url;
    vid.addEventListener('loadedmetadata', () => {
      sourceDuration = vid.duration;
      URL.revokeObjectURL(url);
      showInfo(file, vid);
      updateEstSize();
      compressBtn.disabled = false;
    });
    vid.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      // Duration unknown — show info without it
      sourceDuration = 0;
      showInfo(file, null);
      compressBtn.disabled = false;
    });
  }

  function showInfo(file, vid) {
    const sizeMB = (file.size / 1048576).toFixed(1);
    const dur = vid && isFinite(vid.duration) ? formatDuration(vid.duration) : '—';
    const res = vid && vid.videoWidth ? vid.videoWidth + ' × ' + vid.videoHeight + ' px' : '—';
    const kbps = vid && isFinite(vid.duration) && vid.duration > 0
      ? Math.round(file.size * 8 / 1000 / vid.duration) + ' kbps'
      : '—';
    infoBox.innerHTML =
      '<div class="cmp-info-grid">' +
        '<span class="cmp-info-label">File</span><span>' + esc(file.name) + '</span>' +
        '<span class="cmp-info-label">Size</span><span>' + sizeMB + ' MB</span>' +
        '<span class="cmp-info-label">Duration</span><span>' + dur + '</span>' +
        '<span class="cmp-info-label">Resolution</span><span>' + res + '</span>' +
        '<span class="cmp-info-label">Bitrate</span><span>' + kbps + '</span>' +
      '</div>';
    infoBox.style.display = '';
    dropzone.classList.add('has-file');
    dropzone.querySelector('.cmp-drop-text').textContent = esc(file.name);
  }

  function updateEstSize() {
    const mode = document.querySelector('input[name="cmp-mode"]:checked')?.value;
    if (mode !== 'bitrate' || !sourceDuration) { estSizeEl.textContent = ''; return; }
    const totalKbps = selectedBitrate + ASSUMED_AUDIO_KBPS;
    const mb = (totalKbps * sourceDuration / 8 / 1024).toFixed(1);
    estSizeEl.textContent = 'Estimated output: ~' + mb + ' MB';
  }

  // ── Compress ─────────────────────────────────────────────────────────────
  compressBtn.addEventListener('click', startCompress);

  async function startCompress() {
    if (!sourceFile || encoding) return;

    const mode = document.querySelector('input[name="cmp-mode"]:checked').value;
    let videoBitrateKbps;

    if (mode === 'bitrate') {
      videoBitrateKbps = selectedBitrate;
    } else {
      // Target size mode — calculate required video bitrate
      if (!sourceDuration || sourceDuration <= 0) {
        alert('Could not determine video duration — please use Bitrate mode instead.');
        return;
      }
      const targetBytes = selectedSizeMB * 1048576;
      videoBitrateKbps = Math.max(200, Math.round(
        (targetBytes * 8 / 1000 / sourceDuration) - ASSUMED_AUDIO_KBPS
      ));
    }

    const preset2 = QUALITY_MAP[selectedQuality];

    // Show progress UI
    encoding = true;
    compressBtn.disabled = true;
    progressWrap.style.display = '';
    setProgress(0, 'Pass 1 of 2 — analysing…');
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 500);

    try {
      // Lazy-load FFmpeg on first use
      if (!ffmpegInstance) {
        setProgress(0, 'Loading encoder (~8 MB, cached after first use)…');
        const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
          import(FFMPEG_CDN),
          import(UTIL_CDN),
        ]);
        window._cmpFetchFile = fetchFile;
        window._cmpToBlobURL = toBlobURL;
        ffmpegInstance = new FFmpeg();
        const coreURL = await toBlobURL(CORE_JS,   'text/javascript');
        const wasmURL = await toBlobURL(CORE_WASM, 'application/wasm');
        await ffmpegInstance.load({ coreURL, wasmURL });

        ffmpegInstance.on('progress', ({ progress }) => {
          const pct = Math.round(Math.min(progress, 1) * 100);
          // pass 1 maps to 0-40%, pass 2 to 40-100%
          const cur = currentPass === 1
            ? Math.round(pct * 0.4)
            : 40 + Math.round(pct * 0.6);
          const passLabel = currentPass === 1
            ? 'Pass 1 of 2 — analysing…'
            : 'Pass 2 of 2 — encoding…';
          setProgress(cur, passLabel);
        });
      }

      const ffmpeg = ffmpegInstance;
      const { fetchFile } = { fetchFile: window._cmpFetchFile };

      // Write input file to WASM FS
      setProgress(0, 'Pass 1 of 2 — analysing…');
      await ffmpeg.writeFile('input.mp4', await fetchFile(sourceFile));

      // ── Pass 1: turbo analysis ─────────────────────────────────────────
      currentPass = 1;
      await ffmpeg.exec([
        '-y', '-i', 'input.mp4',
        '-c:v', 'libx264', '-b:v', videoBitrateKbps + 'k',
        '-preset', 'ultrafast',
        '-pass', '1', '-passlogfile', 'ffmpeg2pass',
        '-an', '-f', 'null', '/dev/null',
      ]);

      // ── Pass 2: real encode ────────────────────────────────────────────
      currentPass = 2;
      setProgress(40, 'Pass 2 of 2 — encoding…');
      await ffmpeg.exec([
        '-y', '-i', 'input.mp4',
        '-c:v', 'libx264', '-b:v', videoBitrateKbps + 'k',
        '-preset', preset2,
        '-pass', '2', '-passlogfile', 'ffmpeg2pass',
        '-c:a', 'copy',
        'output.mp4',
      ]);

      // Read result and trigger download
      const data = await ffmpeg.readFile('output.mp4');
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const baseName = sourceFile.name.replace(/\.[^.]+$/, '');
      a.href     = url;
      a.download = baseName + '_compressed.mp4';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      setProgress(100, 'Done!');
      setTimeout(() => { progressWrap.style.display = 'none'; }, 2000);

    } catch (err) {
      if (err?.message?.includes('exit') || err?.message?.includes('abort')) {
        setProgress(0, 'Cancelled.');
      } else {
        console.error('[compressor]', err);
        setProgress(0, 'Error: ' + (err.message || err));
      }
      setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);
    } finally {
      clearInterval(timerInterval);
      encoding = false;
      compressBtn.disabled = false;
    }
  }

  let currentPass = 1;

  cancelBtn.addEventListener('click', () => {
    if (ffmpegInstance && encoding) {
      ffmpegInstance.terminate();
      ffmpegInstance = null;
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    progressBar.style.width = pct + '%';
    progressLabel.textContent = label;
  }

  function updateTimer() {
    const s = Math.round((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const el = document.getElementById('cmp-elapsed');
    if (el) el.textContent = m + ':' + String(sec).padStart(2, '0');
  }

  function setActiveChip(container, active) {
    container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    active.classList.add('active');
  }

  function formatDuration(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
      ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
      : m + ':' + String(sec).padStart(2, '0');
  }

  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
