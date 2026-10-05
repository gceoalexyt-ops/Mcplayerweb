'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');
const { config, assertConfigured } = require('./config');
const auth = require('./auth');
const launcher = require('./launcher');
const { SessionManager } = require('./session');

assertConfigured();

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

app.get('/auth/login', (req, res) => {
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
    const mc = await auth.loginWithMicrosoftToken(ms.accessToken);
    accounts.set(mc.profile.id, {
      profile: mc.profile,
      mcAccessToken: mc.mcAccessToken,
      mcExpiresAt: mc.mcExpiresAt,
      msRefreshToken: ms.refreshToken,
    });
    req.session.regenerate((err) => {
      if (err) return fail('Could not start a session.');
      req.session.uuid = mc.profile.id;
      res.redirect('/');
    });
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
  if (!account) return res.status(401).json({ error: 'Not signed in' });
  res.json({ id: account.profile.id, name: account.profile.name, skinUrl: account.profile.skinUrl });
});

app.get('/api/versions', requireAccount, async (req, res) => {
  try {
    res.json(await launcher.listReleases());
  } catch (err) {
    res.status(502).json({ error: `Could not reach Mojang: ${err.message}` });
  }
});

app.post('/api/play', requireAccount, async (req, res) => {
  const version = String(req.body?.version || '');
  try {
    const { versions } = await launcher.listReleases();
    if (!versions.includes(version)) return res.status(400).json({ error: 'Pick a release version.' });
    const game = games.start(req.account, version);
    res.json(game.status());
  } catch (err) {
    res.status(409).json({ error: err.message });
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

// ---------------------------------------------------------------- websockets

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const reject = (code) => { socket.write(`HTTP/1.1 ${code}\r\n\r\n`); socket.destroy(); };
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws/video' && pathname !== '/ws/input') return reject('404 Not Found');
  // Block cross-site WebSocket hijacking: only our own pages may connect
  if (req.headers.origin !== config.baseUrl) return reject('403 Forbidden');

  sessionParser(req, {}, () => {
    const account = currentAccount(req);
    const game = account && games.get(account.profile.id);
    if (!game || game.state !== 'running') return reject('409 Conflict');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === '/ws/video') {
        game.attachVideo(ws);
      } else {
        ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          game.handleInput(msg);
        });
        ws.on('close', () => game.input?.releaseAll());
      }
    });
  });
});

server.listen(config.port, () => {
  console.log(`Minecraft web player listening on ${config.baseUrl} (port ${config.port})`);
});

async function shutdown() {
  console.log('Shutting down, saving running games...');
  server.close();
  await games.stopAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
