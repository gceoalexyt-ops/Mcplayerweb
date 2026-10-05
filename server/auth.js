'use strict';

// Microsoft account -> Xbox Live -> XSTS -> Minecraft services.
// This is the same chain the official launcher uses; the Minecraft access
// token it produces only exists for accounts that really own the game.

const crypto = require('crypto');
const { config } = require('./config');

const MS_AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const MS_SCOPE = 'XboxLive.signin offline_access';

// Without an Azure app of our own, sign-in uses Microsoft's device code flow
// with the public client ID of Microsoft's own Minecraft/Xbox app (the same one
// tools like prismarine-auth use). The player signs in at microsoft.com/link.
const LIVE_CLIENT_ID = '000000004C12AE6F';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const LIVE_DEVICE = 'https://login.live.com/oauth20_connect.srf';
const LIVE_TOKEN = 'https://login.live.com/oauth20_token.srf';

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const XSTS_ERRORS = {
  2148916227: 'This account is banned from Xbox Live.',
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at minecraft.net or xbox.com to create one, then try again.',
  2148916235: 'Xbox Live is not available in your country/region.',
  2148916236: 'This account needs adult verification on xbox.com (South Korea).',
  2148916237: 'This account needs adult verification on xbox.com (South Korea).',
  2148916238: 'This is a child account. An adult must add it to a Microsoft Family before it can sign in.',
};

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl(state, codeChallenge) {
  const params = new URLSearchParams({
    client_id: config.msClientId,
    response_type: 'code',
    redirect_uri: config.msRedirectUri,
    response_mode: 'query',
    scope: MS_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${MS_AUTHORIZE}?${params}`;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { res, data, text };
}

async function msToken(params) {
  const body = new URLSearchParams({
    client_id: config.msClientId,
    scope: MS_SCOPE,
    redirect_uri: config.msRedirectUri,
    ...params,
  });
  if (config.msClientSecret) body.set('client_secret', config.msClientSecret);
  const res = await fetch(MS_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AuthError(`Microsoft sign-in failed: ${data.error_description || data.error || res.status}`, 'ms_token');
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

function redeemCode(code, codeVerifier) {
  return msToken({ grant_type: 'authorization_code', code, code_verifier: codeVerifier });
}

async function liveToken(params) {
  const res = await fetch(LIVE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: LIVE_CLIENT_ID, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Step 1 of a device code sign-in: a short code the player enters at microsoft.com/link.
async function startDeviceLogin() {
  const res = await fetch(LIVE_DEVICE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: LIVE_CLIENT_ID, scope: LIVE_SCOPE, response_type: 'device_code' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new AuthError(`Could not start Microsoft sign-in: ${data.error_description || data.error || res.status}`, 'device');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval || 5,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
  };
}

// Step 2: returns null while the player hasn't finished signing in yet, or
// { slowDown: true } when Microsoft asks us to poll less often.
async function pollDeviceLogin(deviceCode) {
  const { res, data } = await liveToken({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  if (res.ok && data.access_token) return { accessToken: data.access_token, refreshToken: data.refresh_token };
  if (data.error === 'authorization_pending') return null;
  if (data.error === 'slow_down') return { slowDown: true };
  if (data.error === 'expired_token') throw new AuthError('The sign-in code expired. Please try again.', 'expired');
  if (data.error === 'authorization_declined' || data.error === 'access_denied') {
    throw new AuthError('Sign-in was cancelled.', 'declined');
  }
  throw new AuthError(`Microsoft sign-in failed: ${data.error_description || data.error || res.status}`, 'ms_token');
}

async function refreshMicrosoft(refreshToken, flow) {
  if (flow !== 'live') return msToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const { res, data } = await liveToken({ grant_type: 'refresh_token', scope: LIVE_SCOPE, refresh_token: refreshToken });
  if (!res.ok || !data.access_token) throw new AuthError('Session expired, please sign in again.', 'expired');
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

async function xboxLive(msAccessToken, flow) {
  // Azure (MSAL) tokens are sent as "d=", login.live.com tokens as "t=";
  // if Xbox Live rejects one form, try the other before giving up.
  const prefixes = flow === 'live' ? ['t', 'd'] : ['d', 't'];
  let status = 0;
  for (const prefix of prefixes) {
    const { res, data } = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `${prefix}=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }, { 'x-xbl-contract-version': '1' });
    if (res.ok && data?.Token) return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
    status = res.status;
    if (res.status !== 400 && res.status !== 401) break;
  }
  throw new AuthError(`Xbox Live sign-in failed (${status}).`, 'xbl');
}

