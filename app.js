/**
 * app.js — tab routing and shared ratio state
 */

import { PRESETS, initCalculator } from './calculator.js';
import { initCropper }             from './cropper.js';
import { initExporter }            from './exporter.js';
import { initEmbed }               from './embed.js';
import { initCompressor }          from './compressor.js';
import { initTrimmer }             from './trimmer.js';
import { initExtractor }           from './extractor.js';
import { initResizer }             from './resizer.js';
import { initPalette }             from './palette.js';
import { initLabeller }           from './labeller.js';
import { initWaveformRenderer }   from './waveform-renderer.js';

// ── Build preset chips ────────────────────────────────────────────────────

let activePreset = PRESETS[0];

function buildChips(container, onSelect) {
  PRESETS.forEach(preset => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'chip' + (preset === activePreset ? ' active' : '');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => onSelect(preset));
    container.appendChild(btn);
  });
  return container;
}

function syncChips(container, preset) {
  container.querySelectorAll('.chip').forEach((btn, i) => {
    btn.classList.toggle('active', PRESETS[i] === preset);
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────

const tabBtns = document.querySelectorAll('.tab-btn');
const panels  = {
  embed:    'panel-embed',
  calc:     'panel-calc',
  crop:     'panel-crop',
  compress: 'panel-compress',
  trim:     'panel-trim',
  extract:  'panel-extract',
  resize:   'panel-resize',
  palette:  'panel-palette',
  label:    'panel-label',
  waveform: 'panel-waveform',
};

let drawer; // set up below before first activateTab call

function activateTab(tab) {
  if (!panels[tab]) tab = 'embed';
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  Object.values(panels).forEach(id => document.getElementById(id)?.classList.remove('visible'));
  document.getElementById(panels[tab])?.classList.add('visible');
  history.replaceState(null, '', '#' + tab);
  localStorage.setItem('ar_tab', tab);
  if (drawer) {
    drawer.querySelectorAll('.nav-drawer-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tab);
    });
  }
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// Permalink links — copy full URL to clipboard on click
document.addEventListener('click', e => {
  const link = e.target.closest('[data-permalink]');
  if (!link) return;
  e.preventDefault();
  const url = location.origin + location.pathname + '#' + link.dataset.permalink;
  navigator.clipboard?.writeText(url).catch(() => {});
  const orig = link.textContent;
  link.textContent = '✓ Copied link!';
  setTimeout(() => { link.textContent = orig; }, 2000);
});

// ── Init modules ──────────────────────────────────────────────────────────

const calcChips = document.getElementById('calcChips');
const cropChips = document.getElementById('cropChips');

initEmbed();
initLabeller();
initWaveformRenderer();
initCompressor();
initTrimmer();
initExtractor();
initResizer();
initPalette();
const calculator = initCalculator({ onRatioChange: () => {} });
const cropper    = initCropper({ onCropChange: () => exporter.setEnabled(cropper.isLoaded()) });
const exporter   = initExporter({ getCropState: () => cropper.getCropState() });

exporter.setEnabled(false);

// ── Build chips for both panels ───────────────────────────────────────────

function selectRatio(preset) {
  activePreset = preset;
  syncChips(calcChips, preset);
  syncChips(cropChips, preset);
  customChip.classList.remove('active');
  customRatioRow.style.display = 'none';
  calculator.setPreset(preset);
  cropper.setRatio(preset);
  localStorage.setItem('ar_preset', preset.label);
}

buildChips(calcChips, selectRatio);
buildChips(cropChips, selectRatio);

// ── Custom ratio chip (crop panel only) ───────────────────────────────────

const customChip = document.createElement('button');
customChip.type = 'button';
customChip.className = 'chip';
customChip.textContent = 'Custom';
cropChips.appendChild(customChip);

const customRatioRow = document.getElementById('customRatioRow');
const customRatioW   = document.getElementById('customRatioW');
const customRatioH   = document.getElementById('customRatioH');

function applyCustomRatio() {
  const w = Number(customRatioW.value);
  const h = Number(customRatioH.value);
  if (!w || !h || w <= 0 || h <= 0) return;
  cropChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  customChip.classList.add('active');
  cropper.setRatio({ label: w + ':' + h, w, h });
}

customChip.addEventListener('click', () => {
  cropChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  customChip.classList.add('active');
  customRatioRow.style.display = 'flex';
  applyCustomRatio();
  customRatioW.focus();
});

customRatioW.addEventListener('input', applyCustomRatio);
customRatioH.addEventListener('input', applyCustomRatio);

// ── Crop preview button + Enter key + Reset ───────────────────────────────

const previewCropBtn = document.getElementById('previewCropBtn');
const resetCropBtn   = document.getElementById('resetCropBtn');
const cropPreviewWrap = document.getElementById('crop-preview-wrap');
const cropPreviewImg  = document.getElementById('crop-preview-img');

function showCropPreview() {
  if (!cropper.isLoaded()) return;
  const { bitmap, crop } = cropper.getCropState();
  if (!bitmap || !crop) return;
  const MAX = 600;
  const scale = Math.min(1, MAX / Math.max(crop.w, crop.h));
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width  = Math.round(crop.w * scale);
  previewCanvas.height = Math.round(crop.h * scale);
  previewCanvas.getContext('2d').drawImage(
    bitmap,
    crop.x, crop.y, crop.w, crop.h,
    0, 0, previewCanvas.width, previewCanvas.height
  );
  cropPreviewImg.src = previewCanvas.toDataURL();
  cropPreviewWrap.style.display = '';
}

previewCropBtn?.addEventListener('click', showCropPreview);

resetCropBtn?.addEventListener('click', () => {
  cropper.resetCrop?.();
  cropPreviewWrap.style.display = 'none';
  cropPreviewImg.src = '';
});

// Enter key on crop panel
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('panel-crop').classList.contains('visible')) {
    // Don't intercept if focus is in an input
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    showCropPreview();
  }
});

