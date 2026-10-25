'use strict';

const api = window.pc;
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  platform: 'win32',
  version: '',
  clips: [],
  query: '',
  rec: 'idle', // idle | starting | recording | saving
  freshId: null
};

// ---------- i18n ----------
function T() { return window.I18N[state.settings?.language || 'ar']; }
function t(key, vars = {}) {
  let s = T()[key];
  if (typeof s !== 'string') return s ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}
function hotkeyLabel(accel = state.settings?.hotkey || 'F8') {
  const isMac = state.platform === 'darwin';
  return accel
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replace('Shift', isMac ? '⇧' : 'Shift')
    .split('+').join(isMac ? '' : ' + ');
}

function applyLanguage() {
  const lang = state.settings.language;
  const root = document.documentElement;
  root.lang = lang;
  root.dir = T().dir;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const vars = el.hasAttribute('data-key') ? { key: hotkeyLabel() } : {};
    el.textContent = t(el.dataset.i18n, vars);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  $('langBtn').textContent = T().langSwitch;
  $('hotkeyCap').textContent = hotkeyLabel();
  $('hotkeyShow').textContent = hotkeyLabel();
  $('macHint').hidden = !(state.platform === 'darwin' && /^F\d+$/.test(state.settings.hotkey));
  updateRecUi();
  renderClips();
}

function applyTheme() {
  const th = state.settings.theme;
  if (th === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
  document.querySelectorAll('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeVal === th)));
}

function mountIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.dataset.iconMounted) {
      el.insertAdjacentHTML('afterbegin', window.ICONS[el.dataset.icon] || '');
      el.dataset.iconMounted = '1';
    }
  });
}

// ---------- toasts ----------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

// ---------- formatting ----------
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}
function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  const loc = state.settings.language === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
  return mb >= 1
    ? `${mb.toLocaleString(loc, { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(loc)} KB`;
}
function fmtWhen(iso) {
  const d = new Date(iso);
  const loc = state.settings.language === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
  const time = d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return `${t('today')} ${time}`;
  if (same(d, yest)) return `${t('yesterday')} ${time}`;
  return `${d.toLocaleDateString(loc, { day: 'numeric', month: 'short' })} ${time}`;
}

// ---------- recorder ----------
let screenStream = null;
let micStream = null;
let recorder = null;
let chunks = [];
let startedAt = 0;
let mimeType = '';
let discardNext = false;
let audioCtx = null;
let levelTimer = null;

function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function setRec(s) {
  state.rec = s;
  updateRecUi();
}

function updateRecUi() {
  if (!state.settings) return;
  document.body.classList.toggle('is-recording', state.rec === 'recording');
  document.body.classList.toggle('is-busy', state.rec === 'starting' || state.rec === 'saving');
  const label = {
    idle: t('recordStart'),
    starting: t('starting'),
    recording: t('recordStop'),
    saving: t('saving')
  }[state.rec];
  $('recLabel').textContent = label;
  $('recBtn').setAttribute('aria-label', label);
}

async function startRecording() {
  if (state.rec !== 'idle') return;
  setRec('starting');

  const prep = await api.prepareRecording();
  if (!prep.ok) {
    toast(t('errScreen'), 'error');
    setRec('idle');
    return false;
  }

  const hi = state.settings.quality !== '720';
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { max: hi ? 1920 : 1280 },
        height: { max: hi ? 1080 : 720 }
      },
      audio: false
    });
  } catch (err) {
    console.error('screen', err);
    toast(t('errScreen'), 'error');
    checkPermissions();
    setRec('idle');
    return false;
  }

  try {
    const micId = state.settings.micId;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micId && micId !== 'default' ? { exact: micId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
  } catch (err) {
    console.error('mic', err);
    stopTracks();
    toast(t('errMic'), 'error');
    checkPermissions();
    setRec('idle');
    return false;
  }

  const combined = new MediaStream([...screenStream.getVideoTracks(), ...micStream.getAudioTracks()]);
  mimeType = pickMime();
  try {
    recorder = new MediaRecorder(combined, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: hi ? 2_500_000 : 1_200_000,
      audioBitsPerSecond: 96_000
    });
  } catch (err) {
    console.error('recorder', err);
    mimeType = '';
    recorder = new MediaRecorder(combined);
  }
  chunks = [];
  discardNext = false;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecorderStop;

  // If the screen share ends on its own (display unplugged etc.), save what we have.
  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.rec === 'recording') stopRecording(true);
  });

  recorder.start(1000);
  startedAt = Date.now();
  startLevels();
  setRec('recording');
  api.setRecordingState({ state: 'recording', startedAt });
  return true;
}

