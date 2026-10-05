# Minecraft Web Player

Sign in with your Microsoft account and play the **real Minecraft: Java Edition** in your browser.

Your browser doesn't run the game. The official, unmodified Minecraft client runs on the server and streams to you:

1. **Sign-in:** the page shows a code; you enter it at [microsoft.com/link](https://www.microsoft.com/link) and sign in with your Microsoft account. The server then goes Microsoft → Xbox Live → XSTS → Minecraft services, the same chain the official launcher uses. Only accounts that own Java Edition get in (no offline or cracked mode).
2. **Launch:** the server downloads the official client, libraries, assets and Mojang's Java runtime from Mojang's servers. It then starts the game on a virtual display (Xvfb), signed in as you.
3. **Stream:** ffmpeg captures the display (plus game audio via PulseAudio) and streams it as MPEG-TS over a WebSocket. [JSMpeg](https://github.com/phoboslab/jsmpeg) plays it in the page.
4. **Input:** the page captures your mouse (Pointer Lock) and keyboard and sends them back. The server injects them into the game with XTEST.

Minecraft tokens never leave the server. The browser only gets a session cookie.

## Status

The downloader was tested against Mojang's servers with Minecraft 26.3: every file passed its SHA-1 check. The real game was launched on Xvfb with a placeholder login and reached the title screen with sound initialised (Vulkan via Mesa lavapipe, on Ubuntu 24.04). The code sign-in was checked up to Microsoft issuing the code. Not yet confirmed: signing in with a real account, keyboard/mouse input, audio in the browser stream, and setup on Debian bookworm (Codespaces).

## Run it free on GitHub Codespaces (no VPS)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/gceoalexyt-ops/Mcplayerweb/tree/claude/stoic-hopper-nqwz0j?quickstart=1)

1. Click the badge and create the codespace.
2. Wait for setup to finish. The server starts by itself and prints its address, e.g. `https://<your-codespace>-3000.app.github.dev`.
3. Open that link (or the **Ports** tab, port 3000) and press **Sign in with Microsoft**. Go to microsoft.com/link, enter the code the page shows and sign in with the account that owns Minecraft.
4. Pick a version and press **Play**.

Things to know about Codespaces:
- GitHub's free plan covers 120 core-hours a month. This project uses a 4-core machine, so that's about **30 hours of play a month**.
- Codespaces stop after 30 minutes without editor activity by default. Raise the idle timeout (up to 4 hours) at github.com/settings/codespaces.
- When you're done, stop the codespace (github.com/codespaces → … → Stop) so it doesn't use your hours. Worlds are kept in the codespace until you delete it.
- There's no GPU, so the game runs at 854×480 with light graphics settings (render distance 6, no clouds, fast graphics) to keep the frame rate up. You can raise them in Options, at the cost of smoothness.
- The port is private by default, so only you (signed in to GitHub) can open the site.

## Running on your own server

```bash
cp .env.example .env      # fill in BASE_URL and SESSION_SECRET
docker compose up --build
```

Open `BASE_URL`, sign in, pick a version and press **Play**. The first launch of a version downloads ~600 MB from Mojang.

Without Docker you need Node 20+, `Xvfb`, `ffmpeg`, Mesa OpenGL and Vulkan (`mesa-vulkan-drivers`; Minecraft 26.1+ renders with Vulkan on a virtual display), and optionally `pulseaudio` for sound. Then run `npm install && npm start`.

For anything beyond localhost, put it behind HTTPS (e.g. Caddy or nginx), set `BASE_URL=https://…` and `TRUST_PROXY=1`. Pointer Lock and fullscreen keyboard lock work best over HTTPS.

## Hardware

Without a GPU the game renders on the CPU (Mesa llvmpipe). Plan on ~4 cores and ~4 GB RAM per player for playable 720p. A GPU server is much smoother. Lower `SCREEN_WIDTH`/`SCREEN_HEIGHT` and the in-game render distance if it struggles.

## Controls

- Click the game to capture the mouse. **Esc** releases it and opens the pause menu.
- **Fullscreen** (Chromium) also locks the keyboard, so Esc and shortcuts go to the game.
- **Save & quit** shuts the game down cleanly, which saves single-player worlds. Games with no viewer stop after `IDLE_TIMEOUT_MINUTES`.

On phones and tablets the game fills the screen with touch controls:
- **Menus:** tap where you want to click; drag to move sliders and items.
- **Playing:** drag on the picture to look around, tap to use/place, hold still to break. The joystick walks (push it all the way up to sprint). The buttons are Jump, Sneak (toggles), Hit, Use, ◀ ▶ for the hotbar, Inv and Chat.
- **Top right:** Esc (pause/back), ⌨ opens your phone's keyboard to type into the game, ⛶ fullscreen (Android), Quit.
- Turn the phone sideways for a bigger picture.

## Notes

- Each Minecraft account can run one game at a time. `MAX_SESSIONS` caps the total.
- Worlds and settings are stored per player in `DATA_DIR/players/<uuid>`.
- This is meant for people playing their own copies. Check the Minecraft EULA before offering it as a public service.

## Optional: sign in through your own Azure app

Instead of the sign-in code, you can send players to Microsoft's sign-in page through your own Azure app. Code sign-in uses the public client ID of Microsoft's own Minecraft/Xbox app (the same one tools like prismarine-auth/Mineflayer use). That works without any setup, but Microsoft or Mojang could restrict it. To use your own app instead:

1. Go to <https://portal.azure.com> → **App registrations** → **New registration**.
   - Supported account types: **Personal Microsoft accounts only**.
   - Redirect URI: platform **Web**, value `BASE_URL/auth/callback` (e.g. `http://localhost:3000/auth/callback`).
2. Under **Certificates & secrets**, create a client secret.
3. Put the **Application (client) ID** and secret in `.env` (or Codespaces secrets) as `MS_CLIENT_ID` / `MS_CLIENT_SECRET`. The server then prints the redirect URI to add in Azure.
4. **Ask Mojang to approve your app for Minecraft:** <https://aka.ms/mce-reviewappid>. Until they approve it, sign-in fails with "Invalid app registration". Mojang requires this for every new third-party app.
