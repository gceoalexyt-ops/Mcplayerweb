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
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
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
  } catch (err) {
    loginMode = err.data?.loginMode || 'device';
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

// ------------------------------------------------------------------ sign-in

let loginMode = 'device';
let devicePoll = null;

function stopDeviceLogin() {
  clearTimeout(devicePoll);
  devicePoll = null;
  $('deviceBox').hidden = true;
  $('loginBtn').hidden = false;
}

// Without an Azure app the server uses Microsoft's device code sign-in: show
// the code, let the player enter it at microsoft.com/link, and poll until done.
$('loginBtn').onclick = async (e) => {
  if (loginMode !== 'device') return; // plain link to the redirect flow
  e.preventDefault();
  showError($('loginError'), '');
  $('loginBtn').hidden = true;
  try {
    const d = await api('/auth/device/start', { method: 'POST' });
    $('deviceCode').textContent = d.userCode;
    $('deviceLink').href = d.verificationUri;
    $('deviceLink').textContent = d.verificationUri.replace(/^https?:\/\/(www\.)?/, '');
    $('deviceStatus').textContent = 'Waiting for you to finish signing in…';
    $('deviceBox').hidden = false;
    const poll = async () => {
      try {
        const r = await api('/auth/device/poll', { method: 'POST' });
        if (r.ok) {
          $('deviceStatus').textContent = 'Signed in!';
          location.href = '/';
          return;
        }
        devicePoll = setTimeout(poll, d.interval * 1000);
      } catch (err) {
        stopDeviceLogin();
        showError($('loginError'), err.message);
      }
    };
    devicePoll = setTimeout(poll, d.interval * 1000);
  } catch (err) {
    stopDeviceLogin();
    showError($('loginError'), err.message);
  }
};

$('deviceCancelBtn').onclick = stopDeviceLogin;

$('copyCodeBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('deviceCode').textContent);
    $('copyCodeBtn').textContent = 'Copied';
    setTimeout(() => { $('copyCodeBtn').textContent = 'Copy'; }, 1500);
  } catch { /* clipboard blocked: the code is still on screen */ }
};

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
  rejoinByHand = false;
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
  if (s.state === 'running') {
    if (!rejoinByHand) return enterGame(s);
    renderStatus(s);
    return;
  }
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

  // Say what the video is doing until the first picture arrives, so a black
  // screen always comes with a reason
  let firstFrame = false;
  setVideoStatus('Connecting to the game…');
  clearTimeout(videoTimer);
  videoTimer = setTimeout(() => {
    if (!firstFrame && game) setVideoStatus(`${$('videoStatus').textContent} (still waiting after 20 s)`);
  }, 20000);

  player = new JSMpeg.Player(wsUrl('/ws/video'), {
    canvas,
    onSourceEstablished: () => { if (!firstFrame) setVideoStatus('Receiving video, waiting for the first picture…'); },
    onVideoDecode: () => {
      if (firstFrame) return;
      firstFrame = true;
      clearTimeout(videoTimer);
      setVideoStatus('');
    },
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
  else source.onClose = (...a) => { origClose?.(...a); onVideoClosed(a[0]); };

  inputWs = new WebSocket(wsUrl('/ws/input'));
  inputWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (typeof msg.captured === 'boolean') setCaptured(msg.captured);
  };
  // Phones and tablets have no Pointer Lock and no keyboard: use touch controls
  if (prefersTouch()) enableTouch();
}

let videoTimer = null;
let rejoinByHand = false;

function setVideoStatus(text) {
  $('videoStatus').textContent = text;
  $('videoStatus').hidden = !text;
}

function onVideoClosed(ev) {
  if (!game) return;
  leaveGame();
  // 4000/4001 are our own "opened elsewhere" / "game ended" closes
  if (ev && ev.code !== 4000 && ev.code !== 4001) {
    rejoinByHand = true; // don't loop straight back into a broken stream
    showError($('lobbyError'), `The video connection closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}). Press Play to reconnect.`);
  }
}

function leaveGame() {
  game = null;
  clearTimeout(videoTimer);
  setVideoStatus('');
  disableTouch();
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
  if (!game || touchMode) return;
  player?.audioOut?.unlock?.(() => {});
  send(['f']);
  try {
    await stage.requestPointerLock({ unadjustedMovement: true });
  } catch {
    try { await stage.requestPointerLock(); } catch { /* user must click again */ }
  }
}
overlay.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch' || !hasPointerLock) enableTouch(); });
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
  if (!game || !(locked() || touchMode)) return;
  if (e.target === tcInput) {
    // Text from the on-screen keyboard arrives as 'input' events; only Enter comes as a key
    if (e.key === 'Enter') { e.preventDefault(); if (down) tapKey('Enter'); }
    return;
  }
  if (e.code === 'Escape' && down) lastEscDown = performance.now();
  e.preventDefault();
  if (down && e.repeat) return; // the X server generates its own key repeat
  send(['k', e.code, down ? 1 : 0]);
}
document.addEventListener('keydown', (e) => onKey(e, true));
document.addEventListener('keyup', (e) => onKey(e, false));
window.addEventListener('blur', () => send(['r']));