function stopRecording(save = true) {
  if (state.rec !== 'recording' || !recorder) return;
  discardNext = !save;
  setRec('saving');
  stopLevels();
  api.setRecordingState({ state: 'idle' });
  try { recorder.stop(); } catch { onRecorderStop(); }
}

function stopTracks() {
  [screenStream, micStream].forEach((s) => s && s.getTracks().forEach((tr) => tr.stop()));
  screenStream = null;
  micStream = null;
}

async function onRecorderStop() {
  const durationMs = Date.now() - startedAt;
  stopTracks();
  const type = (recorder && recorder.mimeType) || mimeType || 'video/webm';
  recorder = null;

  if (discardNext || !chunks.length) {
    chunks = [];
    setRec('idle');
    if (discardNext) toast(t('discarded'));
    return;
  }

  const isMp4 = type.includes('mp4');
  let blob = new Blob(chunks, { type: type.split(';')[0] });
  chunks = [];
  if (!isMp4 && window.ysFixWebmDuration) {
    try { blob = await window.ysFixWebmDuration(blob, durationMs, { logger: false }); } catch { /* keep original */ }
  }

  const title = $('studentInput').value.trim();
  try {
    const thumb = await makeThumb(blob);
    const buffer = await blob.arrayBuffer();
    const clip = await api.saveClip({
      buffer,
      ext: isMp4 ? '.mp4' : '.webm',
      title,
      duration: durationMs / 1000,
      thumb
    });
    $('studentInput').value = '';
    state.freshId = clip.id;
    await loadClips();
    toast(t('saved', { name: clip.title || t('untitled') }));
  } catch (err) {
    console.error('save', err);
    toast(t('errSave'), 'error');
  }
  setRec('idle');
}

function makeThumb(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(val);
    };
    const grab = () => {
      try {
        const w = 480;
        const h = Math.round(w * (v.videoHeight / v.videoWidth || 9 / 16));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        finish(c.toDataURL('image/jpeg', 0.78));
      } catch {
        finish(null);
      }
    };
    v.addEventListener('loadeddata', () => {
      v.addEventListener('seeked', grab, { once: true });
      try { v.currentTime = 0.4; } catch { grab(); }
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    setTimeout(() => finish(null), 4000);
    v.src = url;
  });
}

