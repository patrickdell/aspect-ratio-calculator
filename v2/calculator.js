/**
 * calculator.js — ratio math and calculator panel logic
 */

export const PRESETS = [
  { label: '16:9', w: 16, h: 9  },
  { label: '3:2',  w: 3,  h: 2  },
  { label: '4:3',  w: 4,  h: 3  },
  { label: '1:1',  w: 1,  h: 1  },
  { label: '4:5',  w: 4,  h: 5  },
  { label: '2:3',  w: 2,  h: 3  },
  { label: '9:16', w: 9,  h: 16 },
];

export function calcHeight(width, ratioW, ratioH) {
  return Math.round(width * ratioH / ratioW);
}

export function calcWidth(height, ratioW, ratioH) {
  return Math.round(height * ratioW / ratioH);
}

export function initCalculator({ onRatioChange }) {
  const widthEl  = document.getElementById('calcWidth');
  const heightEl = document.getElementById('calcHeight');
  const resultEl = document.getElementById('calcResult');
  const metaEl   = document.getElementById('calcMeta');
  const wErrEl   = document.getElementById('calcWErr');
  const hErrEl   = document.getElementById('calcHErr');
  const flipBtn  = document.getElementById('calcFlip');
  const resetBtn = document.getElementById('calcReset');

  let activeField = null;
  let currentPreset = PRESETS[0];

  function setError(el, msgEl, msg) {
    el.classList.add('err');
    msgEl.textContent = msg;
  }
  function clearError(el, msgEl) {
    el.classList.remove('err');
    msgEl.textContent = '';
  }

  function lock(field) {
    activeField = field;
    widthEl.disabled  = field === 'height';
    heightEl.disabled = field === 'width';
  }

  function compute() {
    clearError(widthEl, wErrEl);
    clearError(heightEl, hErrEl);
    const { w, h } = currentPreset;
    let W, H;

    if (activeField === 'width') {
      W = Number(widthEl.value);
      if (!W || W <= 0) { setError(widthEl, wErrEl, 'Enter a width'); resultEl.textContent = '\u2014'; metaEl.textContent = ''; return; }
      H = calcHeight(W, w, h);
    } else if (activeField === 'height') {
      H = Number(heightEl.value);
      if (!H || H <= 0) { setError(heightEl, hErrEl, 'Enter a height'); resultEl.textContent = '\u2014'; metaEl.textContent = ''; return; }
      W = calcWidth(H, w, h);
    } else {
      resultEl.textContent = '\u2014';
      metaEl.textContent = '';
      return;
    }

    resultEl.textContent = W + ' \xd7 ' + H + ' px';
    resultEl.dataset.copy = W + ' × ' + H + ' px';
    resultEl.classList.add('copyable');
    metaEl.textContent = 'Ratio ' + currentPreset.label;
  }

  function handleWidthInput() {
    if (widthEl.value) { lock('width'); heightEl.value = ''; clearError(heightEl, hErrEl); }
    else { lock(null); }
    compute();
  }

  function handleHeightInput() {
    if (heightEl.value) { lock('height'); widthEl.value = ''; clearError(widthEl, wErrEl); }
    else { lock(null); }
    compute();
  }

  widthEl.addEventListener('focus', () => { if (!widthEl.value) lock('width'); });
  heightEl.addEventListener('focus', () => { if (!heightEl.value) lock('height'); });
  widthEl.addEventListener('input', handleWidthInput);
  heightEl.addEventListener('input', handleHeightInput);
  widthEl.addEventListener('keydown', e => { if (e.key === 'Enter') compute(); });
  heightEl.addEventListener('keydown', e => { if (e.key === 'Enter') compute(); });

  flipBtn.addEventListener('click', () => {
    if (widthEl.value) {
      heightEl.value = widthEl.value;
      widthEl.value = '';
      lock('height');
    } else if (heightEl.value) {
      widthEl.value = heightEl.value;
      heightEl.value = '';
      lock('width');
    }
    compute();
  });

  resetBtn.addEventListener('click', () => {
    widthEl.value = '';
    heightEl.value = '';
    lock(null);
    resultEl.textContent = '\u2014';
    resultEl.classList.remove('copyable');
    metaEl.textContent = '';
  });

  resultEl.addEventListener('click', () => {
    const text = resultEl.dataset.copy;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const prev = resultEl.textContent;
      resultEl.textContent = 'Copied!';
      resultEl.classList.add('copied');
      setTimeout(() => {
        resultEl.textContent = prev;
        resultEl.classList.remove('copied');
      }, 1200);
    });
  });

  /** Called by app.js when the shared ratio changes */
  function setPreset(preset) {
    currentPreset = preset;
    compute();
  }

  return { setPreset };
}
