'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const baseUrl = (process.env.BASE_URL || `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, '');

const config = {
  port: int('PORT', 3000),
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  sessionSecret: process.env.SESSION_SECRET,

  // Azure app registration (https://portal.azure.com -> App registrations)
  msClientId: process.env.MS_CLIENT_ID,
  msClientSecret: process.env.MS_CLIENT_SECRET || '',
  msRedirectUri: `${baseUrl}/auth/callback`,

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  runtimeDir: path.resolve(process.env.RUNTIME_DIR || '/tmp/mcweb'),

  maxSessions: int('MAX_SESSIONS', 2),
  idleTimeoutMs: int('IDLE_TIMEOUT_MINUTES', 10) * 60 * 1000,

  screenWidth: int('SCREEN_WIDTH', 1280),
  screenHeight: int('SCREEN_HEIGHT', 720),
  fps: int('STREAM_FPS', 30),
  videoBitrateKbps: int('VIDEO_BITRATE_KBPS', 4000),
  audio: process.env.AUDIO !== '0',

  javaPath: process.env.JAVA_PATH || '', // empty = download Mojang's bundled runtime
  maxMemoryMb: int('MC_MAX_MEMORY_MB', 3072),
  displayBase: int('DISPLAY_BASE', 100),
};

function assertConfigured() {
  const missing = [];
  if (!config.msClientId) missing.push('MS_CLIENT_ID');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill it in (see README.md).');
    process.exit(1);
  }
}

module.exports = { config, assertConfigured };