function startLevels() {
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(micStream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    levelTimer = setInterval(() => {
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128;
        sum += x * x;
      }
      api.sendLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
    }, 90);
  } catch { /* level meter is optional */ }
}
function stopLevels() {
  clearInterval(levelTimer);
  levelTimer = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

function toggleRecording() {
  if (state.rec === 'idle') startRecording();
  else if (state.rec === 'recording') stopRecording(true);
}

// ---------- clips ----------
async function loadClips() {
  state.clips = await api.listClips();
  renderClips();
}

function renderClips() {
  if (!state.settings) return;
  const list = $('clipList');
  const q = state.query.trim().toLowerCase();
  const shown = q ? state.clips.filter((c) => (c.title || '').toLowerCase().includes(q) || c.fileName.toLowerCase().includes(q)) : state.clips;

  $('clipCount').textContent = T().count(state.clips.length);
  $('emptyState').hidden = state.clips.length > 0;
  $('dragHint').hidden = state.clips.length === 0;
  $('noResults').hidden = !(state.clips.length && !shown.length);
  list.hidden = shown.length === 0;
  list.innerHTML = '';

  for (const c of shown) {
    const li = document.createElement('li');
    li.className = 'clip' + (c.id === state.freshId ? ' fresh' : '');
    li.draggable = true;
    li.dataset.id = c.id;

    const thumbBtn = document.createElement('button');
    thumbBtn.className = 'thumb';
    thumbBtn.type = 'button';
    thumbBtn.title = t('play');
    thumbBtn.setAttribute('aria-label', `${t('play')}: ${c.title || t('untitled')}`);
    if (c.thumbUrl) {
      const img = document.createElement('img');
      img.src = c.thumbUrl;
      img.alt = '';
      img.draggable = false;
      thumbBtn.appendChild(img);
    }
    thumbBtn.insertAdjacentHTML('beforeend', `<span class="play-badge">${window.ICONS.play}</span>`);
    const dur = document.createElement('span');
    dur.className = 'duration';
    dur.textContent = fmtDuration(c.duration);
    thumbBtn.appendChild(dur);
    thumbBtn.addEventListener('click', () => openPlayer(c));

    const main = document.createElement('div');
    main.className = 'clip-main';
    const title = document.createElement('div');
    title.className = 'clip-title' + (c.title ? '' : ' untitled');
    title.textContent = c.title || t('untitled');
    title.addEventListener('dblclick', () => startRename(c, main, title));
    const meta = document.createElement('div');
    meta.className = 'clip-meta';
    for (const part of [fmtWhen(c.createdAt), fmtSize(c.size)]) {
      if (!part) continue;
      const sp = document.createElement('span');
      sp.textContent = part;
      meta.appendChild(sp);
    }
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'clip-actions';
    const mk = (icon, label, fn, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `icon-btn ${cls}`;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = window.ICONS[icon];
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    actions.append(
      mk('pencil', t('rename'), () => startRename(c, main, title)),
      mk('folder', t('reveal'), () => api.revealClip(c.id)),
      mk('trash', t('remove'), () => confirmDelete(c), 'del')
    );

    li.append(thumbBtn, main, actions);
    li.addEventListener('dragstart', (e) => {
      e.preventDefault();
      api.dragClip(c.id);
    });
    list.appendChild(li);
  }

  if (state.freshId) {
    const fresh = state.freshId;
    setTimeout(() => { if (state.freshId === fresh) state.freshId = null; }, 4000);
  }
}

function startRename(c, main, titleEl) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = c.title || '';
  input.maxLength = 70;
  input.placeholder = t('studentPlaceholder');
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  const li = main.closest('.clip');
  li.draggable = false;
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save && input.value.trim() !== (c.title || '')) {
      await api.renameClip(c.id, input.value.trim());
      await loadClips();
      toast(t('renamed'));
    } else {
      renderClips();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function confirmDelete(c) {
  const dlg = $('confirmDlg');
  $('confirmText').textContent = t('deleteConfirm', { name: c.title || t('untitled') });
  const yes = $('confirmYes');
  const no = $('confirmNo');
  const close = () => { dlg.close(); yes.onclick = null; no.onclick = null; };
  yes.onclick = async () => {
    close();
    await api.deleteClip(c.id);
    await loadClips();
    toast(t('deleted'));
  };
  no.onclick = close;
  dlg.showModal();
  no.focus();
}

function openPlayer(c) {
  const dlg = $('player');
  const v = $('playerVideo');
  $('playerTitle').textContent = c.title || t('untitled');
  v.src = c.fileUrl;
  dlg.showModal();
  v.play().catch(() => {});
}
$('playerClose').addEventListener('click', () => $('player').close());
$('player').addEventListener('close', () => {
  const v = $('playerVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
});

// ---------- permissions ----------
async function checkPermissions() {
  const st = await api.permissionStatus();
  const banner = $('permBanner');
  if (st.screen !== 'granted' && st.screen !== 'not-determined') {
    $('permTitle').textContent = t('permScreenTitle');
    $('permBody').textContent = t('permScreenBody');
    $('permRelaunch').hidden = false;
    $('permOpen').onclick = () => api.openPermissionSettings('screen');
    banner.hidden = false;
  } else if (st.microphone === 'denied' || st.microphone === 'restricted') {
    $('permTitle').textContent = t('permMicTitle');
    $('permBody').textContent = t('permMicBody');
    $('permRelaunch').hidden = true;
    $('permOpen').onclick = () => api.openPermissionSettings('microphone');
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  if (st.microphone === 'not-determined') api.requestMic();
}
$('permRelaunch').addEventListener('click', () => api.relaunch());

// ---------- settings ----------
let meterStream = null;
let meterCtx = null;
let meterRaf = 0;

async function openSettings() {
  const s = state.settings;
  $('hideToggle').checked = !!s.hideWhileRecording;
  $('showAfterToggle').checked = !!s.showAfterRecording;
  $('qualitySelect').value = s.quality;
  $('saveDirText').textContent = s.saveDir;
  $('saveDirText').title = s.saveDir;
  $('versionText').textContent = t('sVersion', { v: state.version });
  $('hotkeyHelp').className = 's-help';
  $('hotkeyHelp').textContent = t('sHotkeyHelp');
  applyTheme();
  $('settingsDlg').showModal();
  await Promise.all([fillMics(), fillScreens()]);
  startMeter();
}

function closeSettings() {
  stopMeter();
  stopHotkeyCapture();
  $('settingsDlg').close();
}

async function fillMics() {
  const sel = $('micSelect');
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* none */ }
  sel.innerHTML = '';
  const def = new Option(t('sMicDefault'), 'default');
  sel.appendChild(def);
  devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d, i) => {
    sel.appendChild(new Option(d.label || `Microphone ${i + 1}`, d.deviceId));
  });
  sel.value = [...sel.options].some((o) => o.value === state.settings.micId) ? state.settings.micId : 'default';
}

async function fillScreens() {
  const box = $('screenList');
  box.innerHTML = '';
  const mkOpt = (id, label, thumb, auto = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'screen-opt' + (auto ? ' auto' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.settings.screenId === id));
    if (auto) {
      b.innerHTML = window.ICONS.monitor;
    } else if (thumb) {
      const img = document.createElement('img');
      img.src = thumb;
      img.alt = '';
      b.appendChild(img);
    }
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', async () => {
      await saveSetting({ screenId: id });
      box.querySelectorAll('.screen-opt').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    box.appendChild(b);
  };
  mkOpt('auto', t('sScreenAuto'), null, true);
  try {
    const screens = await api.listScreens();
    if (screens.length > 1) screens.forEach((s) => mkOpt(s.id, s.name, s.thumb));
  } catch { /* only auto */ }
}

