'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');
const { config } = require('./config');
const auth = require('./auth');
const launcher = require('./launcher');
const customMods = require('./custommods');
const { SessionManager } = require('./session');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);

const sessionParser = session({
  name: 'mcweb.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 30 * 24 * 3600 * 1000 },
});
app.use(sessionParser);
app.use(express.json({ limit: '16kb' }));

// Minecraft tokens never leave the server: the browser session only holds the
// player's UUID, and the tokens live here in memory.
const accounts = new Map();
const games = new SessionManager();

function currentAccount(req) {
  const uuid = req.session?.uuid;
  return (uuid && accounts.get(uuid)) || null;
}

function requireAccount(req, res, next) {
  const account = currentAccount(req);
  if (!account) return res.status(401).json({ error: 'Not signed in' });
  req.account = account;
  next();
}

// ---------------------------------------------------------------- auth routes

// Signs the browser session in as a verified Minecraft account.
function signIn(req, ms, mc, flow) {
  accounts.set(mc.profile.id, {
    profile: mc.profile,
    mcAccessToken: mc.mcAccessToken,
    mcExpiresAt: mc.mcExpiresAt,
    msRefreshToken: ms.refreshToken,
    msFlow: flow,
  });
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(new Error('Could not start a session.'));
      req.session.uuid = mc.profile.id;
      resolve();
    });
  });
}

// Device code sign-in (no Azure app needed): the page shows a code, the player
// enters it at microsoft.com/link, and the page polls until they're done.
app.post('/auth/device/start', async (req, res) => {
  try {
    const d = await auth.startDeviceLogin();
    req.session.device = { deviceCode: d.deviceCode, interval: d.interval, expiresAt: d.expiresAt, nextPoll: 0 };
    res.json({ userCode: d.userCode, verificationUri: d.verificationUri, interval: d.interval });
  } catch (err) {
    console.error('Sign-in failed:', err.message);
    res.status(502).json({ error: err instanceof auth.AuthError ? err.message : 'Could not reach Microsoft.' });
  }
});

app.post('/auth/device/poll', async (req, res) => {
  const d = req.session.device;
  if (!d || Date.now() > d.expiresAt) {
    delete req.session.device;
    return res.status(410).json({ error: 'The sign-in code expired. Please try again.' });
  }
  // Never poll Microsoft faster than it asked, however often the page calls us
  if (Date.now() < d.nextPoll) return res.json({ pending: true });
  d.nextPoll = Date.now() + d.interval * 1000 - 500;
  try {
    const ms = await auth.pollDeviceLogin(d.deviceCode);
    if (!ms || ms.slowDown) {
      if (ms?.slowDown) d.interval += 5;
      return res.json({ pending: true });
    }
    delete req.session.device;
    const mc = await auth.loginWithMicrosoftToken(ms.accessToken, 'live');
    await signIn(req, ms, mc, 'live');
    res.json({ ok: true });
  } catch (err) {
    delete req.session.device;
    console.error('Sign-in failed:', err.message);
    res.status(400).json({ error: err instanceof auth.AuthError ? err.message : 'Sign-in failed. Please try again.' });
  }
});

// Redirect sign-in through your own Azure app (only when MS_CLIENT_ID is set)
app.get('/auth/login', (req, res) => {
  if (!config.msClientId) return res.redirect('/');
  const state = crypto.randomBytes(16).toString('hex');
  const pkce = auth.createPkce();
  req.session.oauth = { state, verifier: pkce.verifier };
  res.redirect(auth.authorizeUrl(state, pkce.challenge));
});

