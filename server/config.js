'use strict';

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

// In GitHub Codespaces the site is reached through GitHub's HTTPS port forwarding
const codespaceUrl = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
  ? `https://${process.env.CODESPACE_NAME}-${int('PORT', 3000)}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
  : null;
const baseUrl = (process.env.BASE_URL || codespaceUrl || `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, '');

// Codespaces created before the switch to 854x480 have the old 1024x576 at
// 3000 kbps baked into their environment until they're rebuilt. Treat those
// exact old values as unset so existing codespaces get the faster settings too.
const oldCodespaceEnv = !!codespaceUrl && process.env.SCREEN_WIDTH === '1024' && process.env.SCREEN_HEIGHT === '576';
if (oldCodespaceEnv) {
  process.env.SCREEN_WIDTH = '854';
  process.env.SCREEN_HEIGHT = '480';
  if (process.env.VIDEO_BITRATE_KBPS === '3000') process.env.VIDEO_BITRATE_KBPS = '1800';
}

const config = {
  port: int('PORT', 3000),
  baseUrl,
  codespaceUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' || (!process.env.TRUST_PROXY && !!codespaceUrl),
  // Without a fixed secret, sign-ins simply don't survive a server restart
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  // Optional Azure app registration (https://portal.azure.com -> App registrations).
  // Without one, players sign in with a code at microsoft.com/link instead.
  msClientId: process.env.MS_CLIENT_ID || '',
  msClientSecret: process.env.MS_CLIENT_SECRET || '',
  msRedirectUri: `${baseUrl}/auth/callback`,

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  runtimeDir: path.resolve(process.env.RUNTIME_DIR || '/tmp/mcweb'),

  maxSessions: int('MAX_SESSIONS', 2),
  // Downloaded in the background at startup so the first Play is quick ('' turns it off)
  preloadVersion: process.env.PRELOAD_VERSION ?? '1.21.11',
  idleTimeoutMs: int('IDLE_TIMEOUT_MINUTES', 10) * 60 * 1000,

  screenWidth: int('SCREEN_WIDTH', 1280),
  screenHeight: int('SCREEN_HEIGHT', 720),
  fps: int('STREAM_FPS', 30),
  videoBitrateKbps: int('VIDEO_BITRATE_KBPS', 2500),
  audio: process.env.AUDIO !== '0',

  javaPath: process.env.JAVA_PATH || '', // empty = download Mojang's bundled runtime
  maxMemoryMb: int('MC_MAX_MEMORY_MB', 3072),
  displayBase: int('DISPLAY_BASE', 100),
};

module.exports = { config };
