/**
 * extractor.js — extract audio from video files via FFmpeg.wasm
 * MP3 (192k), AAC (copy or transcode), WAV (PCM lossless)
 */

import { getFFmpeg, resetFFmpeg } from './ffmpeg-shared.js';

const FORMATS = {
  mp3:  { label: 'MP3 (192k)',  ext: 'mp3',  note: 'MP3 at 192 kbps — compatible everywhere.',           args: ['-vn', '-acodec', 'libmp3lame', '-b:a', '192k'] },
  aac:  { label: 'AAC',         ext: 'm4a',  note: 'AAC in M4A container — Apple / Android native.',     args: ['-vn', '-acodec', 'aac', '-b:a', '192k'] },
  wav:  { label: 'WAV (lossless)', ext: 'wav', note: 'PCM WAV — lossless but large. Good for editing.',  args: ['-vn', '-acodec', 'pcm_s16le'] },
};

export function initExtractor() {
  const dropzone    = document.getElementById('ext-dropzone');
  const fileInput   = document.getElementById('ext-file-input');
  const queueEl     = document.getElementById('ext-queue');
  const fmtChips    = document.getElementById('ext-format-chips');
  const fmtNote     = document.getElementById('ext-format-note');
  const pickFolderBtn = document.getElementById('ext-pick-folder');
  const folderLabel   = document.getElementById('ext-folder-label');
  const extractBtn  = document.getElementById('ext-extract-btn');
  const progressWrap = document.getElementById('ext-progress-wrap');
  const progressBar  = document.getElementById('ext-progress-bar');
  const progressLabel = document.getElementById('ext-progress-label');
  const cancelBtn   = document.getElementById('ext-cancel-btn');

  let queue           = [];
  let selectedFormat  = 'mp3';
  let outputDirHandle = null;
  let running         = false;
  let cancelRequested = false;

  // ── Format chips ──────────────────────────────────────────────────────────
  Object.entries(FORMATS).forEach(([key, fmt], i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = fmt.label;
    btn.addEventListener('click', () => {
      setChip(fmtChips, btn);
      selectedFormat = key;
      fmtNote.textContent = FORMATS[key].note;
    });
    fmtChips.appendChild(btn);
  });

  // ── Drop zone ─────────────────────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => addFiles([...fileInput.files]));
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('video/'));
    if (files.length) addFiles(files);
  });

  // ── Queue ─────────────────────────────────────────────────────────────────
  function addFiles(files) {
    files.forEach(f => queue.push({ file: f, status: 'waiting', statusText: 'Waiting' }));
    renderQueue();
    extractBtn.disabled = false;
    dropzone.querySelector('.ext-drop-text').textContent =
      queue.length === 1 ? queue[0].file.name : queue.length + ' videos queued';
    dropzone.classList.add('has-file');
  }

  function renderQueue() {
    if (!queue.length) { queueEl.style.display = 'none'; return; }
    queueEl.style.display = '';
    queueEl.innerHTML = queue.map((item, i) => {
      const sizeMB = (item.file.size / 1048576).toFixed(1);
      const rm = item.status === 'waiting'
        ? `<button class="cmp-q-remove" data-i="${i}" title="Remove">×</button>` : '';
      return `<div class="cmp-queue-item cmp-queue-item--${item.status}">
        <span class="cmp-q-name">${esc(item.file.name)}</span>
        <span class="cmp-q-size">${sizeMB} MB</span>
        <span class="cmp-q-status">${item.statusText}</span>
        ${rm}
      </div>`;
    }).join('');
    queueEl.querySelectorAll('.cmp-q-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        queue.splice(Number(btn.dataset.i), 1);
        if (!queue.length) {
          extractBtn.disabled = true;
          dropzone.classList.remove('has-file');
          dropzone.querySelector('.ext-drop-text').textContent = 'Drop a video here, or click to browse';
        }
        renderQueue();
      });
    });
  }

  // ── Output folder ─────────────────────────────────────────────────────────
  pickFolderBtn.addEventListener('click', async () => {
    if (!('showDirectoryPicker' in window)) { alert('Folder picking not supported — files will download individually.'); return; }
    try {
      outputDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      folderLabel.textContent = 'Output: ' + outputDirHandle.name + '/';
      folderLabel.style.display = '';
    } catch (e) { if (e.name !== 'AbortError') console.error(e); }
  });

  // ── Extract ───────────────────────────────────────────────────────────────
  extractBtn.addEventListener('click', runQueue);

  async function runQueue() {
    if (running) return;
    running = true;
    cancelRequested = false;
    extractBtn.disabled = true;
    progressWrap.style.display = '';

    const fmt = FORMATS[selectedFormat];

    try {
      const { ff, fetchFile } = await getFFmpeg(({ progress }) => {
        const pct = Math.min(Math.max(progress, 0), 1);
        setProgress(10 + Math.round(pct * 85), 'Extracting… ' + Math.round(pct * 100) + '%');
      });

      for (let i = 0; i < queue.length; i++) {
        if (cancelRequested) break;
        const item = queue[i];
        if (item.status === 'done') continue;

        item.status = 'encoding';
        item.statusText = 'Extracting…';
        renderQueue();

        setProgress(5, 'Reading file…');

        try {
          const inExt  = item.file.name.split('.').pop().toLowerCase();
          const inName = 'input.' + inExt;
          const outName = 'output.' + fmt.ext;

          await ff.writeFile(inName, await fetchFile(item.file));

          setProgress(10, 'Extracting audio…');
          const ret = await ff.exec(['-y', '-i', inName, ...fmt.args, outName]);
          if (ret !== 0) throw new Error('FFmpeg exited with code ' + ret);

          const data = await ff.readFile(outName);
          if (!data || data.length === 0) throw new Error('Output is empty');

          const blob = new Blob([data], { type: 'audio/' + fmt.ext });
          const saveName = item.file.name.replace(/\.[^.]+$/, '') + '.' + fmt.ext;
          await saveFile(blob, saveName);

          try { await ff.deleteFile(inName);  } catch (_) {}
          try { await ff.deleteFile(outName); } catch (_) {}

          item.status = 'done';
          item.statusText = '✓ Done — ' + (blob.size / 1048576).toFixed(1) + ' MB';

        } catch (err) {
          if (cancelRequested) {
            item.status = 'waiting'; item.statusText = 'Cancelled';
          } else {
            item.status = 'error';
            item.statusText = 'Error: ' + (err.message || err);
            console.error('[extractor]', err);
          }
        }
        renderQueue();
      }

      const allDone = queue.every(q => q.status === 'done');
      setProgress(100, allDone ? 'All done!' : 'Finished.');
      setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);

    } catch (err) {
      setProgress(0, 'Error: ' + (err.message || err));
      resetFFmpeg();
      setTimeout(() => { progressWrap.style.display = 'none'; }, 4000);
    } finally {
      running = false;
      extractBtn.disabled = queue.every(q => q.status === 'done');
    }
  }

  cancelBtn.addEventListener('click', () => {
    cancelRequested = true;
    running = false;
    extractBtn.disabled = false;
    progressWrap.style.display = 'none';
    queue.forEach(q => { if (q.status === 'encoding') { q.status = 'waiting'; q.statusText = 'Waiting'; } });
    renderQueue();
  });

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveFile(blob, name) {
    if (outputDirHandle) {
      try {
        const fh = await outputDirHandle.getFileHandle(name, { create: true });
        const w  = await fh.createWritable();
        await w.write(blob); await w.close(); return;
      } catch (e) { console.warn('Dir write failed:', e); }
    }
    if ('showSaveFilePicker' in window) {
      try {
        const fh = await window.showSaveFilePicker({ suggestedName: name });
        const w  = await fh.createWritable();
        await w.write(blob); await w.close(); return;
      } catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
    }
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    progressLabel.textContent = label;
  }

  function setChip(container, active) {
    container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    active.classList.add('active');
  }

  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
}
