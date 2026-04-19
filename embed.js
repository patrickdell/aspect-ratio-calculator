/**
 * embed.js — responsive embed code generator
 * Ported from tgamembed.netlify.app (embed-responsively.html)
 */

const RATIOS = [
  { label: '16:9 — Widescreen', value: '56.25%'  },
  { label: '4:3 — Standard',    value: '75%'      },
  { label: '4:5 — Portrait',    value: '125%'     },
  { label: '1:1 — Square',      value: '100%'     },
  { label: '9:16 — Vertical',   value: '177.78%'  },
];

const SERVICES = [
  { id:'youtube',    label:'YouTube',        inputType:'url',   placeholder:'https://www.youtube.com/watch?v=dQw4w9WgXcQ', hint:'Paste a YouTube video URL',                                           defaultRatio:'56.25%',  parse:parseYouTube   },
  { id:'ytshorts',   label:'YouTube Shorts', inputType:'url',   placeholder:'https://www.youtube.com/shorts/dQw4w9WgXcQ',  hint:'Paste a YouTube Shorts URL',                                          defaultRatio:'177.78%', parse:parseYTShorts  },
  { id:'tiktok',     label:'TikTok',         inputType:'url',   placeholder:'https://www.tiktok.com/@user/video/123',      hint:'Paste a TikTok video URL',                                             defaultRatio:'177.78%', parse:parseTikTok    },
  { id:'vimeo',      label:'Vimeo',          inputType:'url',   placeholder:'https://vimeo.com/123456789',                 hint:'Paste a Vimeo video URL',                                              defaultRatio:'56.25%',  parse:parseVimeo     },
  { id:'googlemaps', label:'Google Maps',    inputType:'embed', placeholder:'<iframe src="https://www.google.com/maps/embed?pb=..." ...></iframe>', hint:'Paste the embed code from Google Maps → Share → Embed a map', defaultRatio:'75%',    parse:parseGoogleMaps},
  { id:'instagram',  label:'Instagram',      inputType:'url',   placeholder:'https://www.instagram.com/p/ABCdef123/',     hint:'Paste an Instagram post URL',                                          defaultRatio:'100%',    parse:parseInstagram },
  { id:'twitter',    label:'X / Twitter',    inputType:'url',   placeholder:'https://x.com/user/status/1234567890123',    hint:'Paste an X or Twitter post URL',                                       special:'twitter',      parse:parseTwitter   },
  { id:'spotify',    label:'Spotify',        inputType:'url',   placeholder:'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', hint:'Paste a Spotify track, album, playlist, podcast or episode URL', special:'spotify', parse:parseSpotify },
  { id:'soundcloud', label:'SoundCloud',     inputType:'url',   placeholder:'https://soundcloud.com/artist/track-name',   hint:'Paste a SoundCloud track or playlist URL',                             special:'soundcloud',   parse:parseSoundCloud},
  { id:'generic',    label:'Generic iframe', inputType:'url',   placeholder:'https://example.com/embed/123',              hint:'Paste the embed URL — it will be wrapped in a responsive container',  defaultRatio:'56.25%',  parse:parseGeneric   },
];

// ── Parsers ───────────────────────────────────────────────────────────────

function extractIframeSrc(code) {
  const m = code.match(/src="([^"]+)"/i) || code.match(/src='([^']+)'/i);
  return m ? m[1] : null;
}

function parseYouTube(input) {
  input = input.trim();
  if (input.startsWith('<')) {
    const s = extractIframeSrc(input);
    return s?.includes('youtube') ? cleanYouTubeEmbedUrl(s) : null;
  }
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return 'https://www.youtube.com/embed/' + url.pathname.slice(1).split('/')[0];
    const shorts = url.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
    if (shorts) return 'https://www.youtube.com/embed/' + shorts[1];
    const live = url.pathname.match(/\/live\/([A-Za-z0-9_-]+)/);
    if (live) return 'https://www.youtube.com/embed/' + live[1];
    const v = url.searchParams.get('v');
    if (v) return 'https://www.youtube.com/embed/' + v;
    if (url.pathname.includes('/embed/')) return cleanYouTubeEmbedUrl(input);
  } catch (_) {}
  const m = input.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  const raw = m ? 'https://www.youtube.com/embed/' + m[1] : null;
  return raw ? cleanYouTubeEmbedUrl(raw) : null;
}

function parseYTShorts(input) {
  const m = input.trim().match(/\/shorts\/([A-Za-z0-9_-]+)/);
  return m ? 'https://www.youtube.com/embed/' + m[1] : parseYouTube(input);
}