async function startMeter() {
  stopMeter();
  try {
    const id = $('micSelect').value;
    meterStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id !== 'default' ? { exact: id } : undefined } });
    meterCtx = new AudioContext();
    const an = meterCtx.createAnalyser();
    an.fftSize = 512;
    meterCtx.createMediaStreamSource(meterStream).connect(an);
    const data = new Uint8Array(an.fftSize);
    const tick = () => {
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const x = (data[i] - 128) / 128; sum += x * x; }
      $('micMeter').style.width = `${Math.min(100, Math.sqrt(sum / data.length) * 400)}%`;
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* no mic access */ }
}
function stopMeter() {
  cancelAnimationFrame(meterRaf);
  if (meterStream) meterStream.getTracks().forEach((tr) => tr.stop());
  if (meterCtx) meterCtx.close().catch(() => {});
  meterStream = null;
  meterCtx = null;
  $('micMeter').style.width = '0';
}

async function saveSetting(patch) {
  const res = await api.setSettings(patch);
  state.settings = res.settings;
  return res;
}

// Hotkey capture
let capturing = false;
function keyToAccel(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.metaKey) mods.push('Command');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const k = e.key;
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(k)) return null;
  let key = null;
  if (/^F\d{1,2}$/.test(k)) key = k;
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (k === ' ') key = 'Space';
  else if (['Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Pause'].includes(k)) key = k;
  if (!key) return null;
  // Plain letters/numbers would block typing everywhere, so require a modifier for them.
  if (!/^F\d/.test(key) && !['Insert', 'Pause', 'Home', 'End', 'PageUp', 'PageDown'].includes(key) && !mods.length) return null;
  return [...mods, key].join('+');
}
function onCaptureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { stopHotkeyCapture(); return; }
  const accel = keyToAccel(e);
  if (!accel) return;
  stopHotkeyCapture();
  saveSetting({ hotkey: accel }).then((res) => {
    const help = $('hotkeyHelp');
    if (res.hotkeyOk) {
      help.className = 's-help ok';
      help.textContent = t('sHotkeySaved', { key: hotkeyLabel(accel) });
    } else {
      help.className = 's-help error';
      help.textContent = t('sHotkeyTaken');
    }
    applyLanguage();
  });
}
function startHotkeyCapture() {
  capturing = true;
  $('hotkeyShow').parentElement.classList.add('listening');
  $('hotkeyShow').textContent = '…';
  $('hotkeyHelp').className = 's-help';
  $('hotkeyHelp').textContent = t('sHotkeyListening');
  window.addEventListener('keydown', onCaptureKey, true);
}
function stopHotkeyCapture() {
  if (!capturing) return;
  capturing = false;
  window.removeEventListener('keydown', onCaptureKey, true);
  $('hotkeyShow').parentElement.classList.remove('listening');
  $('hotkeyShow').textContent = hotkeyLabel();
}