// ------------------------------------------------------------------ touch

const touchLayer = $('touch');
const tcInput = $('tcInput');
const hasPointerLock = 'requestPointerLock' in Element.prototype;
let touchMode = false;
let captured = false;

function prefersTouch() {
  return !hasPointerLock || (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
}

function enableTouch() {
  if (!game || touchMode) return;
  touchMode = true;
  document.body.classList.add('touch-mode');
  touchLayer.hidden = false;
  overlay.hidden = true;
  $('tcFullscreen').hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  send(['f']);
}

function disableTouch() {
  if (!touchMode) return;
  endGestures();
  setStick(0, 0);
  for (const el of touchLayer.querySelectorAll('.on')) el.classList.remove('on');
  touchMode = false;
  document.body.classList.remove('touch-mode');
  touchLayer.hidden = true;
  tcInput.blur();
}

function setCaptured(value) {
  if (captured === value) return;
  captured = value;
  touchLayer.classList.toggle('captured', value);
  // Switching between menu and game mid-gesture: let go of everything
  endGestures();
  if (!value) setStick(0, 0);
}

function tapKey(code, shift = false) {
  if (shift) send(['k', 'ShiftLeft', 1]);
  send(['k', code, 1]);
  send(['k', code, 0]);
  if (shift) send(['k', 'ShiftLeft', 0]);
}

// Browser coordinates -> game pixels, allowing for the letterboxing of object-fit: contain
function toGame(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
  const left = r.left + (r.width - canvas.width * scale) / 2;
  const top = r.top + (r.height - canvas.height * scale) / 2;
  return { x: (clientX - left) / scale, y: (clientY - top) / scale, scale };
}

// Touches on the picture itself. In menus they act like a mouse at the finger;
// while playing, dragging looks around, a tap uses/places, and holding still breaks.
const gestures = new Map();
const LOOK_SPEED = 1.3;

function endGestures() {
  for (const g of gestures.values()) {
    clearTimeout(g.holdTimer);
    if (g.button !== null) send(['b', g.button, 0]);
  }
  gestures.clear();
}

touchLayer.addEventListener('pointerdown', (e) => {
  if (!touchMode || e.target !== touchLayer) return;
  e.preventDefault();
  touchLayer.setPointerCapture(e.pointerId);
  player?.audioOut?.unlock?.(() => {});
  const g = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t: performance.now(), moved: false, button: null, holdTimer: null, menu: !captured };
  gestures.set(e.pointerId, g);
  if (g.menu) {
    const p = toGame(e.clientX, e.clientY);
    send(['a', p.x, p.y]);
    send(['b', 0, 1]);
    g.button = 0;
  } else {
    g.holdTimer = setTimeout(() => {
      if (g.moved || !gestures.has(e.pointerId)) return;
      g.button = 0; // hold still to break blocks
      send(['b', 0, 1]);
      navigator.vibrate?.(15);
    }, 300);
  }
});

touchLayer.addEventListener('pointermove', (e) => {
  const g = gestures.get(e.pointerId);
  if (!g) return;
  e.preventDefault();
  if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 10) g.moved = true;
  if (g.menu) {
    const p = toGame(e.clientX, e.clientY);
    send(['a', p.x, p.y]);
  } else {
    const { scale } = toGame(0, 0);
    const dx = Math.round(((e.clientX - g.x) / scale) * LOOK_SPEED);
    const dy = Math.round(((e.clientY - g.y) / scale) * LOOK_SPEED);
    if (dx || dy) {
      send(['m', dx, dy]);
      g.x += (dx / LOOK_SPEED) * scale;
      g.y += (dy / LOOK_SPEED) * scale;
    }
  }
});

function endGesture(e) {
  const g = gestures.get(e.pointerId);
  if (!g) return;
  gestures.delete(e.pointerId);
  clearTimeout(g.holdTimer);
  if (g.menu) {
    const p = toGame(e.clientX, e.clientY);
    send(['a', p.x, p.y]);
  }
  if (g.button !== null) {
    send(['b', g.button, 0]);
  } else if (!g.moved && e.type === 'pointerup' && performance.now() - g.t < 300) {
    send(['b', 2, 1]); // quick tap while playing: use / place
    send(['b', 2, 0]);
  }
}
touchLayer.addEventListener('pointerup', endGesture);
touchLayer.addEventListener('pointercancel', endGesture);