function parseTikTok(input) {
  const m = input.trim().match(/\/video\/(\d+)/);
  return m ? 'https://www.tiktok.com/embed/v2/' + m[1] : null;
}

function parseVimeo(input) {
  input = input.trim();
  if (input.startsWith('<')) { const s = extractIframeSrc(input); return s?.includes('vimeo') ? s : null; }
  try {
    const url = new URL(input);
    if (url.hostname.includes('vimeo')) {
      const id = url.pathname.split('/').filter(Boolean).reverse().find(s => /^\d+$/.test(s));
      if (id) return 'https://player.vimeo.com/video/' + id;
    }
  } catch (_) {}
  const m = input.match(/vimeo\.com\/(?:.*\/)?(\d+)/);
  return m ? 'https://player.vimeo.com/video/' + m[1] : null;
}

function parseGoogleMaps(input) { return extractIframeSrc(input.trim()); }

function parseInstagram(input) {
  input = input.trim();
  if (input.startsWith('<')) return extractIframeSrc(input);
  const m = input.match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/);
  return m ? 'https://www.instagram.com/p/' + m[1] + '/embed/' : null;
}

function parseGeneric(input) {
  input = input.trim();
  if (!/^https?:\/\//i.test(input) && !input.startsWith('<')) return null;
  if (input.startsWith('<')) return extractIframeSrc(input);
  return input;
}

// ── URL helpers ───────────────────────────────────────────────────────────

function cleanYouTubeEmbedUrl(url) {
  try {
    const u = new URL(url);
    ['si', 'feature', 'app', 'pp', 'list'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

function isSoundCloudSet(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 2 && parts[1] === 'sets';
  } catch { return false; }
}

// ── New service parsers ────────────────────────────────────────────────────

function parseTwitter(input) {
  input = input.trim();
  if (input.startsWith('<')) {
    const m = input.match(/status\/(\d+)/);
    return m ? m[1] : null;
  }
  const m = input.match(/(?:twitter|x)\.com\/[^/?#]+\/status\/(\d+)/);
  return m ? m[1] : null; // returns tweet ID string
}

function parseSpotify(input) {
  input = input.trim();
  if (input.startsWith('<')) return extractIframeSrc(input);
  // Spotify URI: spotify:track:ID
  const uri = input.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/);
  if (uri) return `https://open.spotify.com/embed/${uri[1]}/${uri[2]}?utm_source=generator`;
  try {
    const url = new URL(input.startsWith('http') ? input : 'https://' + input);
    if (url.hostname === 'open.spotify.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const type = parts[0]; // track, album, playlist, episode, show
        const id   = parts[1].split('?')[0];
        return `https://open.spotify.com/embed/${type}/${id}?utm_source=generator`;
      }
    }
  } catch (_) {}
  return null;
}

function parseSoundCloud(input) {
  input = input.trim();
  if (input.startsWith('<')) return extractIframeSrc(input); // already embed URL
  if (/soundcloud\.com/.test(input)) return input; // return as source URL for url= param
  return null;
}

// ── Output builders ───────────────────────────────────────────────────────

function timeToSeconds(val) {
  val = val.trim();
  if (!val) return 0;
  const parts = val.split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return isNaN(parts[0]) ? 0 : parts[0];
}

function buildOutput(src, paddingBottom, bgColor, floatRight) {
  bgColor = bgColor || '#000000';
  const embedBlock =
`<style>
.embed-container {
  position: relative;
  padding-bottom: ${paddingBottom};
  height: 0;
  overflow: hidden;
  max-width: 100%;
  background: ${bgColor};
}
.embed-container iframe {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
}
</style>
<div class="embed-container">
  <iframe src="${src}"
          frameborder="0"
          allowfullscreen
          loading="lazy"
          title="Embedded content">
  </iframe>
</div>`;

  if (!floatRight) return embedBlock;
  return `<style>
@media (min-width: 700px) {
  .gi-mm-slider {
    max-width: 18.75rem;
    margin: 0px 0px 0.625rem 1.25rem !important;
    float: right;
    clear: both;
  }
}
</style>
<div class="gi-mm-slider">
${embedBlock}
</div>`;
}

function renderPreview(container, src, paddingBottom, bgColor) {
  bgColor = bgColor || '#000000';
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;padding-bottom:${paddingBottom};height:0;overflow:hidden;max-width:100%;background:${bgColor}`;
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
  iframe.setAttribute('title', 'Embedded content');
  iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0';
  wrap.appendChild(iframe);
  container.appendChild(wrap);
}

// ── Clipboard ─────────────────────────────────────────────────────────────

function copyText(text, btn) {
  function showFeedback() {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy code'; btn.classList.remove('copied'); }, 2000);
  }
  navigator.clipboard?.writeText(text).then(showFeedback).catch(fallback) ?? fallback();
  function fallback() {
    try {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showFeedback();
    } catch (_) {}
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function esc(str)     { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(str) { return str.replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function buildRatioOptions(defaultValue) {
  return RATIOS.map(r =>
    `<option value="${r.value}"${r.value === defaultValue ? ' selected' : ''}>${r.label}</option>`
  ).join('');
}

// ── Panel HTML per service ────────────────────────────────────────────────

function buildOptionsRow(svc) {
  if (svc.special === 'twitter') {
    return `<div class="e-row">
  <div class="e-field">
    <label for="ew-twitter">Max width</label>
    <select id="ew-twitter">
      <option value="auto">Full width</option>
      <option value="550" selected>550px — Standard</option>
      <option value="325">325px — Narrow</option>
    </select>
  </div>
  <button class="e-btn e-btn-primary" data-gen="twitter">Generate</button>
  <button class="e-btn-clear" data-clear="twitter">Clear</button>
</div>`;
  }
  if (svc.special === 'spotify') {
    return `<div class="e-row">
  <div class="e-field">
    <label for="eh-spotify">Player size</label>
    <select id="eh-spotify">
      <option value="80">80px — Mini player</option>
      <option value="152">152px — Compact</option>
      <option value="352" selected>352px — Standard</option>
    </select>
  </div>
  <button class="e-btn e-btn-primary" data-gen="spotify">Generate</button>
  <button class="e-btn-clear" data-clear="spotify">Clear</button>
</div>`;
  }
  if (svc.special === 'soundcloud') {
    return `<div class="e-row">
  <div class="e-color-field">
    <label for="eb-soundcloud">Accent colour</label>
    <input type="color" id="eb-soundcloud" value="#da161f">
  </div>
  <button class="e-btn e-btn-primary" data-gen="soundcloud">Generate</button>
  <button class="e-btn-clear" data-clear="soundcloud">Clear</button>
</div>`;
  }
  // Standard
  return `<div class="e-row">
  <div class="e-field">
    <label for="er-${svc.id}">Aspect ratio</label>
    <select id="er-${svc.id}">${buildRatioOptions(svc.defaultRatio)}</select>
  </div>
  <div class="e-color-field">
    <label for="eb-${svc.id}">Background</label>
    <input type="color" id="eb-${svc.id}" value="#000000">
  </div>
  <button class="e-btn e-btn-primary" data-gen="${svc.id}">Generate</button>
  <button class="e-btn-clear" data-clear="${svc.id}">Clear</button>
</div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────

export function initEmbed() {
  const tabBar = document.getElementById('embedTabBar');
  const panels = document.getElementById('embedPanels');

  SERVICES.forEach((svc, i) => {
    // Tab button
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'svc-btn' + (i === 0 ? ' active' : '');
    btn.dataset.svc = svc.id;
    btn.textContent = svc.label;
    tabBar.appendChild(btn);

    const inputEl = svc.inputType === 'embed'
      ? `<textarea id="ei-${svc.id}" placeholder="${escAttr(svc.placeholder)}" spellcheck="false" autocomplete="off"></textarea>`
      : `<input type="url" id="ei-${svc.id}" placeholder="${escAttr(svc.placeholder)}" spellcheck="false" autocomplete="off">`;

    const youtubeExtras = svc.id === 'youtube' ? `
  <div class="e-row" style="margin-top:.75rem">
    <div class="e-field" style="flex:0 0 140px">
      <label for="est-youtube">Start time (optional)</label>
      <input type="text" id="est-youtube" placeholder="0:00" style="font-family:monospace" autocomplete="off" spellcheck="false">
    </div>
  </div>` : '';

    // Show colour swatches for services with a colour picker (standard + soundcloud)
    const showSwatches = !svc.special || svc.special === 'soundcloud';
    const swatchTarget  = `eb-${svc.id}`;
    const swatchesHtml  = showSwatches ? `
  <div class="e-swatches" data-target="${swatchTarget}">
    <span class="e-swatch-label" title="Colour presets">🎨</span>
    <span class="e-swatch" style="background:#000000" title="Black" data-color="#000000"></span>
    <span class="e-swatch" style="background:#ffffff;border-color:rgba(0,0,0,0.25)" title="White" data-color="#ffffff"></span>
    <span class="e-swatch" style="background:#D50202" title="Red" data-color="#D50202"></span>
    <span class="e-swatch" style="background:#CA0101" data-color="#CA0101"></span>
    <span class="e-swatch" style="background:#AC0000" data-color="#AC0000"></span>
    <span class="e-swatch" style="background:#880000" data-color="#880000"></span>
    <span class="e-swatch" style="background:#FAE1E1" data-color="#FAE1E1"></span>
    <span class="e-swatch" style="background:#268626" title="Green" data-color="#268626"></span>
    <span class="e-swatch" style="background:#1C731C" data-color="#1C731C"></span>
    <span class="e-swatch" style="background:#0B560D" data-color="#0B560D"></span>
    <span class="e-swatch" style="background:#E5F0E5" data-color="#E5F0E5"></span>
    <span class="e-swatch" style="background:#096080" title="Blue" data-color="#096080"></span>
    <span class="e-swatch" style="background:#E5EFF1" data-color="#E5EFF1"></span>
    <span class="e-swatch" style="background:#F8EC88" title="Yellow" data-color="#F8EC88"></span>
  </div>` : '';

    // Float-right option: hide for twitter (blockquote doesn't float cleanly)
    const floatHtml = svc.special !== 'twitter' ? `
  <div class="e-float-row">
    <input type="checkbox" id="ef-${svc.id}">
    <label for="ef-${svc.id}" style="text-transform:none;letter-spacing:0;font-weight:400;font-size:.88rem;color:var(--muted);cursor:pointer;margin:0">Float right</label>
  </div>` : '';

    const panel = document.createElement('div');
    panel.className = 'svc-panel' + (i === 0 ? ' active' : '');
    panel.id = 'ep-' + svc.id;
    panel.innerHTML = `
<div class="e-card">
  <label for="ei-${svc.id}">${svc.label}</label>
  ${inputEl}
  <p class="e-hint">${esc(svc.hint)}</p>
  ${buildOptionsRow(svc)}
  ${swatchesHtml}
  ${youtubeExtras}
  ${floatHtml}
  <div class="e-error" id="ee-${svc.id}"></div>
  <div class="e-output" id="eo-${svc.id}">
    <div class="e-output-header">
      <span>Generated code</span>
      <button class="e-btn e-btn-copy" data-ecopy="${svc.id}">Copy code</button>
    </div>
    <textarea class="e-code" id="ec-${svc.id}" readonly spellcheck="false"></textarea>
    <p class="e-preview-label">Live preview</p>
    <div class="e-preview-wrap" id="epv-${svc.id}"></div>
  </div>
</div>`;
    panels.appendChild(panel);
  });

  // Service tab switching
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.svc-btn');
    if (!btn) return;
    const id = btn.dataset.svc;
    tabBar.querySelectorAll('.svc-btn').forEach(b => b.classList.remove('active'));
    panels.querySelectorAll('.svc-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('ep-' + id).classList.add('active');
  });

  // Generate + copy + clear + swatches + Enter key
  panels.addEventListener('click', e => {
    const gen = e.target.closest('[data-gen]');
    if (gen) { handleGenerate(gen.dataset.gen); return; }
    const copy = e.target.closest('[data-ecopy]');
    if (copy) { copyText(document.getElementById('ec-' + copy.dataset.ecopy).value, copy); return; }
    const clr = e.target.closest('[data-clear]');
    if (clr) {
      const id = clr.dataset.clear;
      document.getElementById('ei-' + id).value = '';
      const ee = document.getElementById('ee-' + id);
      ee.textContent = ''; ee.classList.remove('visible');
      document.getElementById('eo-' + id).classList.remove('visible');
      return;
    }
    const swatch = e.target.closest('.e-swatch');
    if (swatch) {
      const swatchGroup = swatch.closest('.e-swatches');
      swatchGroup.querySelectorAll('.e-swatch').forEach(s => s.classList.remove('e-swatch--active'));
      swatch.classList.add('e-swatch--active');
      const picker = document.getElementById(swatchGroup.dataset.target);
      if (picker) picker.value = swatch.dataset.color;
      return;
    }
    if (e.target.classList.contains('e-code')) e.target.select();
  });

  panels.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      const panel = e.target.closest('.svc-panel');
      if (panel) handleGenerate(panel.id.replace('ep-', ''));
    }
  });

  // Auto-generate on paste into the embed panel area
  panels.addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (!text) return;
    const activePanel = panels.querySelector('.svc-panel.active');
    if (!activePanel) return;
    const input = activePanel.querySelector('input[type="url"], textarea');
    if (!input || document.activeElement === input) return; // don't double-fire if already focused
    input.value = text;
    const svcId = activePanel.id.replace('ep-', '');
    setTimeout(() => handleGenerate(svcId), 100);
  });

  function showError(svcId, msg) {
    const errorEl  = document.getElementById('ee-' + svcId);
    const outputEl = document.getElementById('eo-' + svcId);
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
    outputEl.classList.remove('visible');
  }

  function handleGenerate(svcId) {
    const svc = SERVICES.find(s => s.id === svcId);
    if (!svc) return;

    const inputEl   = document.getElementById('ei-' + svcId);
    const errorEl   = document.getElementById('ee-' + svcId);
    const outputEl  = document.getElementById('eo-' + svcId);
    const codeEl    = document.getElementById('ec-' + svcId);
    const previewEl = document.getElementById('epv-' + svcId);

    const input = inputEl.value.trim();
    errorEl.textContent = '';
    errorEl.classList.remove('visible');

    if (!input) {
      showError(svcId, 'Please paste a URL or embed code above.');
      return;
    }

    let src;
    try { src = svc.parse(input); } catch (_) { src = null; }

    if (!src) {
      showError(svcId, 'Could not extract an embed URL. Double-check it and try again.');
      return;
    }

    // ── X / Twitter ───────────────────────────────────────────────────────
    if (svcId === 'twitter') {
      const tweetId  = src; // tweet ID string
      let   tweetUrl = input;
      if (!tweetUrl.startsWith('http')) tweetUrl = 'https://' + tweetUrl;
      const width     = document.getElementById('ew-twitter')?.value ?? '550';
      const widthAttr = width === 'auto' ? '' : ` data-width="${width}"`;
      codeEl.value = `<blockquote class="twitter-tweet"${widthAttr}>\n  <a href="${tweetUrl}"></a>\n</blockquote>\n<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"><\/script>`;
      previewEl.innerHTML = `<iframe src="https://platform.twitter.com/embed/Tweet.html?id=${tweetId}" style="width:100%;border:0;height:300px" frameborder="0" scrolling="no" allowtransparency="true"></iframe>`;
      outputEl.classList.add('visible');
      codeEl.select();
      return;
    }

    // ── Spotify ───────────────────────────────────────────────────────────
    if (svcId === 'spotify') {
      const height     = document.getElementById('eh-spotify')?.value ?? '352';
      const floatRight = document.getElementById('ef-spotify')?.checked;
      const iframe     = `<iframe style="border-radius:12px" src="${src}" width="100%" height="${height}" frameborder="0" allowfullscreen allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
      codeEl.value     = floatRight
        ? `<div style="float:right;clear:both;max-width:340px;margin:0 0 10px 20px">\n${iframe}\n</div>`
        : iframe;
      previewEl.innerHTML = iframe;
      outputEl.classList.add('visible');
      codeEl.select();
      return;
    }

    // ── SoundCloud ────────────────────────────────────────────────────────
    if (svcId === 'soundcloud') {
      const color      = (document.getElementById('eb-soundcloud')?.value ?? '#da161f').replace('#', '');
      const height     = isSoundCloudSet(src) ? 450 : 166;
      const floatRight = document.getElementById('ef-soundcloud')?.checked;
      const embedUrl   = `https://w.soundcloud.com/player/?url=${encodeURIComponent(src)}&color=%23${color}&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true`;
      const iframe     = `<iframe width="100%" height="${height}" scrolling="no" frameborder="no" allow="autoplay" src="${embedUrl}"></iframe>`;
      codeEl.value     = floatRight
        ? `<div style="float:right;clear:both;max-width:340px;margin:0 0 10px 20px">\n${iframe}\n</div>`
        : iframe;
      previewEl.innerHTML = iframe;
      outputEl.classList.add('visible');
      codeEl.select();
      return;
    }

    // ── Standard responsive embed ─────────────────────────────────────────
    const ratioEl       = document.getElementById('er-' + svcId);
    const paddingBottom = ratioEl.value;
    const bgColor       = document.getElementById('eb-' + svcId).value;

    if (svcId === 'youtube') {
      const secs = timeToSeconds(document.getElementById('est-youtube').value);
      if (secs > 0) src += (src.includes('?') ? '&' : '?') + 'start=' + secs;
    }

    const floatRight = document.getElementById('ef-' + svcId).checked;

    codeEl.value = buildOutput(src, paddingBottom, bgColor, floatRight);
    renderPreview(previewEl, src, paddingBottom, bgColor);
    outputEl.classList.add('visible');
    codeEl.select();
  }
}