// Enable preview/reset buttons when image loads
document.addEventListener('cropLoaded', () => {
  previewCropBtn.disabled = false;
  resetCropBtn.disabled   = false;
  exporter.setEnabled(true);
});

// ── Restore persisted state ───────────────────────────────────────────────

const savedPreset = localStorage.getItem('ar_preset');
if (savedPreset) {
  const found = PRESETS.find(p => p.label === savedPreset);
  if (found) selectRatio(found);
} else {
  selectRatio(activePreset);
}

// ── Nav drawer (mobile) ──────────────────────────────────────────────────────
const backdrop = document.createElement('div');
backdrop.className = 'nav-drawer-backdrop';

drawer = document.createElement('nav');
drawer.className = 'nav-drawer';
drawer.innerHTML = `
  <div class="nav-drawer-header">
    <span>Tools</span>
    <button class="nav-drawer-close" id="drawer-close" aria-label="Close menu">&times;</button>
  </div>
`;

tabBtns.forEach(tb => {
  const btn = document.createElement('button');
  btn.className = 'nav-drawer-item';
  btn.dataset.tab = tb.dataset.tab;
  btn.textContent = tb.textContent.trim();
  btn.addEventListener('click', () => { activateTab(btn.dataset.tab); closeDrawer(); });
  drawer.appendChild(btn);
});

const drawerAbout = document.createElement('div');
drawerAbout.className = 'nav-drawer-about';
drawerAbout.innerHTML = `
  <strong>Visuals Toolset</strong>
  A privacy-first collection of browser-based media tools.<br>
  All processing happens locally — nothing is uploaded.
`;
drawer.appendChild(drawerAbout);

document.body.appendChild(backdrop);
document.body.appendChild(drawer);

function openDrawer()  { drawer.classList.add('open'); backdrop.classList.add('open'); }
function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open'); }

document.getElementById('nav-hamburger').addEventListener('click', openDrawer);
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

// Hash → localStorage → embed
const hash = location.hash.replace('#', '');
const savedTab = hash && panels[hash] ? hash : (localStorage.getItem('ar_tab') || 'embed');
activateTab(savedTab);
