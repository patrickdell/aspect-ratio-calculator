/**
 * trimmer.js — browser-side video/audio trimmer via FFmpeg.wasm stream copy
 * Supports video (MP4/MOV/MKV/WebM) and audio (MP3/AAC/WAV/M4A/OGG).
 * Stream copy = no re-encode = near-instant.
 */

import { getFFmpeg, resetFFmpeg } from './ffmpeg-shared.js';

const SUPPORTED_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v']);
const SUPPORTED_AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'm4a', 'ogg', 'flac', 'opus']);
const UNSUPPORTED_EXTS     = new Set(['mxf', 'mts', 'm2ts']);

const DEFAULT_FPS = 30;

export function initTrimmer() {
  const dropzone      = document.getElementById('trm-dropzone');
  const fileInput     = document.getElementById('trm-file-input');
  const playerWrap    = document.getElementById('trm-player-wrap');
  const videoEl       = document.getElementById('trm-video');
  const audioEl       = document.getElementById('trm-audio');
  const formatWarn    = document.getElementById('trm-format-warn');
  const sizeWarn      = document.getElementById('trm-size-warn');
  const trackBg       = document.getElementById('trm-track-bg');
  const playheadEl    = document.getElementById('trm-playhead');
  const rangeIn       = document.getElementById('trm-range-in');
  const rangeOut      = document.getElementById('trm-range-out');
  const inLabel       = document.getElementById('trm-in-label');
  const outLabel      = document.getElementById('trm-out-label');
  const clipLabel     = document.getElementById('trm-clip-label');

  // Playhead row
  const phBackFrame   = document.getElementById('trm-ph-back-frame');
  const phBackSec     = document.getElementById('trm-ph-back-sec');
  const playClipBtn   = document.getElementById('trm-play-clip');
  const phFwdSec      = document.getElementById('trm-ph-fwd-sec');
  const phFwdFrame    = document.getElementById('trm-ph-fwd-frame');

  // In point row
  const inBackFrame   = document.getElementById('trm-in-back-frame');
  const inBackSec     = document.getElementById('trm-in-back-sec');
  const setInBtn      = document.getElementById('trm-set-in');
  const inFwdSec      = document.getElementById('trm-in-fwd-sec');
  const inFwdFrame    = document.getElementById('trm-in-fwd-frame');

  // Out point row
  const outBackFrame  = document.getElementById('trm-out-back-frame');
  const outBackSec    = document.getElementById('trm-out-back-sec');
  const setOutBtn     = document.getElementById('trm-set-out');
  const outFwdSec     = document.getElementById('trm-out-fwd-sec');
  const outFwdFrame   = document.getElementById('trm-out-fwd-frame');

  const trimBtn       = document.getElementById('trm-trim-btn');
  const progressWrap  = document.getElementById('trm-progress-wrap');
  const progressBar   = document.getElementById('trm-progress-bar');
  const progressLabel = document.getElementById('trm-progress-label');
  const saveHint      = document.getElementById('trm-save-hint');
  const waveformCanvas = document.getElementById('trm-waveform');
  const waveCtx        = waveformCanvas.getContext('2d');

  let waveformPeaks = null;

  // ── Platform-aware save hint ──────────────────────────────────────────────
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) {
    trimBtn.textContent = 'Trim & Save to Camera Roll';
    saveHint.textContent = '📷 Tap "Save Video" in the share sheet to add directly to your Photos library.';
    saveHint.style.display = '';
  } else if (/Android/i.test(ua)) {
    trimBtn.textContent = 'Trim & Save to Gallery';
    saveHint.textContent = '📷 Choose your gallery or files app from the share sheet to save the trimmed clip.';
    saveHint.style.display = '';
  }

  let currentFile       = null;
  let blobUrl           = null;
  let inPoint           = 0;
  let outPoint          = 0;
  let duration          = 0;
  let isAudioOnly       = false;
  let fps               = DEFAULT_FPS;
  let clipPreviewActive = false;
  let clipPreviewStop   = null;

  // ── Active media element ──────────────────────────────────────────────────
  function media() { return isAudioOnly ? audioEl : videoEl; }

  // ── Playhead needle ───────────────────────────────────────────────────────
  function updatePlayhead() {
    const pct = duration ? (media().currentTime / duration) * 100 : 0;
    playheadEl.style.left = pct + '%';
  }

  // Keep needle updated while playing / seeking
  videoEl.addEventListener('timeupdate', updatePlayhead);
  videoEl.addEventListener('seeked',     updatePlayhead);
  audioEl.addEventListener('timeupdate', updatePlayhead);
  audioEl.addEventListener('seeked',     updatePlayhead);

  // ── Drop zone ─────────────────────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const f = [...e.dataTransfer.files].find(f =>
      f.type.startsWith('video/') || f.type.startsWith('audio/')
    );
    if (f) loadFile(f);
  });

  // ── Load file ─────────────────────────────────────────────────────────────
  function loadFile(file) {
    cancelClipPreview();
    currentFile = file;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(file);

    const ext = file.name.split('.').pop().toLowerCase();
    isAudioOnly = SUPPORTED_AUDIO_EXTS.has(ext) || file.type.startsWith('audio/');

    videoEl.style.display = isAudioOnly ? 'none' : '';
    audioEl.style.display = isAudioOnly ? ''     : 'none';

    formatWarn.style.display = UNSUPPORTED_EXTS.has(ext) ? '' : 'none';

    const mb = file.size / 1048576;
    sizeWarn.style.display = mb > 300 ? '' : 'none';
    sizeWarn.textContent = mb > 800
      ? `⚠ Large file (${mb.toFixed(0)} MB) — may fail on this device due to memory limits`
      : `⚠ Large file (${mb.toFixed(0)} MB) — processing may be slow`;

    const med = media();
    med.src = blobUrl;
    med.load();

    med.addEventListener('loadedmetadata', () => {
      duration = med.duration;
      inPoint  = 0;
      outPoint = duration;
      fps      = DEFAULT_FPS;

      [rangeIn, rangeOut].forEach(r => {
        r.min  = '0';
        r.max  = String(duration);
        r.step = String(Math.min(0.01, duration / 10000));
      });
      rangeIn.value  = '0';
      rangeOut.value = String(duration);

      updateLabels();
      updatePlayhead();
      playerWrap.style.display = '';
      dropzone.querySelector('.trm-drop-text').textContent = file.name;
      dropzone.classList.add('has-file');
      trimBtn.disabled = false;
      playClipBtn.textContent = '▶ Preview clip';
      progressWrap.style.display = 'none';
    }, { once: true });

    // Warm up FFmpeg in background
    getFFmpeg().catch(() => {});

    // Build waveform async (silent fail for unsupported formats)
    buildWaveform(file);
  }

  async function buildWaveform(file) {
    waveformPeaks = null;
    waveformCanvas.style.display = 'none';
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded  = await audioCtx.decodeAudioData(arrayBuffer);
      await audioCtx.close();

      const raw     = decoded.getChannelData(0);
      const W       = waveformCanvas.parentElement.clientWidth || 600;
      const step    = Math.max(1, Math.floor(raw.length / W));
      const peaks   = new Float32Array(W);
      for (let i = 0; i < W; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += raw[i * step + j] ** 2;
        peaks[i] = Math.sqrt(sum / step);
      }
      // Normalise
      let max = 0.001;
      for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
      for (let i = 0; i < peaks.length; i++) peaks[i] /= max;

      waveformPeaks = peaks;
      waveformCanvas.width  = W;
      waveformCanvas.height = 56;
      waveformCanvas.style.display = '';
      drawWaveform();
    } catch (_) { /* silent — some formats may not decode */ }
  }

  function drawWaveform() {
    if (!waveformPeaks) return;
    const W = waveformCanvas.width, H = waveformCanvas.height;
    waveCtx.clearRect(0, 0, W, H);
    const x1 = duration ? Math.round((inPoint  / duration) * W) : 0;
    const x2 = duration ? Math.round((outPoint / duration) * W) : W;
    for (let i = 0; i < W; i++) {
      const amp      = waveformPeaks[i] * (H / 2) * 0.88;
      const inRange  = i >= x1 && i <= x2;
      waveCtx.fillStyle = inRange ? 'rgba(214,48,49,0.80)' : 'rgba(160,128,128,0.22)';
      waveCtx.fillRect(i, H / 2 - amp, 1, amp * 2 || 1);
    }
  }

  // ── Click-to-seek on the track bar ────────────────────────────────────────
  trackBg.addEventListener('pointerdown', e => {
    if (!currentFile || !duration) return;
    // Let range thumb pointer-events handle thumb drags naturally
    if (e.target.classList.contains('trm-range')) return;
    const rect = trackBg.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    media().currentTime = fraction * duration;
    cancelClipPreview();
  });

  // ── Timeline range handle drag (seeks so user can preview the frame) ──────
  rangeIn.addEventListener('input', () => {
    inPoint = Math.min(Number(rangeIn.value), outPoint - 0.05);
    rangeIn.value = String(inPoint);
    media().currentTime = inPoint;
    cancelClipPreview();
    updateLabels();
  });

  rangeOut.addEventListener('input', () => {
    outPoint = Math.max(Number(rangeOut.value), inPoint + 0.05);
    rangeOut.value = String(outPoint);
    media().currentTime = outPoint;
    cancelClipPreview();
    updateLabels();
  });

  // ── Playhead step buttons ─────────────────────────────────────────────────
  function stepPlayhead(delta) {
    if (!currentFile) return;
    cancelClipPreview();
    const med = media();
    med.currentTime = Math.max(0, Math.min(duration, med.currentTime + delta));
  }

  phBackFrame.addEventListener('click', () => stepPlayhead(-(1 / fps)));
  phFwdFrame .addEventListener('click', () => stepPlayhead(  1 / fps));
  phBackSec  .addEventListener('click', () => stepPlayhead(-1));
  phFwdSec   .addEventListener('click', () => stepPlayhead( 1));

  // ── Mark In / Out at current playhead position ────────────────────────────
  function markIn() {
    if (!currentFile) return;
    inPoint = Math.min(media().currentTime, outPoint - 0.05);
    rangeIn.value = String(inPoint);
    cancelClipPreview();
    updateLabels();
  }

  function markOut() {
    if (!currentFile) return;
    outPoint = Math.max(media().currentTime, inPoint + 0.05);
    rangeOut.value = String(outPoint);
    cancelClipPreview();
    updateLabels();
  }

  setInBtn .addEventListener('click', markIn);
  setOutBtn.addEventListener('click', markOut);

  // ── In / Out nudge buttons (do NOT seek the video) ────────────────────────
  function nudgeIn(delta) {
    if (!currentFile) return;
    inPoint = Math.max(0, Math.min(inPoint + delta, outPoint - 0.05));
    rangeIn.value = String(inPoint);
    updateLabels();
  }

  function nudgeOut(delta) {
    if (!currentFile) return;
    outPoint = Math.max(inPoint + 0.05, Math.min(outPoint + delta, duration));
    rangeOut.value = String(outPoint);
    updateLabels();
  }

  inBackFrame .addEventListener('click', () => nudgeIn(-(1 / fps)));
  inFwdFrame  .addEventListener('click', () => nudgeIn(  1 / fps));
  inBackSec   .addEventListener('click', () => nudgeIn(-1));
  inFwdSec    .addEventListener('click', () => nudgeIn( 1));

  outBackFrame.addEventListener('click', () => nudgeOut(-(1 / fps)));
  outFwdFrame .addEventListener('click', () => nudgeOut(  1 / fps));
  outBackSec  .addEventListener('click', () => nudgeOut(-1));
  outFwdSec   .addEventListener('click', () => nudgeOut( 1));

  // ── Clip preview ──────────────────────────────────────────────────────────
  playClipBtn.addEventListener('click', () => {
    if (!currentFile) return;
    if (clipPreviewActive) { cancelClipPreview(); return; }
    startClipPreview();
  });

  function startClipPreview() {
    cancelClipPreview();
    const med = media();
    med.currentTime = inPoint;

    const onTimeUpdate = () => {
      if (med.currentTime >= outPoint) cancelClipPreview();
    };
    const onEnded = () => cancelClipPreview();

    med.addEventListener('timeupdate', onTimeUpdate);
    med.addEventListener('ended',      onEnded);
    med.play();
    clipPreviewActive = true;
    playClipBtn.textContent = '⏹ Stop preview';

    clipPreviewStop = () => {
      med.removeEventListener('timeupdate', onTimeUpdate);
      med.removeEventListener('ended',      onEnded);
      if (!med.paused) med.pause();
    };
  }

  function cancelClipPreview() {
    if (clipPreviewStop) { clipPreviewStop(); clipPreviewStop = null; }
    clipPreviewActive = false;
    playClipBtn.textContent = '▶ Preview clip';
  }

  // ── Labels + track fill ───────────────────────────────────────────────────
  function updateLabels() {
    inLabel.textContent   = 'In: '   + fmt(inPoint);
    outLabel.textContent  = 'Out: '  + fmt(outPoint);
    clipLabel.textContent = 'Clip: ' + fmt(outPoint - inPoint);
    drawWaveform();

    const pctIn  = duration ? (inPoint  / duration) * 100 : 0;
    const pctOut = duration ? (outPoint / duration) * 100 : 100;
    const fill = document.getElementById('trm-track-fill');
    if (fill) {
      fill.style.left  = pctIn  + '%';
      fill.style.width = (pctOut - pctIn) + '%';
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!document.getElementById('panel-trim').classList.contains('visible')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

    const med = media();

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (med.paused) med.play();
        else { med.pause(); cancelClipPreview(); }
        break;

      case 'i': case 'I':
        e.preventDefault();
        markIn();
        break;

      case 'o': case 'O':
        e.preventDefault();
        markOut();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        stepPlayhead(e.shiftKey ? -1 : -(1 / fps));
        break;

      case 'ArrowRight':
        e.preventDefault();
        stepPlayhead(e.shiftKey ? 1 : (1 / fps));
        break;

      // , = nudge In −1 frame  |  < (Shift+,) = nudge Out −1 frame
      case ',':
        nudgeIn(-(1 / fps));
        break;
      case '<':
        nudgeOut(-(1 / fps));
        break;

      // . = nudge In +1 frame  |  > (Shift+.) = nudge Out +1 frame
      case '.':
        nudgeIn(1 / fps);
        break;
      case '>':
        nudgeOut(1 / fps);
        break;

      case 'p': case 'P':
        e.preventDefault();
        if (!currentFile) break;
        if (clipPreviewActive) cancelClipPreview();
        else startClipPreview();
        break;
    }
  });

  // ── Trim & Save ───────────────────────────────────────────────────────────
  trimBtn.addEventListener('click', runTrim);

  async function runTrim() {
    if (!currentFile) return;
    cancelClipPreview();
    trimBtn.disabled = true;
    progressWrap.style.display = '';
    setProgress(5, 'Loading encoder…');

    const ext = currentFile.name.split('.').pop().toLowerCase();
    const isAudio = isAudioOnly;

    const outExt = isAudio
      ? (SUPPORTED_AUDIO_EXTS.has(ext) ? ext : 'mp3')
      : (SUPPORTED_VIDEO_EXTS.has(ext) ? ext : 'mp4');

    const inName  = 'input.'  + ext;
    const outFile = 'output.' + outExt;
    const outName = currentFile.name.replace(/\.[^.]+$/, '') + '_trimmed.' + outExt;

    try {
      setProgress(10, 'Reading file…');
      const { ff, fetchFile } = await getFFmpeg(({ progress }) => {
        const pct = Math.min(Math.max(progress, 0), 1);
        setProgress(10 + Math.round(pct * 85), 'Trimming… ' + Math.round(pct * 100) + '%');
      });

      await ff.writeFile(inName, await fetchFile(currentFile));

      setProgress(15, 'Trimming…');
      const ret = await ff.exec([
        '-y',
        '-ss', String(inPoint),
        '-to', String(outPoint),
        '-i', inName,
        '-c', 'copy',
        outFile,
      ]);

      if (ret !== 0) throw new Error('FFmpeg exited with code ' + ret);

      const data = await ff.readFile(outFile);
      if (!data || data.length === 0) throw new Error('Output is empty');

      const mimeType = isAudio ? ('audio/' + outExt) : ('video/' + outExt);
      const blob = new Blob([data], { type: mimeType });

      try { await ff.deleteFile(inName);  } catch (_) {}
      try { await ff.deleteFile(outFile); } catch (_) {}

      setProgress(100, 'Done — ' + (blob.size / 1048576).toFixed(1) + ' MB');
      await saveFile(blob, outName, mimeType);
      setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);

    } catch (err) {
      setProgress(0, 'Error: ' + (err.message || err));
      resetFFmpeg();
      console.error('[trimmer]', err);
      setTimeout(() => { progressWrap.style.display = 'none'; }, 4000);
    } finally {
      trimBtn.disabled = false;
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveFile(blob, name, mime) {
    const ext = name.split('.').pop();

    // On mobile (iOS / Android) prefer Web Share API — surfaces "Save to Photos"
    // on iOS and share-to-gallery options on Android.
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile && navigator.canShare) {
      const shareFile = new File([blob], name, { type: mime });
      if (navigator.canShare({ files: [shareFile] })) {
        try {
          await navigator.share({ files: [shareFile], title: name });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return; // user cancelled share sheet
          console.warn('[trimmer] Web Share failed, falling back', e);
        }
      }
    }

    if ('showSaveFilePicker' in window) {
      try {
        const fh = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Media file', accept: { [mime]: ['.' + ext] } }],
        });
        const w = await fh.createWritable();
        await w.write(blob); await w.close();
        return;
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

  function fmt(s) {
    s = Math.max(0, s);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(1);
    return h > 0
      ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(5, '0')
      : m + ':' + String(sec).padStart(4, '0');
  }
}
