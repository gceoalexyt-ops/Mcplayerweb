'use strict';

// One PlayerSession = one running copy of Minecraft on its own virtual display
// (Xvfb), with optional PulseAudio for sound, streamed to the browser by ffmpeg.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { config } = require('./config');
const launcher = require('./launcher');
const { ensureFreshToken } = require('./auth');
const { X11Input } = require('./x11input');

const hasPulse = config.audio && spawnSync('sh', ['-c', 'command -v pulseaudio'], { stdio: 'ignore' }).status === 0;

// Sensible first-run settings for a streamed, software-rendered game. Only
// written when the player has no options.txt yet; in-game changes are kept.
// Keys a version doesn't know are ignored, so old and new names are both set.
const DEFAULT_OPTIONS = [
  'rawMouseInput:false',
  'pauseOnLostFocus:false',
  'fullscreen:false',
  'enableVsync:false',
  'maxFps:60',
  'inactivityFpsLimit:"minimized"',
  'graphicsMode:0', // 1.19 - 1.21
  'fancyGraphics:false', // before 1.19
  // 26.1+ renders through SDL3, which asks for an sRGB OpenGL framebuffer that
  // Xvfb can't provide; Mesa's software Vulkan driver (lavapipe) works.
  'preferredGraphicsBackend:"vulkan"',
  'onboardAccessibility:false',
  'tutorialStep:none',
  'skipMultiplayerWarning:true',
];

// Settings that matter most for frame rate when the CPU does the rendering.
// Bump OPTIONS_VERSION to apply a changed set once to existing players too;
// anything they change in-game afterwards is kept.
const PERFORMANCE_OPTIONS = [
  'renderDistance:4',
  'simulationDistance:5',
  'graphicsPreset:"fast"', // 26.1+
  'renderClouds:"false"',
  'ao:false',
  'entityShadows:false',
  'biomeBlendRadius:0',
  'mipmapLevels:0',
  'particles:1',
  'entityDistanceScaling:0.75',
];
const OPTIONS_VERSION = 3;

function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

