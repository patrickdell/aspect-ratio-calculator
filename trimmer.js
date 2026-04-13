/**
 * trimmer.js — browser-side video/audio trimmer via FFmpeg.wasm stream copy
 * Supports video (MP4/MOV/MKV/WebM) and audio (MP3/AAC/WAV/M4A/OGG).
 * Stream copy = no re-encode = near-instant.
 */

import { getFFmpeg, resetFFmpeg } from './ffmpeg-shared.js';

const SUPPORTED_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v']);
const SUPPORTED_AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'm4a', 'ogg', 'flac', 'opus']);
const UNSUPPORTED_EXTS     = new Set(['mxf', 'mts', 'm2ts']);

// Estimated frames-per-second when we can't probe — used for frame stepping
const DEFAULT_FPS = 30;

export function initTrimmer() {
  const dropzone     = document.getElementById('trm-dropzone');
  const fileInput    = document.getElementById('trm-file-input');
  const playerWrap   = document.getElementById('trm-player-wrap');
  const videoEl      = document.getElementById('trm-video');
  const audioEl      = document.getElementById('trm-audio');
  const formatWarn   = document.getElementById('trm-format-warn');
  const sizeWarn     = document.getElementById('trm-size-warn');
  const rangeIn      = document.getElementById('trm-range-in');
  const rangeOut     = document.getElementById('trm-range-out');
  const inLabel      = document.getElementById('trm-in-label');
  const outLabel     = document.getElementById('trm-out-label');
  const clipLabel    = document.getElementById('trm-clip-label');
  const setInBtn     = document.getElementById('trm-set-in');
  const setOutBtn    = document.getElementById('trm-set-out');
  const playClipBtn  = document.getElementById('trm-play-clip');
  const stepBackFrame = document.getElementById('trm-step-back-frame');
  const stepBackSec   = document.getElementById('trm-step-back-sec');
  const stepFwdSec    = document.getElementById('trm-step-fwd-sec');
  const stepFwdFrame  = document.getElementById('trm-step-fwd-frame');
  const trimBtn      = document.getElementById('trm-trim-btn');
  const progressWrap = document.getElementById('trm-progress-wrap');
  const progressBar  = document.getElementById('trm-progress-bar');
  const progressLabel = document.getElementById('trm-progress-label');

  let currentFile  = null;
  let blobUrl      = null;
  let inPoint      = 0;
  let outPoint     = 0;
  let duration     = 0;
  let isAudioOnly  = false;
  let fps          = DEFAULT_FPS;
  let clipPreviewActive = false;
  let clipPreviewStop   = null; // cleanup fn

  // ── Active media element (video or audio) ─────────────────────────────────
  function media() { return isAudioOnly ? audioEl : videoEl; }

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

    // Show correct player element
    videoEl.style.display = isAudioOnly ? 'none' : '';
    audioEl.style.display = isAudioOnly ? '' : 'none';

    // Format check
    formatWarn.style.display = UNSUPPORTED_EXTS.has(ext) ? '' : 'none';

    // Size warning
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

      // Try to read fps from videoEl (only meaningful for video)
      if (!isAudioOnly && videoEl.getVideoPlaybackQuality) {
        // getVideoPlaybackQuality doesn't give fps directly; use a heuristic
        fps = DEFAULT_FPS;
      }

      [rangeIn, rangeOut].forEach(r => {
        r.min  = '0';
        r.max  = String(duration);
        r.step = String(Math.min(0.01, duration / 10000)); // fine step
      });
      rangeIn.value  = '0';
      rangeOut.value = String(duration);

      updateLabels();
      playerWrap.style.display = '';
      dropzone.querySelector('.trm-drop-text').textContent = file.name;
      dropzone.classList.add('has-file');
      trimBtn.disabled  = false;
      playClipBtn.textContent = '▶ Preview clip';
      progressWrap.style.display = 'none';
    }, { once: true });

    // Warm up FFmpeg
    getFFmpeg().catch(() => {});
  }

  // ── Timeline scrubbers ────────────────────────────────────────────────────
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

  setInBtn.addEventListener('click', () => {
    inPoint = Math.min(media().currentTime, outPoint - 0.05);
    rangeIn.value = String(inPoint);
    cancelClipPreview();
    updateLabels();
  });

  setOutBtn.addEventListener('click', () => {
    outPoint = Math.max(media().currentTime, inPoint + 0.05);
    rangeOut.value = String(outPoint);
    cancelClipPreview();
    updateLabels();
  });

  // ── Step buttons ──────────────────────────────────────────────────────────
  function stepMedia(delta) {
    if (!currentFile) return;
    cancelClipPreview();
    const med = media();
    med.currentTime = Math.max(0, Math.min(duration, med.currentTime + delta));
  }

  stepBackFrame.addEventListener('click', () => stepMedia(-(1 / fps)));
  stepFwdFrame .addEventListener('click', () => stepMedia(  1 / fps));
  stepBackSec  .addEventListener('click', () => stepMedia(-1));
  stepFwdSec   .addEventListener('click', () => stepMedia( 1));

  // ── Clip preview ──────────────────────────────────────────────────────────
  playClipBtn.addEventListener('click', () => {
    if (!currentFile) return;
    if (clipPreviewActive) {
      cancelClipPreview();
      return;
    }
    startClipPreview();
  });

  function startClipPreview() {
    cancelClipPreview();
    const med = media();
    med.currentTime = inPoint;

    const onTimeUpdate = () => {
      if (med.currentTime >= outPoint) {
        cancelClipPreview();
      }
    };

    const onEnded = () => cancelClipPreview();

    med.addEventListener('timeupdate', onTimeUpdate);
    med.addEventListener('ended', onEnded);
    med.play();
    clipPreviewActive = true;
    playClipBtn.textContent = '⏹ Stop preview';

    clipPreviewStop = () => {
      med.removeEventListener('timeupdate', onTimeUpdate);
      med.removeEventListener('ended', onEnded);
      if (!med.paused) med.pause();
    };
  }

  function cancelClipPreview() {
    if (clipPreviewStop) { clipPreviewStop(); clipPreviewStop = null; }
    clipPreviewActive = false;
    playClipBtn.textContent = '▶ Preview clip';
  }

  function updateLabels() {
    inLabel.textContent   = 'In: '   + fmt(inPoint);
    outLabel.textContent  = 'Out: '  + fmt(outPoint);
    clipLabel.textContent = 'Clip: ' + fmt(outPoint - inPoint);

    const pctIn  = duration ? (inPoint  / duration) * 100 : 0;
    const pctOut = duration ? (outPoint / duration) * 100 : 100;
    const fill = document.getElementById('trm-track-fill');
    if (fill) {
      fill.style.left  = pctIn  + '%';
      fill.style.width = (pctOut - pctIn) + '%';
    }
  }

  // ── Trim ──────────────────────────────────────────────────────────────────
  trimBtn.addEventListener('click', runTrim);

  async function runTrim() {
    if (!currentFile) return;
    cancelClipPreview();
    trimBtn.disabled = true;
    progressWrap.style.display = '';
    setProgress(5, 'Loading encoder…');

    const ext = currentFile.name.split('.').pop().toLowerCase();
    const isAudio = isAudioOnly;

    // Output extension: match input for audio; video → keep container, fallback mp4
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
      await saveFile(blob, outName, isAudio ? 'audio/' + outExt : 'video/' + outExt);
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
