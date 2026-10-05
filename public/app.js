'use strict';

const $ = (id) => document.getElementById(id);
const views = ['loginView', 'lobbyView', 'gameView'];
function show(view) { for (const v of views) $(v).hidden = v !== view; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function setFace(el, skinUrl) {
  el.style.backgroundImage = skinUrl ? `url("${skinUrl}")` : '';
}

function showError(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ------------------------------------------------------------------ boot

let me = null;

async function boot() {
  const params = new URLSearchParams(location.search);
  const loginError = params.get('error');
  if (loginError) history.replaceState(null, '', '/');

  try {
    me = await api('/api/me');
  } catch {
    showError($('loginError'), loginError);
    show('loginView');
    return;
  }
  $('user').hidden = false;
  $('userName').textContent = me.name;
  $('lobbyName').textContent = me.name;
  setFace($('userFace'), me.skinUrl);
  setFace($('lobbyFace'), me.skinUrl);
  show('lobbyView');
  loadVersions();
  pollGame();
}

$('logoutBtn').onclick = async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
};

// ------------------------------------------------------------------ lobby

async function loadVersions() {
  const select = $('versionSelect');
  try {
    const { latest, versions } = await api('/api/versions');
    select.innerHTML = '';
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v === latest ? `${v} (latest)` : v;
      select.appendChild(opt);
    }
    const saved = localStorage.getItem('mcweb.version');
    select.value = versions.includes(saved) ? saved : latest;
    $('playBtn').disabled = false;
  } catch (err) {
    showError($('lobbyError'), err.message);
  }
}

$('playBtn').onclick = async () => {
  const version = $('versionSelect').value;
  try { localStorage.setItem('mcweb.version', version); } catch { /* private mode */ }
  showError($('lobbyError'), '');
  $('playBtn').disabled = true;
  try {
    renderStatus(await api('/api/play', { method: 'POST', body: JSON.stringify({ version }) }));
    pollGame();
  } catch (err) {
    showError($('lobbyError'), err.message);
    $('playBtn').disabled = false;
  }
};

$('cancelBtn').onclick = () => api('/api/stop', { method: 'POST' }).then(pollGame);

const STAGE_TEXT = {
  preparing: 'Preparing',
  starting: 'Starting',
  stopping: 'Saving and shutting down',
};

