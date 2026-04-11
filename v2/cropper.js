/**
 * cropper.js — canvas-based interactive crop engine
 *
 * Coordinate systems:
 *   image-space : pixels on the original (EXIF-corrected) image
 *   canvas-space: physical canvas buffer pixels (= CSS pixels × DPR)
 *   display-space: CSS pixels shown on screen
 */

const MIN_CROP_PX = 20; // minimum crop dimension in image-space pixels
const HANDLE_HIT  = 14; // hit radius for handles in display-space pixels
const HANDLE_SIZE = 8;  // drawn half-size of handle squares in canvas pixels

// Handle IDs and their anchor corners (opposite side from where dragging happens)
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];

export function initCropper({ onCropChange }) {
  const canvas    = document.getElementById('cropCanvas');
  const dropzone  = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const cropInfoW = document.getElementById('cropInfoW');
  const cropInfoH = document.getElementById('cropInfoH');
  const sizeWarn  = document.getElementById('sizeWarn');

  const ctx = canvas.getContext('2d');

  const state = {
    bitmap:       null,
    naturalW:     0,
    naturalH:     0,
    sourceBuffer: null, // original file ArrayBuffer for EXIF passthrough
    ratio:    { w: 3, h: 2 },
    crop:     { x: 0, y: 0, w: 0, h: 0 }, // image-space
    // Computed each render from canvas CSS size:
    scale:    1,   // canvas-buffer pixels per image pixel
    offX:     0,   // letterbox offset X in canvas-buffer pixels
    offY:     0,   // letterbox offset Y in canvas-buffer pixels
    dpr:      1,
    drag:     null, // { type, handleId, startIX, startIY, origCrop }
    loaded:   false,
  };

  // ── File loading ─────────────────────────────────────────────────────────

  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const [bitmap, srcBuf] = await Promise.all([
        createImageBitmap(file, { imageOrientation: 'from-image' }),
        file.arrayBuffer(),
      ]);
      state.bitmap       = bitmap;
      state.naturalW     = bitmap.width;
      state.naturalH     = bitmap.height;
      state.sourceBuffer = srcBuf;
      state.loaded       = true;

      dropzone.classList.add('hidden');
      canvas.parentElement.style.display = 'block';

      resizeCanvas();
      fitCrop();
      render();

      sizeWarn.classList.toggle('visible',
        bitmap.width < 1080 || bitmap.height < 1080);
    } catch (e) {
      console.error('Failed to load image', e);
    }
  }

  // ── Drop zone ────────────────────────────────────────────────────────────

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  // Block accidental full-page drop
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop',     e => e.preventDefault());

  // Clipboard paste (Ctrl+V)
  document.addEventListener('paste', e => {
    const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/'));
    if (file) loadFile(file);
  });

  // ── Crop fitting ─────────────────────────────────────────────────────────

  function fitCrop() {
    const { naturalW, naturalH, ratio } = state;
    const ar = ratio.w / ratio.h;
    const imgAR = naturalW / naturalH;
    let cw, ch;
    if (ar <= imgAR) {
      ch = naturalH;
      cw = Math.round(ch * ar);
    } else {
      cw = naturalW;
      ch = Math.round(cw / ar);
    }
    state.crop = {
      x: Math.round((naturalW - cw) / 2),
      y: Math.round((naturalH - ch) / 2),
      w: cw,
      h: ch,
    };
    notifyCropChange();
  }

  // ── Canvas sizing ─────────────────────────────────────────────────────────

  function resizeCanvas() {
    if (!state.loaded) return;
    const dpr  = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight || Math.round(cssW * (state.naturalH / state.naturalW));
    state.dpr  = dpr;
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    updateLetterbox();
  }

  function updateLetterbox() {
    const { naturalW, naturalH, dpr } = state;
    const bufW = canvas.width;
    const bufH = canvas.height;
    const scaleX = bufW / naturalW;
    const scaleY = bufH / naturalH;
    const scale  = Math.min(scaleX, scaleY);
    state.scale  = scale;
    state.offX   = Math.round((bufW - naturalW * scale) / 2);
    state.offY   = Math.round((bufH - naturalH * scale) / 2);
  }

  const ro = new ResizeObserver(() => { resizeCanvas(); if (state.loaded) render(); });
  ro.observe(canvas);

  // ── Coordinate helpers ────────────────────────────────────────────────────

  /** Convert a pointer event clientX/Y → image-space {ix, iy} */
  function clientToImage(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const dpr  = state.dpr;
    const bufX = (clientX - rect.left)  * (canvas.width  / rect.width);
    const bufY = (clientY - rect.top)   * (canvas.height / rect.height);
    return {
      ix: (bufX - state.offX) / state.scale,
      iy: (bufY - state.offY) / state.scale,
    };
  }

  /** Convert image-space {x,y,w,h} → canvas-buffer space */
  function cropToCanvas(crop) {
    const { offX, offY, scale } = state;
    return {
      cx: offX + crop.x * scale,
      cy: offY + crop.y * scale,
      cw: crop.w * scale,
      ch: crop.h * scale,
    };
  }

  /** Get the 8 handle positions in canvas-buffer space */
  function getHandles(cx, cy, cw, ch) {
    return {
      nw: { x: cx,        y: cy        },
      n:  { x: cx + cw/2, y: cy        },
      ne: { x: cx + cw,   y: cy        },
      e:  { x: cx + cw,   y: cy + ch/2 },
      se: { x: cx + cw,   y: cy + ch   },
      s:  { x: cx + cw/2, y: cy + ch   },
      sw: { x: cx,        y: cy + ch   },
      w:  { x: cx,        y: cy + ch/2 },
    };
  }

  // ── Hit testing ───────────────────────────────────────────────────────────

  function hitTest(clientX, clientY) {
    if (!state.loaded) return null;
    const rect  = canvas.getBoundingClientRect();
    const cssX  = clientX - rect.left;
    const cssY  = clientY - rect.top;
    // convert css → canvas buffer for position comparison
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const bufX  = cssX * scaleX;
    const bufY  = cssY * scaleY;

    const { cx, cy, cw, ch } = cropToCanvas(state.crop);
    const handles = getHandles(cx, cy, cw, ch);
    const hitR    = HANDLE_HIT * state.dpr;

    for (const id of HANDLES) {
      const h = handles[id];
      if (Math.abs(bufX - h.x) <= hitR && Math.abs(bufY - h.y) <= hitR) {
        return { type: 'handle', handleId: id };
      }
    }
    if (bufX >= cx && bufX <= cx + cw && bufY >= cy && bufY <= cy + ch) {
      return { type: 'move' };
    }
    return null;
  }

  // ── Pointer events ────────────────────────────────────────────────────────

  canvas.addEventListener('pointerdown', e => {
    if (!state.loaded) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const { ix, iy } = clientToImage(e.clientX, e.clientY);
    state.drag = { ...hit, startIX: ix, startIY: iy, origCrop: { ...state.crop } };
  });

  canvas.addEventListener('pointermove', e => {
    if (!state.loaded) return;
    if (!state.drag) {
      // Update cursor
      const hit = hitTest(e.clientX, e.clientY);
      if (!hit) canvas.style.cursor = 'crosshair';
      else if (hit.type === 'move') canvas.style.cursor = 'move';
      else canvas.style.cursor = cursorForHandle(hit.handleId);
      return;
    }
    e.preventDefault();
    const { ix, iy } = clientToImage(e.clientX, e.clientY);
    const dx = ix - state.drag.startIX;
    const dy = iy - state.drag.startIY;
    applyDrag(dx, dy);
    render();
  });

  canvas.addEventListener('pointerup',    endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function endDrag(e) {
    state.drag = null; // notifyCropChange() already called during render() on each pointermove
  }

  function cursorForHandle(id) {
    const map = { nw:'nw-resize', n:'n-resize', ne:'ne-resize', e:'e-resize',
                  se:'se-resize', s:'s-resize', sw:'sw-resize', w:'w-resize' };
    return map[id] || 'pointer';
  }

  // ── Drag application ──────────────────────────────────────────────────────

  function applyDrag(dx, dy) {
    const { type, handleId, origCrop } = state.drag;
    const { naturalW, naturalH, ratio } = state;
    const ar = ratio.w / ratio.h;

    if (type === 'move') {
      let nx = origCrop.x + dx;
      let ny = origCrop.y + dy;
      nx = Math.max(0, Math.min(naturalW - origCrop.w, nx));
      ny = Math.max(0, Math.min(naturalH - origCrop.h, ny));
      state.crop = { ...origCrop, x: Math.round(nx), y: Math.round(ny) };
      return;
    }

    // Handle resize — each case fixes anchor and adjusts the moving sides
    let { x, y, w, h } = origCrop;
    const right  = x + w;
    const bottom = y + h;
    let nx, ny, nw, nh;

    switch (handleId) {
      case 'se':
        nw = Math.max(MIN_CROP_PX, Math.min(naturalW - x, w + dx));
        nh = nw / ar;
        if (y + nh > naturalH) { nh = naturalH - y; nw = nh * ar; }
        nx = x; ny = y;
        break;
      case 'sw':
        nw = Math.max(MIN_CROP_PX, Math.min(right, w - dx));
        nh = nw / ar;
        if (y + nh > naturalH) { nh = naturalH - y; nw = nh * ar; }
        nx = right - nw; ny = y;
        break;
      case 'ne':
        nw = Math.max(MIN_CROP_PX, Math.min(naturalW - x, w + dx));
        nh = nw / ar;
        if (nh > bottom) { nh = bottom; nw = nh * ar; }
        nx = x; ny = bottom - nh;
        break;
      case 'nw':
        nw = Math.max(MIN_CROP_PX, Math.min(right, w - dx));
        nh = nw / ar;
        if (nh > bottom) { nh = bottom; nw = nh * ar; }
        nx = right - nw; ny = bottom - nh;
        break;
      case 's':
        nh = Math.max(MIN_CROP_PX, Math.min(naturalH - y, h + dy));
        nw = nh * ar;
        if (x + nw > naturalW) { nw = naturalW - x; nh = nw / ar; }
        nx = x + (w - nw) / 2; ny = y;
        nx = Math.max(0, Math.min(naturalW - nw, nx));
        break;
      case 'n':
        nh = Math.max(MIN_CROP_PX, Math.min(bottom, h - dy));
        nw = nh * ar;
        if (nw > naturalW) { nw = naturalW; nh = nw / ar; }
        nx = x + (w - nw) / 2; ny = bottom - nh;
        nx = Math.max(0, Math.min(naturalW - nw, nx));
        ny = Math.max(0, ny);
        break;
      case 'e':
        nw = Math.max(MIN_CROP_PX, Math.min(naturalW - x, w + dx));
        nh = nw / ar;
        if (nh > naturalH) { nh = naturalH; nw = nh * ar; }
        nx = x; ny = y + (h - nh) / 2;
        ny = Math.max(0, Math.min(naturalH - nh, ny));
        break;
      case 'w':
        nw = Math.max(MIN_CROP_PX, Math.min(right, w - dx));
        nh = nw / ar;
        if (nh > naturalH) { nh = naturalH; nw = nh * ar; }
        nx = right - nw; ny = y + (h - nh) / 2;
        ny = Math.max(0, Math.min(naturalH - nh, ny));
        break;
      default: return;
    }

    state.crop = {
      x: Math.round(Math.max(0, nx)),
      y: Math.round(Math.max(0, ny)),
      w: Math.round(Math.min(nw, naturalW)),
      h: Math.round(Math.min(nh, naturalH)),
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!state.loaded || !state.bitmap) return;
    const { bitmap, naturalW, naturalH, crop, offX, offY, scale } = state;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Draw image
    ctx.drawImage(bitmap, 0, 0, naturalW, naturalH,
                  offX, offY, naturalW * scale, naturalH * scale);

    const { cx, cy, cw, ch } = cropToCanvas(crop);

    // Darkened overlay (4 rects around crop box)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0,       0,       W,  cy);           // top
    ctx.fillRect(0,       cy + ch, W,  H - cy - ch);  // bottom
    ctx.fillRect(0,       cy,      cx, ch);            // left
    ctx.fillRect(cx + cw, cy,      W - cx - cw, ch);  // right

    // Rule-of-thirds grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    for (let i = 1; i < 3; i++) {
      const gx = cx + cw * i / 3;
      const gy = cy + ch * i / 3;
      ctx.beginPath(); ctx.moveTo(gx, cy); ctx.lineTo(gx, cy + ch); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, gy); ctx.lineTo(cx + cw, gy); ctx.stroke();
    }

    // Crop border
    ctx.strokeStyle = '#DA161F';
    ctx.lineWidth   = Math.max(1.5, state.dpr);
    ctx.strokeRect(cx, cy, cw, ch);

    // Corner accents (L-shaped brackets)
    const bLen = Math.min(20, cw / 4, ch / 4);
    ctx.lineWidth = Math.max(2.5, state.dpr * 1.5);
    ctx.strokeStyle = '#ffffff';
    const corners = [
      [cx,      cy,      bLen,  0,    0,    bLen ],
      [cx + cw, cy,      -bLen, 0,    0,    bLen ],
      [cx + cw, cy + ch, -bLen, 0,    0,   -bLen ],
      [cx,      cy + ch, bLen,  0,    0,   -bLen ],
    ];
    corners.forEach(([ox, oy, hx, hy, vx, vy]) => {
      ctx.beginPath();
      ctx.moveTo(ox + hx, oy + hy); ctx.lineTo(ox, oy); ctx.lineTo(ox + vx, oy + vy);
      ctx.stroke();
    });

    // Resize handles
    const handles = getHandles(cx, cy, cw, ch);
    const hs = HANDLE_SIZE;
    HANDLES.forEach(id => {
      const h = handles[id];
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#DA161F';
      ctx.lineWidth = 1.5;
      ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
    });

    // Dimension label
    const labelText = crop.w + ' \xd7 ' + crop.h + ' px (source)';
    const fontSize  = Math.max(11, Math.round(12 * state.dpr));
    ctx.font        = fontSize + 'px system-ui, sans-serif';
    ctx.fillStyle   = 'rgba(0,0,0,0.65)';
    const tw        = ctx.measureText(labelText).width;
    const lx        = cx + cw / 2 - tw / 2;
    const ly        = cy + ch + fontSize + 4;
    if (ly < H - 2) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(lx - 6, ly - fontSize, tw + 12, fontSize + 6);
      ctx.fillStyle = '#e8eefc';
      ctx.fillText(labelText, lx, ly);
    }

    // Update sidebar info
    notifyCropChange();
  }

  function notifyCropChange() {
    if (cropInfoW) cropInfoW.textContent = state.crop.w || '—';
    if (cropInfoH) cropInfoH.textContent = state.crop.h || '—';
    onCropChange && onCropChange(state.crop);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function setRatio(preset) {
    state.ratio = { w: preset.w, h: preset.h };
    if (state.loaded) { fitCrop(); render(); }
  }

  function getCropState() {
    return {
      bitmap:       state.bitmap,
      naturalW:     state.naturalW,
      naturalH:     state.naturalH,
      sourceBuffer: state.sourceBuffer,
      crop:         { ...state.crop },
    };
  }

  function isLoaded() { return state.loaded; }

  return { setRatio, getCropState, isLoaded };
}