app.get('/auth/callback', async (req, res) => {
  const pending = req.session.oauth;
  delete req.session.oauth;
  const fail = (msg) => res.redirect(`/?error=${encodeURIComponent(msg)}`);
  if (req.query.error) return fail(req.query.error_description || req.query.error);
  if (!pending || !req.query.code || req.query.state !== pending.state) return fail('Sign-in expired, please try again.');
  try {
    const ms = await auth.redeemCode(String(req.query.code), pending.verifier);
    const mc = await auth.loginWithMicrosoftToken(ms.accessToken, 'azure');
    await signIn(req, ms, mc, 'azure');
    res.redirect('/');
  } catch (err) {
    console.error('Sign-in failed:', err.message);
    fail(err instanceof auth.AuthError ? err.message : 'Sign-in failed. Please try again.');
  }
});

app.post('/auth/logout', (req, res) => {
  const uuid = req.session.uuid;
  const game = uuid && games.get(uuid);
  if (game) game.stop();
  if (uuid) accounts.delete(uuid);
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------- API

app.get('/api/me', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.status(401).json({ error: 'Not signed in', loginMode: config.msClientId ? 'redirect' : 'device' });
  res.json({ id: account.profile.id, name: account.profile.name, skinUrl: account.profile.skinUrl });
});

app.get('/api/versions', requireAccount, async (req, res) => {
  try {
    res.json({ ...(await launcher.listReleases()), mods: await launcher.modVersions() });
  } catch (err) {
    res.status(502).json({ error: `Could not reach Mojang: ${err.message}` });
  }
});

app.post('/api/play', requireAccount, async (req, res) => {
  const version = String(req.body?.version || '');
  try {
    const { versions } = await launcher.listReleases();
    if (!versions.includes(version)) return res.status(400).json({ error: 'Pick a release version.' });
    const game = games.start(req.account, version, {
      baritone: req.body?.baritone !== false,
      skyblocker: req.body?.skyblocker !== false,
      viafabricplus: req.body?.viafabricplus !== false,
      custom: config.customMods ? await customMods.jarsFor(req.account.profile.id, version) : [],
    }, { autoPacks: req.body?.autoPacks !== false });
    res.json(game.status());
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- custom mods

function requireCustomMods(req, res, next) {
  if (!config.customMods) return res.status(403).json({ error: 'Custom mods are turned off on this server.' });
  next();
}

function modError(res, err) {
  if (err instanceof customMods.ModError) return res.status(400).json({ error: err.message });
  console.error('Custom mod error:', err);
  res.status(500).json({ error: 'Something went wrong with that mod.' });
}

app.get('/api/mods', requireAccount, async (req, res) => {
  res.json({ enabled: config.customMods, mods: config.customMods ? await customMods.list(req.account.profile.id) : [] });
});

app.post('/api/mods', requireAccount, requireCustomMods,
  express.raw({ type: 'application/octet-stream', limit: customMods.CHUNK_MAX }),
  async (req, res) => {
    try {
      const chunk = Buffer.isBuffer(req.body) ? req.body : null;
      const q = req.query;
      // Without upload=..., the whole file came in this one request
      const result = q.upload
        ? await customMods.addChunk(req.account.profile.id, {
          uploadId: String(q.upload), offset: Number(q.offset), total: Number(q.total), name: q.name,
        }, chunk)
        : await customMods.add(req.account.profile.id, q.name, chunk);
      res.json(result);
    } catch (err) {
      modError(res, err);
    }
  });

app.patch('/api/mods/:id', requireAccount, requireCustomMods, async (req, res) => {
  const changes = {};
  if (typeof req.body?.enabled === 'boolean') changes.enabled = req.body.enabled;
  if (req.body && 'alwaysVersion' in req.body) {
    const v = req.body.alwaysVersion;
    if (v !== null && v !== '') {
      const { versions } = await launcher.listReleases().catch(() => ({ versions: [] }));
      if (!versions.includes(v)) return res.status(400).json({ error: 'Pick a release version.' });
    }
    changes.alwaysVersion = v || null;
  }
  try {
    res.json(await customMods.update(req.account.profile.id, String(req.params.id), changes));
  } catch (err) {
    modError(res, err);
  }
});

app.delete('/api/mods/:id', requireAccount, requireCustomMods, async (req, res) => {
  try {
    await customMods.remove(req.account.profile.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    modError(res, err);
  }
});

app.get('/api/game', requireAccount, (req, res) => {
  const game = games.get(req.account.profile.id);
  res.json(game ? game.status() : { state: 'none' });
});

app.post('/api/stop', requireAccount, async (req, res) => {
  const game = games.get(req.account.profile.id);
  if (game) game.stop();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// Blocks cross-site WebSocket hijacking: only pages served by this site may
// open the game's sockets. The site can be reached under more than one
// address (BASE_URL, the Codespaces URL, or whatever host the browser used,
// e.g. through a port forward), so accept the origin if it matches any of them.
function originAllowed(req) {
  let host;
  try { host = new URL(req.headers.origin).host; } catch { return false; }
  const allowed = new Set([new URL(config.baseUrl).host]);
  if (config.codespaceUrl) allowed.add(new URL(config.codespaceUrl).host);
  if (req.headers.host) allowed.add(req.headers.host);
  if (config.trustProxy && req.headers['x-forwarded-host']) {
    allowed.add(String(req.headers['x-forwarded-host']).split(',')[0].trim());
  }
  return allowed.has(host);
}

// Why would the game's sockets be refused for this page? The page asks this
// when the video connection fails, so the player sees a real reason.
app.post('/api/stream-check', requireAccount, (req, res) => {
  const game = games.get(req.account.profile.id);
  if (!originAllowed(req)) {
    return res.json({ ok: false, reason: `This page's address (${req.headers.origin || 'unknown'}) doesn't match the server's address (${config.baseUrl}). Open the site at ${config.baseUrl}, or fix BASE_URL.` });
  }
  if (!game || game.state !== 'running') return res.json({ ok: false, reason: 'The game is not running.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- websockets

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const reject = (code, why) => {
    if (why) console.warn(`Refused a game connection: ${why}`);
    socket.write(`HTTP/1.1 ${code}\r\n\r\n`);
    socket.destroy();
  };
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws/video' && pathname !== '/ws/input') return reject('404 Not Found');
  if (!originAllowed(req)) {
    return reject('403 Forbidden', `page address ${req.headers.origin} doesn't match ${config.baseUrl} (host ${req.headers.host})`);
  }

  sessionParser(req, {}, () => {
    const account = currentAccount(req);
    const game = account && games.get(account.profile.id);
    if (!game || game.state !== 'running') return reject('409 Conflict', account ? 'the game is not running' : 'not signed in');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === '/ws/video') {
        game.attachVideo(ws);
      } else {
        game.attachInput(ws);
      }
    });
  });
});

server.listen(config.port, () => {
  console.log(`\nMinecraft web player is running: ${config.baseUrl}`);
  if (config.msClientId) console.log(`Azure redirect URI must be:      ${config.msRedirectUri}`);
  console.log('');
  preload();
});

// Downloads the default version (and Fabric with every optional mod) ahead of
// time. Uses the same files a player's launch does, so their Play is quick.
async function preload() {
  const v = config.preloadVersion;
  if (!v) return;
  try {
    const { versions } = await launcher.listReleases();
    if (!versions.includes(v)) return console.log(`[preload] ${v} is not a Minecraft release, skipping`);
    console.log(`[preload] Downloading Minecraft ${v} with Fabric and mods in the background...`);
    const mods = { baritone: true, skyblocker: true, viafabricplus: true };
    const plan = await launcher.prepare(v, path.join(config.dataDir, 'preload'), null, mods, (l) => console.log(l));
    console.log(`[preload] Minecraft ${v} is ready${plan.mods ? ` with ${plan.mods.label}` : ''}`);
  } catch (err) {
    console.log(`[preload] Failed, ${v} will download when someone presses Play: ${err.message}`);
  }
}

async function shutdown() {
  console.log('Shutting down, saving running games...');
  server.close();
  await games.stopAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