function renderStatus(s) {
  const box = $('statusBox');
  const busy = ['preparing', 'starting', 'stopping'].includes(s.state);
  box.hidden = !busy;
  $('playBtn').disabled = busy || $('versionSelect').options.length === 0;
  $('cancelBtn').hidden = s.state === 'stopping';
  if (s.state === 'error') showError($('lobbyError'), s.error);
  if (!busy) return;

  const p = s.progress || {};
  $('statusText').textContent = p.stage || STAGE_TEXT[s.state];
  const bar = $('statusBar').parentElement;
  if (p.total) {
    bar.classList.remove('indeterminate');
    $('statusBar').style.width = `${Math.round((100 * p.done) / p.total)}%`;
    $('statusCount').textContent = `${p.done} / ${p.total}`;
  } else {
    bar.classList.add('indeterminate');
    $('statusBar').style.width = '';
    $('statusCount').textContent = '';
  }
  const log = $('logBox');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = (s.logs || []).join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

let pollTimer = null;
async function pollGame() {
  clearTimeout(pollTimer);
  let s;
  try {
    s = await api('/api/game');
  } catch (err) {
    if (err.status === 401) return location.reload();
    pollTimer = setTimeout(pollGame, 3000);
    return;
  }
  if (s.state === 'running') return enterGame(s);
  renderStatus(s);
  if (['preparing', 'starting', 'stopping'].includes(s.state)) pollTimer = setTimeout(pollGame, 1000);
}

// ------------------------------------------------------------------ game

const stage = $('stage');
const canvas = $('screen');
const overlay = $('overlay');
let player = null;
let inputWs = null;
let game = null;
let lastEscDown = 0;

function wsUrl(path) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

function send(msg) {
  if (inputWs && inputWs.readyState === 1) inputWs.send(JSON.stringify(msg));
}

function enterGame(status) {
  game = status;
  show('gameView');
  canvas.width = status.width;
  canvas.height = status.height;
  $('gameInfo').textContent = `Minecraft ${status.version}${status.audio ? '' : ' · no audio'}`;
  overlay.hidden = false;

  player = new JSMpeg.Player(wsUrl('/ws/video'), {
    canvas,
    audio: !!status.audio,
    videoBufferSize: 2 * 1024 * 1024,
    audioBufferSize: 256 * 1024,
    pauseWhenHidden: false,
    progressive: false,
    reconnectInterval: 0,
    autoplay: true,
  });
  const source = player.source;
  const origClose = source.onClose?.bind(source);
  if (source.socket) source.socket.addEventListener('close', onVideoClosed);
  else source.onClose = (...a) => { origClose?.(...a); onVideoClosed(); };

  inputWs = new WebSocket(wsUrl('/ws/input'));
}

function onVideoClosed() {
  if (!game) return;
  leaveGame();
}

function leaveGame() {
  game = null;
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { player?.destroy(); } catch { /* already closed */ }
  player = null;
  inputWs?.close();
  inputWs = null;
  show('lobbyView');
  pollGame();
}

$('stopBtn').onclick = async () => {
  await api('/api/stop', { method: 'POST' }).catch(() => {});
  leaveGame();
};

$('fullscreenBtn').onclick = async () => {
  try {
    await stage.requestFullscreen();
    // Lets Esc and browser shortcuts reach the game while fullscreen (Chromium)
    await navigator.keyboard?.lock?.();
  } catch { /* not supported */ }
};

async function capture() {
  if (!game) return;
  player?.audioOut?.unlock?.(() => {});
  send(['f']);
  try {
    await stage.requestPointerLock({ unadjustedMovement: true });
  } catch {
    try { await stage.requestPointerLock(); } catch { /* user must click again */ }
  }
}
overlay.addEventListener('click', capture);
stage.addEventListener('click', () => { if (document.pointerLockElement !== stage) capture(); });

const locked = () => document.pointerLockElement === stage;

document.addEventListener('pointerlockchange', () => {
  overlay.hidden = locked();
  if (!game) return;
  if (locked()) {
    stage.focus();
  } else {
    send(['r']);
    // The browser swallows the Esc that released the mouse; pass it on so the
    // game opens its pause menu (unless the game already received it).
    if (performance.now() - lastEscDown > 300) {
      send(['k', 'Escape', 1]);
      send(['k', 'Escape', 0]);
    }
  }
});

// Mouse motion is batched to one message per animation frame and scaled from
// screen pixels to game pixels so the in-game cursor tracks naturally.
let dx = 0;
let dy = 0;
let rafPending = false;
document.addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  dx += e.movementX * scale;
  dy += e.movementY * scale;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const ix = Math.trunc(dx);
      const iy = Math.trunc(dy);
      if (ix || iy) send(['m', ix, iy]);
      dx -= ix;
      dy -= iy;
    });
  }
});

document.addEventListener('mousedown', (e) => { if (locked()) { e.preventDefault(); send(['b', e.button, 1]); } });
document.addEventListener('mouseup', (e) => { if (locked()) { e.preventDefault(); send(['b', e.button, 0]); } });
stage.addEventListener('contextmenu', (e) => e.preventDefault());

let wheelAcc = 0;
document.addEventListener('wheel', (e) => {
  if (!locked()) return;
  e.preventDefault();
  wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const steps = Math.trunc(wheelAcc / 40);
  if (steps) {
    send(['w', steps]);
    wheelAcc -= steps * 40;
  }
}, { passive: false });

function onKey(e, down) {
  if (!game || !locked()) return;
  if (e.code === 'Escape' && down) lastEscDown = performance.now();
  e.preventDefault();
  if (down && e.repeat) return; // the X server generates its own key repeat
  send(['k', e.code, down ? 1 : 0]);
}
document.addEventListener('keydown', (e) => onKey(e, true));
document.addEventListener('keyup', (e) => onKey(e, false));
window.addEventListener('blur', () => send(['r']));

boot();
