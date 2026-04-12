/**
 * compressor.js — browser-side H.264 video compression via FFmpeg.wasm
 * Single-pass CBR encoding, batch queue, File System Access API save.
 */

const LIB = new URL('./lib/ffmpeg/', import.meta.url).href;

const BITRATE_PRESETS    = [1500, 2000, 2250, 2500, 3000, 5000];
const SIZE_PRESETS       = [3, 5, 10, 15, 20, 30]; // MB
const SPEED_MAP          = { fast: 'ultrafast', better: 'veryfast' };
const ASSUMED_AUDIO_KBPS = 128;

export function initCompressor() {
  // ── DOM refs ────────────────────────────────────────────────────────────
  const dropzone           = document.getElementById('cmp-dropzone');
  const fileInput          = document.getElementById('cmp-file-input');
  const folderInput        = document.getElementById('cmp-folder-input');
  const queueEl            = document.getElementById('cmp-queue');
  const bitrateSection     = document.getElementById('cmp-bitrate-section');
  const sizeSection        = document.getElementById('cmp-size-section');
  const bitrateChips       = document.getElementById('cmp-bitrate-chips');
  const sizeChips          = document.getElementById('cmp-size-chips');
  const customBitrateWrap  = document.getElementById('cmp-custom-bitrate-wrap');
  const customBitrateInput = document.getElementById('cmp-custom-bitrate');
  const customSizeWrap     = document.getElementById('cmp-custom-size-wrap');
  const customSizeInput    = document.getElementById('cmp-custom-size');
  const estSizeEl          = document.getElementById('cmp-est-size');
  const speedChips         = document.getElementById('cmp-speed-chips');
  const compressBtn        = document.getElementById('cmp-compress-btn');
  const pickFolderBtn      = document.getElementById('cmp-pick-folder');
  const folderLabel        = document.getElementById('cmp-folder-label');
  const progressWrap       = document.getElementById('cmp-progress-wrap');
  const progressBar        = document.getElementById('cmp-progress-bar');
  const progressLabel      = document.getElementById('cmp-progress-label');
  const cancelBtn          = document.getElementById('cmp-cancel-btn');

  // ── State ────────────────────────────────────────────────────────────────
  let queue           = [];       // [{ file, status, statusText, duration }]
  let selectedBitrate = BITRATE_PRESETS[1];
  let selectedSizeMB  = SIZE_PRESETS[2];
  let selectedSpeed   = 'fast';
  let outputDirHandle = null;
  let ffmpegInstance  = null;
  let fetchFileUtil   = null;
  let loadPromise     = null;
  let encoding        = false;
  let cancelRequested = false;
  let startTime       = 0;
  let timerInterval   = null;

  // ── Build bitrate chips ──────────────────────────────────────────────────
  BITRATE_PRESETS.forEach(kbps => {
    const btn = document.createElement('button');
    btn.type = 'button';
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

  // ── Speed chips ──────────────────────────────────────────────────────────
  [['Fast', 'fast'], ['Better', 'better']].forEach(([label, key]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (key === selectedSpeed ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      setActiveChip(speedChips, btn);
      selectedSpeed = key;
    });
    speedChips.appendChild(btn);
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
  fileInput.addEventListener('change', () => addFiles([...fileInput.files]));
  folderInput.addEventListener('change', () => addFiles([...folderInput.files].filter(f => f.type.startsWith('video/'))));

  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('video/'));
    if (files.length) addFiles(files);
  });

  // ── Output folder picker ─────────────────────────────────────────────────
  pickFolderBtn.addEventListener('click', async () => {
    if (!('showDirectoryPicker' in window)) {
      alert('Your browser does not support folder picking. Files will download normally.');
      return;
    }
    try {
      outputDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      folderLabel.textContent = 'Output: ' + outputDirHandle.name + '/';
      folderLabel.style.display = '';
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
    }
  });

  // ── Queue management ──────────────────────────────────────────────────────
  function addFiles(files) {
    files.forEach(f => {
      queue.push({ file: f, status: 'waiting', statusText: 'Waiting', duration: 0 });
      // Probe duration
      const url = URL.createObjectURL(f);
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      vid.src = url;
      vid.addEventListener('loadedmetadata', () => {
        const item = queue.find(q => q.file === f);
        if (item) item.duration = isFinite(vid.duration) ? vid.duration : 0;
        URL.revokeObjectURL(url);
        updateEstSize();
        renderQueue();
      });
      vid.addEventListener('error', () => URL.revokeObjectURL(url));
    });
    renderQueue();
    compressBtn.disabled = false;
    dropzone.classList.add('has-file');
    dropzone.querySelector('.cmp-drop-text').textContent =
      queue.length === 1 ? esc(queue[0].file.name) : queue.length + ' videos queued';
  }

  function renderQueue() {
    if (queue.length === 0) { queueEl.style.display = 'none'; return; }
    queueEl.style.display = '';
    queueEl.innerHTML = queue.map((item, i) => {
      const sizeMB = (item.file.size / 1048576).toFixed(1);
      const removeBtn = item.status === 'waiting'
        ? `<button class="cmp-q-remove" data-i="${i}" title="Remove">×</button>` : '';
      return `<div class="cmp-queue-item cmp-queue-item--${item.status}">
        <span class="cmp-q-name">${esc(item.file.name)}</span>
        <span class="cmp-q-size">${sizeMB} MB</span>
        <span class="cmp-q-status">${item.statusText}</span>
        ${removeBtn}
      </div>`;
    }).join('');
    queueEl.querySelectorAll('.cmp-q-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        queue.splice(i, 1);
        if (queue.length === 0) {
          compressBtn.disabled = true;
          dropzone.classList.remove('has-file');
          dropzone.querySelector('.cmp-drop-text').textContent = 'Drop videos here, or click to browse';
        } else {
          dropzone.querySelector('.cmp-drop-text').textContent =
            queue.length === 1 ? esc(queue[0].file.name) : queue.length + ' videos queued';
        }
        renderQueue();
      });
    });
  }

  function updateEstSize() {
    const mode = document.querySelector('input[name="cmp-mode"]:checked')?.value;
    const totalDur = queue.reduce((s, q) => s + q.duration, 0);
    if (mode !== 'bitrate' || !totalDur) { estSizeEl.textContent = ''; return; }
    const mb = ((selectedBitrate + ASSUMED_AUDIO_KBPS) * totalDur / 8 / 1024).toFixed(1);
    estSizeEl.textContent = 'Estimated total output: ~' + mb + ' MB';
  }

  // ── Lazy-load FFmpeg ──────────────────────────────────────────────────────
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
        const elapsed = (Date.now() - startTime) / 1000;
        const etaStr = pct > 0.02 && elapsed > 2
          ? ' — ' + formatDuration(Math.round(elapsed / pct * (1 - pct))) + ' remaining'
          : '';
        setProgress(10 + Math.round(pct * 88), 'Encoding… ' + Math.round(pct * 100) + '%' + etaStr);
      });
      await ff.load({
        coreURL: LIB + 'ffmpeg-core.js',
        wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
      });
      ffmpegInstance = ff;
      return ff;
    })();
    return loadPromise;
  }

  document.querySelector('.tab-btn[data-tab="compress"]')?.addEventListener('click', () => {
    if (!loadPromise) startLoad().catch(() => { loadPromise = null; });
  }, { once: true });

  // ── Compress all ──────────────────────────────────────────────────────────
  compressBtn.addEventListener('click', startQueue);

  async function startQueue() {
    if (encoding) return;
    cancelRequested = false;
    encoding = true;
    compressBtn.disabled = true;
    progressWrap.style.display = '';

    try {
      const ff = await startLoad();

      for (let i = 0; i < queue.length; i++) {
        if (cancelRequested) break;
        const item = queue[i];
        if (item.status === 'done') continue;

        item.status = 'encoding';
        item.statusText = 'Encoding…';
        renderQueue();

        startTime = Date.now();
        timerInterval = setInterval(updateTimer, 500);

        try {
          const videoBitrateKbps = getBitrate(item);
          const preset = SPEED_MAP[selectedSpeed];

          setProgress(5, 'Reading file…');
          await ff.writeFile('input.mp4', await fetchFileUtil(item.file));

          setProgress(10, 'Encoding…');
          const ret = await ff.exec([
            '-y', '-i', 'input.mp4',
            '-c:v', 'libx264',
            '-b:v', videoBitrateKbps + 'k',
            '-preset', preset,
            '-c:a', 'copy',
            'output.mp4',
          ]);
          if (ret !== 0) throw new Error('FFmpeg exited with code ' + ret);

          const data = await ff.readFile('output.mp4');
          if (!data || data.length === 0) throw new Error('Output is empty');

          const blob = new Blob([data], { type: 'video/mp4' });
          const baseName = item.file.name.replace(/\.[^.]+$/, '') + '_compressed.mp4';
          await saveFile(blob, baseName);

          item.status = 'done';
          const outMB = (blob.size / 1048576).toFixed(1);
          item.statusText = '✓ Done — ' + outMB + ' MB';
          renderQueue();

        } catch (err) {
          if (cancelRequested) {
            item.status = 'waiting';
            item.statusText = 'Cancelled';
          } else {
            item.status = 'error';
            item.statusText = 'Error: ' + (err.message || err);
            console.error('[compressor]', err);
          }
          renderQueue();
        } finally {
          clearInterval(timerInterval);
        }
      }

      const allDone = queue.every(q => q.status === 'done');
      setProgress(100, allDone ? 'All done!' : 'Finished.');
      setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);

    } catch (err) {
      setProgress(0, 'Error: ' + (err.message || err));
      loadPromise = null;
      setTimeout(() => { progressWrap.style.display = 'none'; }, 3000);
    } finally {
      encoding = false;
      compressBtn.disabled = queue.every(q => q.status === 'done');
    }
  }

  function getBitrate(item) {
    const mode = document.querySelector('input[name="cmp-mode"]:checked').value;
    if (mode === 'bitrate') return selectedBitrate;
    if (!item.duration || item.duration <= 0) return selectedBitrate; // fallback
    const targetBytes = selectedSizeMB * 1048576;
    return Math.max(200, Math.round((targetBytes * 8 / 1000 / item.duration) - ASSUMED_AUDIO_KBPS));
  }

  cancelBtn.addEventListener('click', () => {
    cancelRequested = true;
    if (ffmpegInstance && encoding) {
      ffmpegInstance.terminate();
      ffmpegInstance = null;
      loadPromise    = null;
      fetchFileUtil  = null;
    }
    clearInterval(timerInterval);
    progressWrap.style.display = 'none';
    encoding = false;
    compressBtn.disabled = false;
    // Reset encoding items back to waiting
    queue.forEach(q => { if (q.status === 'encoding') { q.status = 'waiting'; q.statusText = 'Waiting'; } });
    renderQueue();
  });

  // ── File save ─────────────────────────────────────────────────────────────
  async function saveFile(blob, suggestedName) {
    if (outputDirHandle) {
      try {
        const fh = await outputDirHandle.getFileHandle(suggestedName, { create: true });
        const w  = await fh.createWritable();
        await w.write(blob);
        await w.close();
        return;
      } catch (e) {
        console.warn('Dir write failed, falling back:', e);
      }
    }
    if ('showSaveFilePicker' in window) {
      try {
        const fh = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // user cancelled
        console.warn('showSaveFilePicker failed, falling back:', e);
      }
    }
    // Fallback: browser download
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: suggestedName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    progressBar.style.width = pct + '%';
    progressLabel.textContent = label;
  }

  function updateTimer() {
    const s   = Math.round((Date.now() - startTime) / 1000);
    const el  = document.getElementById('cmp-elapsed');
    if (el) el.textContent = formatDuration(s);
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