// ---------- wiring ----------
function wire() {
  $('recBtn').addEventListener('click', () => {
    if (state.rec === 'idle') startRecording();
    else if (state.rec === 'recording') stopRecording(true);
  });
  $('studentInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.rec === 'idle') startRecording();
  });
  $('langBtn').addEventListener('click', async () => {
    await saveSetting({ language: state.settings.language === 'ar' ? 'en' : 'ar' });
    applyLanguage();
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsDlg').addEventListener('cancel', (e) => {
    if (capturing) { e.preventDefault(); stopHotkeyCapture(); return; }
    stopMeter();
  });
  $('settingsDlg').addEventListener('close', stopMeter);
  $('settingsDlg').addEventListener('click', (e) => { if (e.target === $('settingsDlg')) closeSettings(); });
  $('player').addEventListener('click', (e) => { if (e.target === $('player')) $('player').close(); });

  $('hotkeyChange').addEventListener('click', () => (capturing ? stopHotkeyCapture() : startHotkeyCapture()));
  $('micSelect').addEventListener('change', async (e) => { await saveSetting({ micId: e.target.value }); startMeter(); });
  $('qualitySelect').addEventListener('change', (e) => saveSetting({ quality: e.target.value }));
  $('hideToggle').addEventListener('change', (e) => saveSetting({ hideWhileRecording: e.target.checked }));
  $('showAfterToggle').addEventListener('change', (e) => saveSetting({ showAfterRecording: e.target.checked }));
  $('saveDirChange').addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (dir) {
      state.settings.saveDir = dir;
      $('saveDirText').textContent = dir;
      $('saveDirText').title = dir;
    }
  });
  $('themeSeg').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-theme-val]');
    if (!b) return;
    await saveSetting({ theme: b.dataset.themeVal });
    applyTheme();
  });

  $('openFolderBtn').addEventListener('click', () => api.openFolder());
  $('searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderClips(); });

  api.onCommand(async (cmd) => {
    if (cmd === 'toggle') toggleRecording();
    else if (cmd === 'stop') stopRecording(true);
    else if (cmd === 'discard') stopRecording(false);
    else if (cmd === 'selftest') {
      const ok = await startRecording();
      if (!ok) { api.selftestFailed('could not start'); return; }
      setTimeout(() => stopRecording(true), 3000);
    }
  });

  window.addEventListener('focus', () => { if (state.rec === 'idle') loadClips(); });
}

async function init() {
  const info = await api.getSettings();
  state.settings = info.settings;
  state.platform = info.platform;
  state.version = info.version;
  if (info.platform === 'darwin') document.body.classList.add('mac');
  mountIcons();
  applyTheme();
  applyLanguage();
  wire();
  await loadClips();
  checkPermissions();
}

init();