async function xsts(xblToken) {
  const { res, data } = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  }, { 'x-xbl-contract-version': '1' });
  if (res.status === 401 && data?.XErr) {
    throw new AuthError(XSTS_ERRORS[data.XErr] || `Xbox Live refused the sign-in (XErr ${data.XErr}).`, 'xsts');
  }
  if (!res.ok || !data?.Token) throw new AuthError(`Xbox security token request failed (${res.status}).`, 'xsts');
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}

async function minecraftLogin(uhs, xstsToken) {
  const { res, data, text } = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
  });
  if (res.status === 403 && /Invalid app registration/i.test(text)) {
    throw new AuthError(
      'Mojang has not approved this Azure app for Minecraft sign-in yet. ' +
      'The site owner must request access at https://aka.ms/mce-reviewappid (see README).',
      'app_not_approved',
    );
  }
  if (!res.ok || !data?.access_token) throw new AuthError(`Minecraft sign-in failed (${res.status}).`, 'mc_login');
  return { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

async function minecraftProfile(mcAccessToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  if (res.status === 404) {
    throw new AuthError(
      'This Microsoft account does not own Minecraft: Java Edition (or has not picked a profile name yet at minecraft.net).',
      'no_game',
    );
  }
  if (!res.ok) throw new AuthError(`Could not load your Minecraft profile (${res.status}).`, 'profile');
  const p = await res.json();
  const skin = (p.skins || []).find((s) => s.state === 'ACTIVE') || (p.skins || [])[0];
  return { id: p.id, name: p.name, skinUrl: skin ? skin.url.replace(/^http:/, 'https:') : null };
}

// Full chain from a Microsoft access token to a verified Minecraft account.
// `flow` is 'live' for device code sign-ins and 'azure' for the redirect flow.
async function loginWithMicrosoftToken(msAccessToken, flow = 'azure') {
  const xbl = await xboxLive(msAccessToken, flow);
  const x = await xsts(xbl.token);
  const mc = await minecraftLogin(x.uhs, x.token);
  const profile = await minecraftProfile(mc.accessToken);
  return { mcAccessToken: mc.accessToken, mcExpiresAt: mc.expiresAt, profile };
}

// Returns a Minecraft token valid for at least another hour, refreshing via the
// stored Microsoft refresh token when needed. Mutates and returns `account`.
async function ensureFreshToken(account) {
  if (account.mcExpiresAt - Date.now() > 60 * 60 * 1000) return account;
  if (!account.msRefreshToken) throw new AuthError('Session expired, please sign in again.', 'expired');
  const ms = await refreshMicrosoft(account.msRefreshToken, account.msFlow);
  const result = await loginWithMicrosoftToken(ms.accessToken, account.msFlow);
  account.msRefreshToken = ms.refreshToken || account.msRefreshToken;
  account.mcAccessToken = result.mcAccessToken;
  account.mcExpiresAt = result.mcExpiresAt;
  account.profile = result.profile;
  return account;
}

module.exports = {
  AuthError,
  createPkce,
  authorizeUrl,
  redeemCode,
  startDeviceLogin,
  pollDeviceLogin,
  loginWithMicrosoftToken,
  ensureFreshToken,
};
