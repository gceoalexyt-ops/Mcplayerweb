# Minecraft Web Player

Sign in with your Microsoft account and play the **real Minecraft: Java Edition** in your browser.

Your browser doesn't run the game. The official, unmodified Minecraft client runs on the server and streams to you:

1. **Sign-in:** Microsoft OAuth → Xbox Live → XSTS → Minecraft services, the same chain the official launcher uses. Only accounts that own Java Edition get in (no offline or cracked mode).
2. **Launch:** the server downloads the official client, libraries, assets and Mojang's Java runtime from Mojang's servers. It then starts the game on a virtual display (Xvfb), signed in as you.
3. **Stream:** ffmpeg captures the display (plus game audio via PulseAudio) and streams it as MPEG-TS over a WebSocket. [JSMpeg](https://github.com/phoboslab/jsmpeg) plays it in the page.
4. **Input:** the page captures your mouse (Pointer Lock) and keyboard and sends them back. The server injects them into the game with XTEST.

Minecraft tokens never leave the server. The browser only gets a session cookie.

## Status

The sign-in flow, the streaming pipeline and input injection were tested end-to-end with a stand-in Java app. The full flow with the real game and a real account has **not** been tested yet: the dev sandbox could not reach Mojang's servers.

## Microsoft / Azure setup (required)

1. Go to <https://portal.azure.com> → **App registrations** → **New registration**.
   - Supported account types: **Personal Microsoft accounts only**.
   - Redirect URI: platform **Web**, value `BASE_URL/auth/callback` (e.g. `http://localhost:3000/auth/callback`).
2. Under **Certificates & secrets**, create a client secret.
3. Put the **Application (client) ID** and secret in `.env` as `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.
4. **Ask Mojang to approve your app for Minecraft:** <https://aka.ms/mce-reviewappid>. Until they approve it, sign-in fails with "Invalid app registration". Mojang requires this for every new third-party app.

## Running

```bash
cp .env.example .env      # fill in BASE_URL, SESSION_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET
docker compose up --build
```

Open `BASE_URL`, sign in, pick a version and press **Play**. The first launch of a version downloads ~600 MB from Mojang.

Without Docker you need Node 20+, `Xvfb`, `ffmpeg`, Mesa OpenGL, and optionally `pulseaudio` for sound. Then run `npm install && npm start`.

For anything beyond localhost, put it behind HTTPS (e.g. Caddy or nginx), set `BASE_URL=https://…` and `TRUST_PROXY=1`. Pointer Lock and fullscreen keyboard lock work best over HTTPS.

## Hardware

Without a GPU the game renders on the CPU (Mesa llvmpipe). Plan on ~4 cores and ~4 GB RAM per player for playable 720p. A GPU server is much smoother. Lower `SCREEN_WIDTH`/`SCREEN_HEIGHT` and the in-game render distance if it struggles.

## Controls

- Click the game to capture the mouse. **Esc** releases it and opens the pause menu.
- **Fullscreen** (Chromium) also locks the keyboard, so Esc and shortcuts go to the game.
- **Save & quit** shuts the game down cleanly, which saves single-player worlds. Games with no viewer stop after `IDLE_TIMEOUT_MINUTES`.

## Notes

- Each Minecraft account can run one game at a time. `MAX_SESSIONS` caps the total.
- Worlds and settings are stored per player in `DATA_DIR/players/<uuid>`.
- This is meant for people playing their own copies. Check the Minecraft EULA before offering it as a public service.