// Buttons: data-key holds a key, data-mouse holds a mouse button,
// data-toggle latches a key (sneak), data-wheel scrolls the hotbar.
function bindHold(el, down, up) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    player?.audioOut?.unlock?.(() => {});
    down();
  });
  const release = (e) => { e.preventDefault(); up(); };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

for (const el of touchLayer.querySelectorAll('[data-key]')) {
  const code = el.dataset.key;
  bindHold(el, () => { el.classList.add('on'); send(['k', code, 1]); }, () => { el.classList.remove('on'); send(['k', code, 0]); });
}
for (const el of touchLayer.querySelectorAll('[data-mouse]')) {
  const button = Number(el.dataset.mouse);
  bindHold(el, () => { el.classList.add('on'); send(['b', button, 1]); }, () => { el.classList.remove('on'); send(['b', button, 0]); });
}
for (const el of touchLayer.querySelectorAll('[data-wheel]')) {
  const steps = Number(el.dataset.wheel);
  bindHold(el, () => send(['w', steps]), () => {});
}
for (const el of touchLayer.querySelectorAll('[data-toggle]')) {
  const code = el.dataset.toggle;
  bindHold(el, () => {
    const on = el.classList.toggle('on');
    send(['k', code, on ? 1 : 0]);
  }, () => {});
}

// Joystick -> WASD, pushing it all the way forward also sprints
const stick = $('tcStick');
const knob = $('tcKnob');
const stickKeys = new Set();
let stickPointer = null;

function setStick(nx, ny) {
  knob.style.transform = `translate(${nx * 37}px, ${ny * 37}px)`;
  const want = new Set();
  if (ny < -0.35) want.add('KeyW');
  if (ny > 0.35) want.add('KeyS');
  if (nx < -0.35) want.add('KeyA');
  if (nx > 0.35) want.add('KeyD');
  if (ny < -0.9) want.add('ControlLeft');
  for (const k of stickKeys) if (!want.has(k)) { send(['k', k, 0]); stickKeys.delete(k); }
  for (const k of want) if (!stickKeys.has(k)) { send(['k', k, 1]); stickKeys.add(k); }
}

function stickMove(e) {
  const r = stick.getBoundingClientRect();
  let nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  let ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  const len = Math.hypot(nx, ny);
  if (len > 1) { nx /= len; ny /= len; }
  setStick(nx, ny);
}
stick.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  stick.setPointerCapture(e.pointerId);
  stickPointer = e.pointerId;
  stickMove(e);
});
stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickPointer) stickMove(e); });
const stickEnd = (e) => { if (e.pointerId === stickPointer) { stickPointer = null; setStick(0, 0); } };
stick.addEventListener('pointerup', stickEnd);
stick.addEventListener('pointercancel', stickEnd);

// The phone's own keyboard: focus a hidden text field and forward what's typed.
// The field always holds one space so a backspace on it is still noticed.
const SHIFTED = { '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', _: 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash', '~': 'Backquote' };
const PLAIN = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' };

function typeChar(ch) {
  if (/^[a-z]$/.test(ch)) return tapKey(`Key${ch.toUpperCase()}`);
  if (/^[A-Z]$/.test(ch)) return tapKey(`Key${ch}`, true);
  if (/^[0-9]$/.test(ch)) return tapKey(`Digit${ch}`);
  if (PLAIN[ch]) return tapKey(PLAIN[ch]);
  if (SHIFTED[ch]) return tapKey(SHIFTED[ch], true);
  if (ch === '\n') return tapKey('Enter');
}

function resetInput() {
  tcInput.value = ' ';
  try { tcInput.setSelectionRange(1, 1); } catch { /* not focused */ }
}

tcInput.addEventListener('input', () => {
  const v = tcInput.value;
  if (v.length === 0) tapKey('Backspace');
  else for (const ch of v.slice(1)) typeChar(ch);
  resetInput();
});

function openKeyboard() {
  resetInput();
  tcInput.focus();
}
$('tcKeyboard').addEventListener('click', openKeyboard);
$('tcChat').addEventListener('click', () => { tapKey('KeyT'); openKeyboard(); });
for (const id of ['tcKeyboard', 'tcChat', 'tcFullscreen', 'tcQuit']) {
  $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
}

$('tcFullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await stage.requestFullscreen();
      await screen.orientation?.lock?.('landscape').catch(() => {});
    }
  } catch { /* not supported */ }
});

$('tcQuit').addEventListener('click', () => {
  if (confirm('Save and quit the game?')) $('stopBtn').click();
});

boot();