function waitExit(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function waitFor(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

class PlayerSession extends EventEmitter {
  constructor({ account, versionId, displayNum, mods = {} }) {
    super();
    this.account = account;
    this.uuid = account.profile.id;
    this.versionId = versionId;
    this.wantedMods = mods;
    this.mods = null;
    this.displayNum = displayNum;
    this.display = `:${displayNum}`;
    this.runDir = path.join(config.runtimeDir, String(displayNum));
    this.gameDir = path.join(config.dataDir, 'players', this.uuid);
    this.pulseSocket = path.join(this.runDir, 'pulse.sock');
    this.state = 'preparing';
    this.progress = null;
    this.error = null;
    this.logs = [];
    this.procs = {};
    this.input = null;
    this.videoClient = null;
    this.ffmpeg = null;
    this.idleTimer = null;
    this.stopping = false;
  }

  log(line) {
    for (const l of String(line).split('\n')) {
      if (!l.trim()) continue;
      this.logs.push(l.length > 400 ? `${l.slice(0, 400)}…` : l);
      if (this.logs.length > 200) this.logs.shift();
    }
  }

  status() {
    return {
      state: this.state,
      version: this.versionId,
      mods: this.mods,
      progress: this.progress,
      error: this.error,
      audio: hasPulse,
      width: config.screenWidth,
      height: config.screenHeight,
      logs: this.logs.slice(-40),
    };
  }

  spawnLogged(name, cmd, args, opts = {}) {
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    this.procs[name] = child;
    const onData = (d) => this.log(name === 'game' ? d : `[${name}] ${d}`);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => this.log(`[${name}] failed to start: ${err.message}`));
    return child;
  }

  async start() {
    try {
      this.armIdleTimer();
      const plan = await launcher.prepare(this.versionId, this.gameDir, (p) => { this.progress = p; }, this.wantedMods, (line) => this.log(line));
      this.mods = plan.mods?.label || null;
      if (this.mods) this.log(`[launcher] Starting with ${this.mods}`);
      if (this.stopping) return;
      this.progress = { stage: 'Checking your Minecraft session' };
      await ensureFreshToken(this.account);

      await this.writeDefaultOptions();
      await fsp.rm(this.runDir, { recursive: true, force: true });
      await fsp.mkdir(this.runDir, { recursive: true });

      this.state = 'starting';
      this.progress = { stage: 'Starting virtual display' };
      await this.startDisplay();
      if (hasPulse) await this.startAudio().catch((err) => this.log(`[audio] disabled: ${err.message}`));
      if (this.stopping) return;

      this.progress = { stage: 'Launching Minecraft' };
      const { command, args } = launcher.buildCommand(plan, {
        account: this.account,
        gameDir: this.gameDir,
        width: config.screenWidth,
        height: config.screenHeight,
      });
      const game = this.spawnLogged('game', command, args, {
        cwd: this.gameDir,
        env: {
          PATH: process.env.PATH,
          HOME: this.runDir,
          DISPLAY: this.display,
          PULSE_SERVER: `unix:${this.pulseSocket}`,
          ALSOFT_DRIVERS: 'pulse',
          __GL_SYNC_TO_VBLANK: '0',
          vblank_mode: '0',
        },
      });
      game.on('exit', (code, signal) => {
        if (!this.stopping) this.stop(code === 0 ? null : `Minecraft exited (${signal || `code ${code}`}). See the log for details.`);
      });

      this.input = new X11Input(this.display, config.screenWidth, config.screenHeight);
      this.input.onCapturedChange = (captured) => this.emit('captured', captured);
      await this.input.connect();
      await waitFor(() => this.stopping || this.input.gameWindow !== 0, 5 * 60 * 1000, 'the game window');
      if (this.stopping) return;
      this.state = 'running';
      this.progress = null;
      this.emit('running');
    } catch (err) {
      this.log(`[launcher] ${err.stack || err.message}`);
      await this.stop(err.message);
    }
  }

  async writeDefaultOptions() {
    await fsp.mkdir(this.gameDir, { recursive: true });
    const file = path.join(this.gameDir, 'options.txt');
    const marker = path.join(this.gameDir, '.mcweb-options');
    const applied = parseInt(await fsp.readFile(marker, 'utf8').catch(() => '0'), 10) || 0;
    if (applied >= OPTIONS_VERSION && fs.existsSync(file)) return;

    // Set our keys, keep every other line the game wrote
    const existing = fs.existsSync(file) ? (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean) : [];
    const wanted = existing.length ? PERFORMANCE_OPTIONS : [...DEFAULT_OPTIONS, ...PERFORMANCE_OPTIONS];
    const keyOf = (line) => line.slice(0, line.indexOf(':'));
    const wantedKeys = new Set(wanted.map(keyOf));
    const lines = [...existing.filter((l) => !wantedKeys.has(keyOf(l))), ...wanted];
    await fsp.writeFile(file, `${lines.join('\n')}\n`);
    await fsp.writeFile(marker, String(OPTIONS_VERSION));
  }

  async startDisplay() {
    const socket = `/tmp/.X11-unix/X${this.displayNum}`;
    await fsp.rm(socket, { force: true });
    await fsp.rm(`/tmp/.X${this.displayNum}-lock`, { force: true });
    const xvfb = this.spawnLogged('xvfb', 'Xvfb', [
      this.display, '-screen', '0', `${config.screenWidth}x${config.screenHeight}x24`,
      '-nolisten', 'tcp', '-noreset', '+extension', 'GLX', '+extension', 'RANDR',
    ]);
    xvfb.on('exit', () => { if (!this.stopping) this.stop('The virtual display stopped unexpectedly.'); });
    await waitFor(() => fs.existsSync(socket), 10000, 'Xvfb');
  }

  async startAudio() {
    const pulse = this.spawnLogged('audio', 'pulseaudio', [
      '-n', '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=no', '--disable-shm=yes',
      `--load=module-native-protocol-unix socket=${this.pulseSocket} auth-anonymous=1`,
      '--load=module-null-sink sink_name=game sink_properties=device.description=game',
      '--load=module-always-sink',
    ], { env: { PATH: process.env.PATH, HOME: this.runDir, XDG_RUNTIME_DIR: this.runDir } });
    await waitFor(() => pulse.exitCode !== null || fs.existsSync(this.pulseSocket), 5000, 'PulseAudio');
    if (pulse.exitCode !== null) throw new Error('pulseaudio exited');
    this.audioReady = true;
  }

  // ---------------------------------------------------------- streaming

  attachVideo(ws) {
    if (this.videoClient) this.videoClient.close(4000, 'Opened in another tab');
    this.videoClient = ws;
    this.clearIdleTimer();
    this.startFfmpeg(ws);
    ws.on('close', () => {
      if (this.videoClient !== ws) return;
      this.videoClient = null;
      this.stopFfmpeg();
      this.input?.releaseAll();
      this.armIdleTimer();
    });
  }

  startFfmpeg(ws) {
    this.stopFfmpeg();
    const { screenWidth: w, screenHeight: h, fps, videoBitrateKbps: kbps } = config;
    const audio = this.audioReady;
    const args = [
      '-loglevel', 'error', '-nostdin',
      '-fflags', 'nobuffer', '-thread_queue_size', '64',
      '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps), '-video_size', `${w}x${h}`, '-i', `${this.display}.0`,
    ];
    // Small audio chunks (10 ms) so the muxer doesn't hold video back waiting for audio
    if (audio) args.push('-thread_queue_size', '64', '-f', 'pulse', '-fragment_size', '1920', '-i', 'game.monitor');
    args.push(
      '-map', '0:v',
      '-f', 'mpegts',
      '-c:v', 'mpeg1video', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.round(kbps / 2)}k`,
      '-bf', '0', '-g', String(fps), '-qmin', '2', '-qmax', '24',
    );
    if (audio) args.push('-map', '1:a', '-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2');
    args.push('-muxdelay', '0.001', '-flush_packets', '1', 'pipe:1');

    const ff = spawn('ffmpeg', args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: this.runDir, PULSE_SERVER: `unix:${this.pulseSocket}` },
    });
    this.ffmpeg = ff;
    // When the viewer's connection can't keep up, skip video instead of letting
    // it queue: never more than about half a second waits to be sent. The
    // picture glitches briefly until the next keyframe, but stays live.
    const maxQueued = Math.max(64 * 1024, (kbps * 1000 / 8) * 0.5);
    ff.stdout.on('data', (chunk) => {
      if (ws.readyState === 1 && ws.bufferedAmount < maxQueued) ws.send(chunk);
    });
    ff.stderr.on('data', (d) => this.log(`[stream] ${d}`));
    ff.on('exit', () => { if (this.ffmpeg === ff) this.ffmpeg = null; });
  }

  stopFfmpeg() {
    killTree(this.ffmpeg, 'SIGKILL');
    this.ffmpeg = null;
  }

  attachInput(ws) {
    // Tell the page whether the game has the mouse captured (touch controls
    // switch between tapping menus and looking around on it)
    const sendState = () => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ captured: !!this.input?.captured }));
    };
    sendState();
    this.on('captured', sendState);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this.handleInput(msg);
    });
    ws.on('close', () => {
      this.off('captured', sendState);
      this.input?.releaseAll();
    });
  }

  handleInput(msg) {
    const input = this.input;
    if (!input || this.state !== 'running' || !Array.isArray(msg)) return;
    const [t, a, b] = msg;
    switch (t) {
      case 'm': if (Number.isFinite(a) && Number.isFinite(b)) input.move(a, b); break;
      case 'a': if (Number.isFinite(a) && Number.isFinite(b)) input.moveTo(a, b); break;
      case 'k': if (typeof a === 'string') input.key(a, !!b); break;
      case 'b': if (Number.isInteger(a)) input.button(a, !!b); break;
      case 'w': if (Number.isInteger(a)) input.wheel(a); break;
      case 'f': input.focusGame(); break;
      case 'r': input.releaseAll(); break;
      default: break;
    }
  }

  // ---------------------------------------------------------- lifecycle

  armIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.stop('Stopped after being idle with no viewer.'), config.idleTimeoutMs);
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async stop(error = null) {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    this.stopped = (async () => {
      this.clearIdleTimer();
      if (error) { this.error = error; this.state = 'error'; } else { this.state = 'stopping'; }
      this.progress = { stage: 'Saving and shutting down' };
      this.videoClient?.close(4001, 'Session ended');
      this.stopFfmpeg();
      this.input?.close();
      // SIGTERM runs Minecraft's shutdown hook, which saves the single-player world
      const game = this.procs.game;
      killTree(game, 'SIGTERM');
      await waitExit(game, 20000);
      killTree(game, 'SIGKILL');
      for (const name of ['audio', 'xvfb']) killTree(this.procs[name], 'SIGTERM');
      await Promise.all(['audio', 'xvfb'].map((n) => waitExit(this.procs[n], 3000)));
      for (const name of ['audio', 'xvfb']) killTree(this.procs[name], 'SIGKILL');
      await fsp.rm(this.runDir, { recursive: true, force: true }).catch(() => {});
      if (!error) this.state = 'stopped';
      this.progress = null;
      this.emit('stopped');
    })();
    return this.stopped;
  }
}

// ---------------------------------------------------------------- manager

class SessionManager {
  constructor() {
    this.byUuid = new Map();
    this.usedDisplays = new Set();
  }

  get(uuid) {
    return this.byUuid.get(uuid) || null;
  }

  activeCount() {
    let n = 0;
    for (const s of this.byUuid.values()) if (!s.stopping) n++;
    return n;
  }

  start(account, versionId, mods = {}) {
    const existing = this.get(account.profile.id);
    if (existing && !existing.stopping) return existing;
    if (existing && existing.state === 'stopping') throw new Error('Your previous game is still shutting down, try again in a few seconds.');
    if (this.activeCount() >= config.maxSessions) throw new Error('The server is full right now. Try again later.');

    let displayNum = config.displayBase;
    while (this.usedDisplays.has(displayNum)) displayNum++;
    this.usedDisplays.add(displayNum);

    const session = new PlayerSession({ account, versionId, displayNum, mods });
    this.byUuid.set(account.profile.id, session);
    session.once('stopped', () => this.usedDisplays.delete(displayNum));
    session.start();
    return session;
  }

  async stopAll() {
    await Promise.all([...this.byUuid.values()].map((s) => s.stop()));
  }
}

module.exports = { SessionManager, hasPulse };
