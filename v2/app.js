/**
 * app.js — tab routing and shared ratio state
 */

import { PRESETS, initCalculator } from './calculator.js';
import { initCropper }             from './cropper.js';
import { initExporter }            from './exporter.js';
import { initEmbed }               from './embed.js';

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
const panels  = { embed: 'panel-embed', calc: 'panel-calc', crop: 'panel-crop' };

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    Object.values(panels).forEach(id => document.getElementById(id).classList.remove('visible'));
    document.getElementById(panels[tab]).classList.add('visible');
    localStorage.setItem('ar_tab', tab);
  });
});

// ── Init modules ──────────────────────────────────────────────────────────

const calcChips = document.getElementById('calcChips');
const cropChips = document.getElementById('cropChips');

initEmbed();
const calculator = initCalculator({ onRatioChange: () => {} });
const cropper    = initCropper({ onCropChange: () => exporter.setEnabled(cropper.isLoaded()) });
const exporter   = initExporter({ getCropState: () => cropper.getCropState() });

exporter.setEnabled(false);

// ── Build chips for both panels ───────────────────────────────────────────

function selectRatio(preset) {
  activePreset = preset;
  syncChips(calcChips, preset);
  syncChips(cropChips, preset);
  calculator.setPreset(preset);
  cropper.setRatio(preset);
  localStorage.setItem('ar_preset', preset.label);
}

buildChips(calcChips, selectRatio);
buildChips(cropChips, selectRatio);

// ── Restore persisted state ───────────────────────────────────────────────

const savedPreset = localStorage.getItem('ar_preset');
if (savedPreset) {
  const found = PRESETS.find(p => p.label === savedPreset);
  if (found) selectRatio(found);
} else {
  selectRatio(activePreset);
}

const savedTab = localStorage.getItem('ar_tab') || 'embed';
const savedTabBtn = document.querySelector(`.tab-btn[data-tab="${savedTab}"]`);
(savedTabBtn || document.querySelector('.tab-btn[data-tab="embed"]')).click();
