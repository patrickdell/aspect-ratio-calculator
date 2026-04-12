/**
 * compressor.js — browser-side H.264 video compression via FFmpeg.wasm
 * Two-pass encoding: pass 1 ultrafast (analysis), pass 2 with chosen quality preset.
 * Single-threaded core — no SharedArrayBuffer / COOP/COEP headers required.
 *
 * FFmpeg files are self-hosted under v2/lib/ffmpeg/ (downloaded at Netlify build time).
 * This avoids the cross-origin Worker restriction that blocks CDN-served scripts.
 * The build command in netlify.toml downloads the exact versions below.
 */

// Resolve relative to this module's own URL so it works under any base path.
const LIB = new URL('./lib/ffmpeg/', import.meta.url).href;


const BITRATE_PRESETS    = [1500, 2000, 2250, 2500, 3000, 5000];
const SIZE_PRESETS       = [3, 5, 10, 15, 20, 30]; // MB
// x264 presets in WASM are much slower than native — use faster presets.
// veryfast ≈ Handbrake "fast", fast ≈ Handbrake "medium", medium ≈ Handbrake "slow".
const QUALITY_MAP        = { low: 'veryfast', medium: 'fast', high: 'medium' };
const ASSUMED_AUDIO_KBPS = 128;

export function initCompressor() {
  // ── DOM refs ────────────────────────────────────────────────────────────
  const dropzone           = document.getElementById('cmp-dropzone');
  const fileInput          = document.getElementById('cmp-file-input');
  const infoBox            = document.getElementById('cmp-info');
  const bitrateSection     = document.getElementById('cmp-bitrate-section');
  const sizeSection        = document.getElementById('cmp-size-section');
  const bitrateChips       = document.getElementById('cmp-bitrate-chips');
  const sizeChips          = document.getElementById('cmp-size-chips');
  const customBitrateWrap  = document.getElementById('cmp-custom-bitrate-wrap');
  const customBitrateInput = document.getElementById('cmp-custom-bitrate');
  const customSizeWrap     = document.getElementById('cmp-custom-size-wrap');
  const customSizeInput    = document.getElementById('cmp-custom-size');
  const estSizeEl          = document.getElementById('cmp-est-size');
  const qualityChips       = document.getElementById('cmp-quality-chips');
  const compressBtn        = document.getElementById('cmp-compress-btn');
  const progressWrap       = document.getElementById('cmp-progress-wrap');
  const progressBar        = document.getElementById('cmp-progress-bar');
  const progressLabel      = document.getElementById('cmp-progress-label');
  const cancelBtn          = document.getElementById('cmp-cancel-btn');

  // ── State ────────────────────────────────────────────────────────────────
  let sourceFile       = null;
  let sourceDuration   = 0;
  let selectedBitrate  = BITRATE_PRESETS[1]; // 2000 kbps
  let selectedSizeMB   = SIZE_PRESETS[2];    // 10 MB
  let selectedQuality  = 'medium';
  let ffmpegInstance   = null;
  let fetchFileUtil    = null;
  let loadPromise      = null; // shared across calls so we only load once
  let encoding         = false;
  let currentPass      = 1;
  let startTime        = 0;
  let timerInterval    = null;

  // ── Build bitrate chips ──────────────────────────────────────────────────
  BITRATE_PRESETS.forEach(kbps => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'chip' + (kbps === selectedBitrate ? ' active' : '');
    btn.textContent = kbps.toLocaleString('en') + ' kbps';
    btn.addEventListener('click', () => {
      customBitrateWrap.style.display = 'none';
      setActiveChip(bitrateChips, btn);
      selectedBitrate = kbps;
      updateEstSize();
    });
    bitrateChips.appendChild(btn);
  });

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

  // ── Build size chips ─────────────────────────────────────────────────────
  SIZE_PRESETS.forEach(mb => {
    const btn = document.createElement('button');
    btn.type      = 'button';
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
    btn.type      = 'button';
    btn.className = 'chip' + (key === selectedQuality ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      setActiveChip(qualityChips, btn);
      selectedQuality = key;
    });
    qualityChips.appendChild(btn);
  });

  // ── Mode radio switching ─────────────────────────────────────────────────
  document.querySelectorAll('input[name="cmp-mode"]').forEach(r =>
    r.addEventListener('change', () => {
      const mode = document.querySelector('input[name="cmp-mode"]:checked').value;
      bitrateSection.style.display = mode === 'bitrate' ? '' : 'none';
      sizeSection.style.display    = mode === 'size'    ? '' : 'none';
      estSizeEl.style.display      = mode === 'bitrate' ? '' : 'none';
      updateEstSize();
    })
  );

  // ── Dropzone ─────────────────────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) loadFile(f);
  });

  // ── Load file ─────────────────────────────────────────────────────────────
  function loadFile(file) {
    sourceFile = file;
    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.src = url;
    vid.addEventListener('loadedmetadata', () => {
      sourceDuration = isFinite(vid.duration) ? vid.duration : 0;
      URL.revokeObjectURL(url);
      showInfo(file, vid);
      updateEstSize();
      compressBtn.disabled = false;
    });
    vid.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      sourceDuration = 0;
      showInfo(file, null);
      compressBtn.disabled = false;
    });
  }

  function showInfo(file, vid) {
    const sizeMB = (file.size / 1048576).toFixed(1);
    const dur    = vid && isFinite(vid.duration) ? formatDuration(vid.duration) : '—';
    const res    = vid && vid.videoWidth ? vid.videoWidth + ' × ' + vid.videoHeight + ' px' : '—';
    const kbps   = sourceDuration > 0
      ? Math.round(file.size * 8 / 1000 / sourceDuration) + ' kbps'
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

  // ── Lazy-load FFmpeg (returns shared promise so we only load once) ────────
  // Files are self-hosted under v2/lib/ffmpeg/ — same-origin, so the Worker
  // can be spawned without any cross-origin restrictions or blob: wrapping.
  function startLoad() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [{ FFmpeg }, { fetchFile }] = await Promise.all([
        import(LIB + 'index.js'),
        import(LIB + 'util.js'),
      ]);
      fetchFileUtil = fetchFile;

      const ff = new FFmpeg();

      ff.on('progress', ({ progress }) => {
        const pct = Math.min(Math.max(progress, 0), 1);
        const pctInt = Math.round(pct * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const etaStr = pct > 0.02 && elapsed > 2
          ? ' — ' + formatDuration(Math.round(elapsed / pct * (1 - pct))) + ' remaining'
          : '';
        setProgress(10 + Math.round(pct * 88), 'Encoding… ' + pctInt + '%' + etaStr);
      });

      // worker.js is same-origin so FFmpeg's default Worker spawn works fine.
      // No classWorkerURL needed.
      // ffmpeg-core.js is self-hosted (same-origin, referenced by worker.js).
      // ffmpeg-core.wasm is served from CDN — it's 30 MB and exceeds Cloudflare
      // Pages' 25 MB file limit. The Worker can fetch it cross-origin because
      // the CDN serves Access-Control-Allow-Origin: *.
      await ff.load({
        coreURL: LIB + 'ffmpeg-core.js',
        wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
      });
      ffmpegInstance = ff;
      return ff;
    })();
    return loadPromise;
  }

  // ── Pre-warm: start loading when the tab is first clicked ────────────────
  document.querySelector('.tab-btn[data-tab="compress"]')?.addEventListener('click', () => {
    if (!loadPromise) startLoad().catch(() => { loadPromise = null; });
  }, { once: true });

  // ── Compress ─────────────────────────────────────────────────────────────
  compressBtn.addEventListener('click', startCompress);

  async function startCompress() {
    if (!sourceFile || encoding) return;

    const mode = document.querySelector('input[name="cmp-mode"]:checked').value;
    let videoBitrateKbps;

    if (mode === 'bitrate') {
      videoBitrateKbps = selectedBitrate;
    } else {
      if (!sourceDuration || sourceDuration <= 0) {
        alert('Could not determine video duration — use Bitrate mode instead.');
        return;
      }
      const targetBytes = selectedSizeMB * 1048576;
      videoBitrateKbps = Math.max(200,
        Math.round((targetBytes * 8 / 1000 / sourceDuration) - ASSUMED_AUDIO_KBPS)
      );
    }

    const qualityPreset = QUALITY_MAP[selectedQuality];

    encoding = true;
    compressBtn.disabled = true;
    progressWrap.style.display = '';
    setProgress(0, 'Loading encoder…');
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 500);

    try {
      const ff = await startLoad();

      setProgress(5, 'Reading file…');
      await ff.writeFile('input.mp4', await fetchFileUtil(sourceFile));

      // Single-pass CBR encode — two-pass passlog persistence is unreliable
      // in FFmpeg.wasm's virtual filesystem across exec() calls.
      currentPass = 1;
      setProgress(10, 'Encoding…');
      const ret = await ff.exec([
        '-y', '-i', 'input.mp4',
        '-c:v', 'libx264',
        '-b:v', videoBitrateKbps + 'k',
        '-preset', qualityPreset,
        '-c:a', 'copy',
        'output.mp4',
      ]);
      if (ret !== 0) throw new Error('FFmpeg exited with code ' + ret);

      const data = await ff.readFile('output.mp4');
      if (!data || data.length === 0) throw new Error('Output file is empty — encode failed');
      const blob = new Blob([data], { type: 'video/mp4' });
      const url      = URL.createObjectURL(blob);
      const a        = document.createElement('a');
      const baseName = sourceFile.name.replace(/\.[^.]+$/, '');
      a.href         = url;
      a.download     = baseName + '_compressed.mp4';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      setProgress(100, 'Done!');
      setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);

    } catch (err) {
      const msg = err?.message || String(err);
      if (/exit|abort|terminat/i.test(msg)) {
        setProgress(0, 'Cancelled.');
      } else {
        console.error('[compressor]', err);
        setProgress(0, 'Error: ' + msg);
      }
      loadPromise = null; // allow retry
      setTimeout(() => { progressWrap.style.display = 'none'; }, 3000);
    } finally {
      clearInterval(timerInterval);
      encoding = false;
      compressBtn.disabled = false;
    }
  }

  cancelBtn.addEventListener('click', () => {
    if (ffmpegInstance && encoding) {
      ffmpegInstance.terminate();
      ffmpegInstance = null;
      fetchFileUtil  = null;
      loadPromise    = null; // allow retry after cancel
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    progressBar.style.width = pct + '%';
    progressLabel.textContent = label;
  }

  function updateTimer() {
    const s   = Math.round((Date.now() - startTime) / 1000);
    const m   = Math.floor(s / 60);
    const sec = s % 60;
    const el  = document.getElementById('cmp-elapsed');
    if (el) el.textContent = m + ':' + String(sec).padStart(2, '0');
  }

  function setActiveChip(container, active) {
    container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    active.classList.add('active');
  }

  function formatDuration(s) {
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
      ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
      : m + ':' + String(sec).padStart(2, '0');
  }

  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
