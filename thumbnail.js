/**
 * thumbnail.js — capture a video frame to position a crop, then export
 * a cropped video clip using canvas + MediaRecorder.
 *
 * Clip duration comes from the trimmer's existing In/Out points.
 * Listens for the custom 'trm:loaded' event dispatched by trimmer.js.
 */
import { PRESETS } from './calculator.js';
import { saveFile } from './utils.js';

// Prefer H.264 MP4; fall back to WebM
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function initThumbnail() {
  const videoEl      = document.getElementById('trm-video');
  const section      = document.getElementById('thumb-section');
  const captureBtn   = document.getElementById('thumb-capture-btn');
  const editor       = document.getElementById('thumb-editor');
  const ratioChipsEl = document.getElementById('thumb-ratio-chips');
  const canvas       = document.getElementById('thumb-canvas');
  const exportBtn    = document.getElementById('thumb-export-btn');
  const progressWrap = document.getElementById('thumb-progress-wrap');
  const progressBar  = document.getElementById('thumb-progress-bar');
  const progressLabel= document.getElementById('thumb-progress-label');
  const clipInfo     = document.getElementById('thumb-clip-info');

  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let frame     = null;        // ImageBitmap of captured frame
  let ratio     = PRESETS[0]; // active aspect ratio
  let cropX = 0, cropY = 0, cropW = 0, cropH = 0;
  let fileName  = 'thumbnail';
  let recording = false;
  let dragging  = false;
  let dragStartX = 0, dragStartY = 0, cropStartX = 0, cropStartY = 0;

  // ── Show/hide when trimmer loads a file ────────────────────────────────────
  document.addEventListener('trm:loaded', e => {
    const { isVideo, file } = e.detail;
    section.style.display = isVideo ? '' : 'none';
    if (isVideo) fileName = file.name.replace(/\.[^.]+$/, '');
    editor.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'none';
    frame = null;
  });

  // ── Aspect ratio chips ─────────────────────────────────────────────────────
  PRESETS.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      ratioChipsEl.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      ratio = p;
      if (frame) { fitCrop(); draw(); }
    });
    ratioChipsEl.appendChild(btn);
  });

  // ── Capture frame at current playhead (for crop preview only) ─────────────
  captureBtn.addEventListener('click', async () => {
    if (!videoEl || !videoEl.videoWidth) return;
    videoEl.pause();
    try {
      frame = await createImageBitmap(videoEl);
    } catch {
      alert('Could not capture frame — try stepping to a different position.');
      return;
    }
    canvas.width  = frame.width;
    canvas.height = frame.height;
    fitCrop();
    draw();
    updateClipInfo();
    editor.style.display = '';
    canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // ── Fit crop box to current ratio, centred ────────────────────────────────
  function fitCrop() {
    const fw = frame.width, fh = frame.height;
    const ar = ratio.w / ratio.h;
    if (fw / fh > ar) { cropH = fh; cropW = cropH * ar; }
    else              { cropW = fw; cropH = cropW / ar; }
    cropX = (fw - cropW) / 2;
    cropY = (fh - cropH) / 2;
  }

  // ── Draw frame + crop overlay ─────────────────────────────────────────────
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(frame, 0, 0);

    // Darken outside crop
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, cropY);
    ctx.fillRect(0, cropY + cropH, W, H - cropY - cropH);
    ctx.fillRect(0, cropY, cropX, cropH);
    ctx.fillRect(cropX + cropW, cropY, W - cropX - cropW, cropH);

    // Crop border
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, W / 600);
    ctx.strokeRect(cropX, cropY, cropW, cropH);

    // Rule-of-thirds grid
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, W / 1200);
    for (let i = 1; i < 3; i++) {
      line(cropX + cropW * i / 3, cropY, cropX + cropW * i / 3, cropY + cropH);
      line(cropX, cropY + cropH * i / 3, cropX + cropW, cropY + cropH * i / 3);
    }
  }

  function line(x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // ── Show current In–Out range as a hint ───────────────────────────────────
  function updateClipInfo() {
    if (!clipInfo) return;
    const inPt  = parseFloat(document.getElementById('trm-range-in')?.value)  || 0;
    const outPt = parseFloat(document.getElementById('trm-range-out')?.value) || (videoEl?.duration ?? 0);
    const dur = Math.max(0, outPt - inPt);
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
    clipInfo.textContent = `Clip: ${fmt(inPt)} → ${fmt(outPt)} (${dur.toFixed(1)}s) — adjust In/Out above to change length`;
  }

  // ── Canvas coords ─────────────────────────────────────────────────────────
  function canvasPos(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) * (canvas.width  / r.width),
      y: (clientY - r.top)  * (canvas.height / r.height),
    };
  }
  function insideCrop(x, y) {
    return x >= cropX && x <= cropX + cropW && y >= cropY && y <= cropY + cropH;
  }
  function clampCrop(dx, dy) {
    cropX = Math.max(0, Math.min(frame.width  - cropW, cropStartX + dx));
    cropY = Math.max(0, Math.min(frame.height - cropH, cropStartY + dy));
  }

  // ── Mouse drag ────────────────────────────────────────────────────────────
  canvas.addEventListener('mousedown', e => {
    const p = canvasPos(e.clientX, e.clientY);
    if (!insideCrop(p.x, p.y)) return;
    dragging = true;
    dragStartX = p.x; dragStartY = p.y;
    cropStartX = cropX; cropStartY = cropY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const p = canvasPos(e.clientX, e.clientY);
    clampCrop(p.x - dragStartX, p.y - dragStartY);
    draw();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = '';
  });
  canvas.addEventListener('mousemove', e => {
    if (dragging) return;
    canvas.style.cursor = insideCrop(...Object.values(canvasPos(e.clientX, e.clientY))) ? 'grab' : 'default';
  });
  canvas.addEventListener('mouseleave', () => { if (!dragging) canvas.style.cursor = ''; });

  // ── Touch drag ────────────────────────────────────────────────────────────
  canvas.addEventListener('touchstart', e => {
    const t = e.touches[0], p = canvasPos(t.clientX, t.clientY);
    if (!insideCrop(p.x, p.y)) return;
    e.preventDefault();
    dragging = true;
    dragStartX = p.x; dragStartY = p.y;
    cropStartX = cropX; cropStartY = cropY;
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    if (!dragging) return;
    e.preventDefault();
    const t = e.touches[0], p = canvasPos(t.clientX, t.clientY);
    clampCrop(p.x - dragStartX, p.y - dragStartY);
    draw();
  }, { passive: false });
  canvas.addEventListener('touchend', () => { dragging = false; });

  // ── Export clip ───────────────────────────────────────────────────────────
  exportBtn?.addEventListener('click', () => {
    if (!frame || recording) return;
    const inPt  = parseFloat(document.getElementById('trm-range-in')?.value)  ?? 0;
    const outPt = parseFloat(document.getElementById('trm-range-out')?.value) ?? (videoEl?.duration ?? 0);
    if (outPt <= inPt) {
      alert('Set In and Out points in the trimmer above to define the clip length.');
      return;
    }
    recordClip(inPt, outPt);
  });

  async function recordClip(inPt, outPt) {
    recording = true;
    exportBtn.disabled = true;
    captureBtn.disabled = true;
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    progressLabel.textContent = 'Starting…';

    const duration = outPt - inPt;

    // Output resolution: cap width at 1280, preserve AR
    const maxW = 1280;
    const scale = Math.min(1, maxW / cropW);
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    const offCanvas = document.createElement('canvas');
    offCanvas.width  = outW;
    offCanvas.height = outH;
    const offCtx = offCanvas.getContext('2d', { alpha: false });

    // Pick best supported MIME
    const mime = MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const ext  = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

    const stream   = offCanvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks   = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    // Seek to in-point
    const wasMuted = videoEl.muted;
    videoEl.muted = true;
    videoEl.currentTime = inPt;
    await new Promise(r => videoEl.addEventListener('seeked', r, { once: true }));

    progressLabel.textContent = 'Recording…';
    recorder.start(100);
    videoEl.play();

    // Draw loop
    await new Promise(resolve => {
      let rafId;
      function tick() {
        const elapsed = videoEl.currentTime - inPt;
        if (elapsed < 0 || videoEl.currentTime >= outPt - 0.033) {
          videoEl.pause();
          cancelAnimationFrame(rafId);
          resolve();
          return;
        }
        const pct = Math.min(95, (elapsed / duration) * 100);
        progressBar.style.width = Math.round(pct) + '%';
        progressLabel.textContent = `Recording… ${elapsed.toFixed(1)}s / ${duration.toFixed(1)}s`;
        offCtx.drawImage(videoEl, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
        rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
    });

    recorder.stop();
    await new Promise(r => { recorder.onstop = r; });

    // Restore video state
    videoEl.muted = wasMuted;
    videoEl.currentTime = inPt;

    progressBar.style.width = '100%';
    progressLabel.textContent = 'Saving…';

    const blob = new Blob(chunks, { type: mime });
    await saveFile(blob, `${fileName}-thumbnail.${ext}`, mime);

    setTimeout(() => { progressWrap.style.display = 'none'; }, 800);
    recording = false;
    exportBtn.disabled = false;
    captureBtn.disabled = false;
  }
}
