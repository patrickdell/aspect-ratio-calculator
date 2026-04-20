/**
 * transcriber.js — local audio transcription using Whisper (via Web Worker)
 */
import { setupDropzone, saveFile } from './utils.js';

const MODELS = [
  { label: 'Tiny', id: 'tiny', hint: '39 MB — downloads once, then cached. Fast transcription, works well for clear speech.' },
  { label: 'Base', id: 'base', hint: '74 MB — downloads once, then cached. More accurate, handles accents and background noise better.' },
];

export function initTranscriber() {
  const dropzone       = document.getElementById('tr-dropzone');
  const fileInput      = document.getElementById('tr-file-input');
  const dropText       = document.getElementById('tr-drop-text');
  const modelChipsEl   = document.getElementById('tr-model-chips');
  const transcribeBtn  = document.getElementById('tr-transcribe-btn');
  const progressWrap   = document.getElementById('tr-progress-wrap');
  const progressBar    = document.getElementById('tr-progress-bar');
  const progressLabel  = document.getElementById('tr-progress-label');
  const output         = document.getElementById('tr-output');
  const segmentsEl     = document.getElementById('tr-segments');
  const exportSrt      = document.getElementById('tr-export-srt');
  const exportVtt      = document.getElementById('tr-export-vtt');
  const exportTxt      = document.getElementById('tr-export-txt');
  const findReplaceBtn = document.getElementById('tr-find-replace-btn');
  const findBar        = document.getElementById('tr-find-bar');
  const findInput      = document.getElementById('tr-find-input');
  const replaceInput   = document.getElementById('tr-replace-input');
  const matchCount     = document.getElementById('tr-match-count');
  const findPrevBtn    = document.getElementById('tr-find-prev');
  const findNextBtn    = document.getElementById('tr-find-next');
  const replaceOneBtn  = document.getElementById('tr-replace-one');
  const replaceAllBtn  = document.getElementById('tr-replace-all');
  const findCloseBtn   = document.getElementById('tr-find-close');

  let audioFile     = null;
  let selectedModel = MODELS[0].id;
  let segments      = [];
  let worker        = null;
  let hasEdits      = false;

  // ── Model chips ────────────────────────────────────────────────────────────
  const modelHint = document.getElementById('tr-model-hint');

  function selectModel(m, btn) {
    modelChipsEl.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    selectedModel = m.id;
    if (modelHint) modelHint.textContent = m.hint;
  }

  MODELS.forEach((m, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (i === 0 ? ' active' : '');
    btn.textContent = m.label;
    btn.addEventListener('click', () => selectModel(m, btn));
    modelChipsEl.appendChild(btn);
    if (i === 0) { selectedModel = m.id; if (modelHint) modelHint.textContent = m.hint; }
  });

  // ── File drop / pick ───────────────────────────────────────────────────────
  setupDropzone(dropzone, f => f.type.startsWith('audio/') || f.type.startsWith('video/'), loadFile);
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

  function loadFile(file) {
    audioFile = file;
    dropText.textContent = file.name;
    dropzone.classList.add('has-file');
    transcribeBtn.disabled = false;
    output.style.display = 'none';
    segmentsEl.innerHTML = '';
    segments = [];
    hasEdits = false;
    closeFindBar();
  }

  // ── Transcribe ─────────────────────────────────────────────────────────────
  transcribeBtn.addEventListener('click', () => {
    if (!audioFile) return;
    if (hasEdits && !confirm('Re-transcribing will discard your edits. Continue?')) return;
    runTranscription();
  });

  async function runTranscription() {
    hasEdits = false;
    closeFindBar();
    transcribeBtn.disabled = true;
    output.style.display   = 'none';
    segmentsEl.innerHTML   = '';
    segments = [];
    progressWrap.style.display = '';
    progressBar.style.width    = '0%';
    progressLabel.textContent  = 'Decoding audio…';

    let audioData;
    try {
      audioData = await decodeAudioTo16k(audioFile);
    } catch (e) {
      showError('Could not decode audio: ' + e.message);
      return;
    }

    progressLabel.textContent = 'Loading model…';
    progressBar.style.width   = '10%';

    if (!worker) {
      worker = new Worker(new URL('./transcriber.worker.js', import.meta.url), { type: 'module' });
    }

    worker.onmessage = ({ data }) => {
      if (data.type === 'status') {
        progressLabel.textContent = data.text;
      }
      if (data.type === 'download') {
        const pct = data.total ? Math.round((data.loaded / data.total) * 40) + 10 : 10;
        progressBar.style.width  = pct + '%';
        const mb = data.total ? ' (' + Math.round(data.total / 1e6) + ' MB)' : '';
        progressLabel.textContent = 'Downloading model' + mb + '…';
      }
      if (data.type === 'ready') {
        progressBar.style.width   = '55%';
        progressLabel.textContent = 'Transcribing…';
        worker.postMessage({ type: 'transcribe', audio: audioData }, [audioData.buffer]);
      }
      if (data.type === 'chunk') {
        data.chunks.forEach(c => {
          if (!c.text.trim()) return;
          segments.push(c);
          renderSegment(c, segments.length - 1);
        });
        const pct = Math.min(95, 55 + segments.length);
        progressBar.style.width = pct + '%';
      }
      if (data.type === 'done') {
        if (data.result.chunks) {
          segmentsEl.innerHTML = '';
          segments = data.result.chunks.filter(c => c.text.trim());
          segments.forEach((c, i) => renderSegment(c, i));
        }
        progressBar.style.width   = '100%';
        progressLabel.textContent = 'Done';
        setTimeout(() => { progressWrap.style.display = 'none'; }, 800);
        output.style.display   = '';
        transcribeBtn.disabled = false;
      }
      if (data.type === 'error') {
        showError(data.message);
      }
    };

    worker.postMessage({ type: 'load', model: selectedModel });
  }

  // ── Segment rendering ──────────────────────────────────────────────────────
  function renderSegment(chunk, idx) {
    const el = document.createElement('div');
    el.className = 'tr-segment';
    el.dataset.segIdx = idx;

    const ts = chunk.timestamp;
    const timeStr = ts ? formatTime(ts[0]) + ' – ' + formatTime(ts[1]) : '';

    const tsSpan = document.createElement('span');
    tsSpan.className = 'tr-ts';
    tsSpan.textContent = timeStr;

    const textSpan = document.createElement('span');
    textSpan.className = 'tr-text';
    textSpan.contentEditable = 'true';
    textSpan.spellcheck = true;
    textSpan.textContent = chunk.text.trim();
    textSpan.addEventListener('input', () => {
      if (segments[idx]) {
        segments[idx].text = textSpan.textContent;
        hasEdits = true;
      }
    });

    el.appendChild(tsSpan);
    el.appendChild(textSpan);
    segmentsEl.appendChild(el);
    el.scrollIntoView({ block: 'nearest' });
  }

  function showError(msg) {
    progressLabel.textContent = '⚠ ' + msg;
    progressBar.style.width   = '0%';
    transcribeBtn.disabled    = false;
  }

  // ── Find & Replace ─────────────────────────────────────────────────────────
  let matches      = []; // [{ segIdx, start, end }]
  let currentMatch = -1;
  let findOpen     = false;

  findReplaceBtn?.addEventListener('click', () => {
    findOpen ? closeFindBar() : openFindBar();
  });

  findCloseBtn?.addEventListener('click', closeFindBar);

  findInput?.addEventListener('input', rebuildMatches);

  findPrevBtn?.addEventListener('click', () => {
    if (!matches.length) return;
    navigateTo((currentMatch - 1 + matches.length) % matches.length);
  });

  findNextBtn?.addEventListener('click', () => {
    if (!matches.length) return;
    navigateTo((currentMatch + 1) % matches.length);
  });

  findInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.shiftKey ? findPrevBtn.click() : findNextBtn.click(); e.preventDefault(); }
    if (e.key === 'Escape') closeFindBar();
  });
  replaceInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { replaceOneBtn.click(); e.preventDefault(); }
    if (e.key === 'Escape') closeFindBar();
  });

  replaceOneBtn?.addEventListener('click', replaceOne);
  replaceAllBtn?.addEventListener('click', replaceAll);

  function openFindBar() {
    if (!segments.length) return;
    findOpen = true;
    findBar.style.display = '';
    findReplaceBtn.classList.add('active');
    setContentEditable(false);
    findInput.focus();
    if (findInput.value) findInput.select();
    rebuildMatches();
  }

  function closeFindBar() {
    findOpen = false;
    if (findBar) findBar.style.display = 'none';
    if (findReplaceBtn) findReplaceBtn.classList.remove('active');
    clearHighlights();
    matches = [];
    currentMatch = -1;
    updateMatchCount();
    setContentEditable(true);
  }

  function setContentEditable(on) {
    segmentsEl.querySelectorAll('.tr-text').forEach(el => {
      el.contentEditable = on ? 'true' : 'false';
    });
  }

  function rebuildMatches() {
    const needle = findInput?.value || '';
    matches = [];
    if (!needle) {
      clearHighlights();
      updateMatchCount();
      return;
    }
    const lowerNeedle = needle.toLowerCase();
    segments.forEach((seg, segIdx) => {
      const text = seg.text || '';
      const lower = text.toLowerCase();
      let pos = 0;
      while (pos <= lower.length - lowerNeedle.length) {
        const idx = lower.indexOf(lowerNeedle, pos);
        if (idx === -1) break;
        matches.push({ segIdx, start: idx, end: idx + needle.length });
        pos = idx + 1;
      }
    });
    currentMatch = matches.length > 0 ? 0 : -1;
    renderHighlights();
    updateMatchCount();
    if (currentMatch !== -1) scrollToCurrent();
  }

  function renderHighlights() {
    // Reset all to plain text first
    segmentsEl.querySelectorAll('[data-seg-idx]').forEach(div => {
      const idx = Number(div.dataset.segIdx);
      const textSpan = div.querySelector('.tr-text');
      if (!textSpan || !segments[idx]) return;
      textSpan.innerHTML = escHtml(segments[idx].text);
    });

    if (!matches.length) return;

    // Group matches by segment index
    const bySegment = {};
    matches.forEach((m, mi) => {
      (bySegment[m.segIdx] ??= []).push({ ...m, matchIdx: mi });
    });

    Object.entries(bySegment).forEach(([segIdxStr, mList]) => {
      const segIdx = Number(segIdxStr);
      const div = segmentsEl.querySelector(`[data-seg-idx="${segIdx}"]`);
      const textSpan = div?.querySelector('.tr-text');
      if (!textSpan || !segments[segIdx]) return;

      const text = segments[segIdx].text;
      let html = '';
      let pos = 0;
      mList.forEach(m => {
        html += escHtml(text.slice(pos, m.start));
        const cls = 'tr-match' + (m.matchIdx === currentMatch ? ' tr-match-current' : '');
        html += `<mark class="${cls}">${escHtml(text.slice(m.start, m.end))}</mark>`;
        pos = m.end;
      });
      html += escHtml(text.slice(pos));
      textSpan.innerHTML = html;
    });
  }

  function clearHighlights() {
    segmentsEl.querySelectorAll('[data-seg-idx]').forEach(div => {
      const idx = Number(div.dataset.segIdx);
      const textSpan = div.querySelector('.tr-text');
      if (!textSpan || !segments[idx]) return;
      textSpan.textContent = segments[idx].text;
    });
  }

  function navigateTo(idx) {
    currentMatch = idx;
    renderHighlights();
    updateMatchCount();
    scrollToCurrent();
  }

  function scrollToCurrent() {
    if (currentMatch === -1) return;
    const m = matches[currentMatch];
    const div = segmentsEl.querySelector(`[data-seg-idx="${m.segIdx}"]`);
    div?.querySelector('.tr-match-current')?.scrollIntoView({ block: 'nearest' });
  }

  function updateMatchCount() {
    if (!matchCount) return;
    const needle = findInput?.value || '';
    if (!needle)          { matchCount.textContent = ''; return; }
    if (!matches.length)  { matchCount.textContent = 'No matches'; return; }
    matchCount.textContent = `${currentMatch + 1} of ${matches.length}`;
  }

  function replaceOne() {
    if (currentMatch === -1 || !matches.length) return;
    const m = matches[currentMatch];
    const seg = segments[m.segIdx];
    if (!seg) return;
    const replacement = replaceInput?.value ?? '';
    seg.text = seg.text.slice(0, m.start) + replacement + seg.text.slice(m.end);
    hasEdits = true;
    const prevIdx = currentMatch;
    rebuildMatches();
    if (matches.length) navigateTo(Math.min(prevIdx, matches.length - 1));
  }

  function replaceAll() {
    if (!matches.length) return;
    const needle = findInput?.value || '';
    const replacement = replaceInput?.value ?? '';
    if (!needle) return;
    const lowerNeedle = needle.toLowerCase();

    segments.forEach((seg, segIdx) => {
      if (!seg.text.toLowerCase().includes(lowerNeedle)) return;
      let result = '';
      const text = seg.text;
      const lower = text.toLowerCase();
      let pos = 0;
      while (pos < text.length) {
        const idx = lower.indexOf(lowerNeedle, pos);
        if (idx === -1) { result += text.slice(pos); break; }
        result += text.slice(pos, idx) + replacement;
        pos = idx + needle.length;
      }
      seg.text = result;
      // Sync span
      const div = segmentsEl.querySelector(`[data-seg-idx="${segIdx}"]`);
      const textSpan = div?.querySelector('.tr-text');
      if (textSpan) textSpan.innerHTML = escHtml(seg.text);
    });
    hasEdits = true;
    matches = [];
    currentMatch = -1;
    updateMatchCount();
    // Brief "All replaced" feedback
    if (matchCount) {
      matchCount.textContent = 'All replaced';
      setTimeout(() => updateMatchCount(), 1500);
    }
  }

  // ── Exports ────────────────────────────────────────────────────────────────
  exportSrt.addEventListener('click', () => {
    const text = segments.map((c, i) => {
      const ts = c.timestamp || [0, 0];
      return `${i + 1}\n${srtTime(ts[0])} --> ${srtTime(ts[1])}\n${c.text.trim()}\n`;
    }).join('\n');
    saveFile(new Blob([text], { type: 'text/plain' }), baseName() + '.srt', 'text/plain');
  });

  exportVtt.addEventListener('click', () => {
    const lines = segments.map(c => {
      const ts = c.timestamp || [0, 0];
      return `${vttTime(ts[0])} --> ${vttTime(ts[1])}\n${c.text.trim()}`;
    });
    saveFile(new Blob(['WEBVTT\n\n' + lines.join('\n\n')], { type: 'text/vtt' }), baseName() + '.vtt', 'text/vtt');
  });

  exportTxt.addEventListener('click', () => {
    const text = segments.map(c => c.text.trim()).join('\n');
    saveFile(new Blob([text], { type: 'text/plain' }), baseName() + '.txt', 'text/plain');
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function decodeAudioTo16k(file) {
    const arrayBuffer = await file.arrayBuffer();
    const tmpCtx  = new AudioContext();
    const decoded = await tmpCtx.decodeAudioData(arrayBuffer);
    await tmpCtx.close();
    const targetRate = 16000;
    const offCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
    const src = offCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(offCtx.destination);
    src.start(0);
    const resampled = await offCtx.startRendering();
    return resampled.getChannelData(0);
  }

  function formatTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }
  function srtTime(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).replace('.', ',');
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${sec}`;
  }
  function vttTime(s) { return srtTime(s).replace(',', '.'); }
  function baseName() { return audioFile ? audioFile.name.replace(/\.[^.]+$/, '') : 'transcript'; }
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
}
