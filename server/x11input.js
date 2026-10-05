'use strict';

// Injects browser input into the game's virtual X display with XTEST, and
// keeps the game window focused and filling the screen (there is no window
// manager on the virtual display).

const x11 = require('x11');

// KeyboardEvent.code -> Linux evdev keycode. Xvfb uses the evdev keymap, where
// X keycode = evdev + 8. Physical codes keep WASD in place on any layout.
const EVDEV = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9,
  Digit9: 10, Digit0: 11, Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81,
  Numpad0: 82, NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108,
  PageDown: 109, Insert: 110, Delete: 111, Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
};

const BUTTONS = { 0: 1, 1: 2, 2: 3, 3: 8, 4: 9 }; // DOM MouseEvent.button -> X button

class X11Input {
  constructor(display, width, height) {
    this.display = display;
    this.width = width;
    this.height = height;
    this.client = null;
    this.X = null;
    this.xtest = null;
    this.root = 0;
    this.gameWindow = 0;
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.timer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const client = x11.createClient({ display: this.display }, (err, display) => {
        if (err) return reject(err);
        this.client = display;
        this.X = display.client;
        this.root = display.screen[0].root;
        this.X.on('error', () => {}); // stale window ids etc. are harmless
        this.X.require('xtest', (e, xtest) => {
          if (e) return reject(e);
          this.xtest = xtest;
          // 1:1 pointer motion, no acceleration: the browser already applies the OS curve
          this.X.ChangePointerControl(1, 1, 0, true, true);
          this.timer = setInterval(() => this.manageWindows(), 1000);
          resolve();
        });
      });
      client.on('error', reject);
    });
  }

  close() {
    clearInterval(this.timer);
    this.releaseAll();
    try { this.X?.terminate(); } catch { /* already gone */ }
    this.X = null;
  }

  key(code, down) {
    const evdev = EVDEV[code];
    if (!this.xtest || evdev === undefined) return;
    const keycode = evdev + 8;
    if (down) this.pressedKeys.add(keycode); else if (!this.pressedKeys.delete(keycode)) return;
    this.xtest.FakeInput(down ? this.xtest.KeyPress : this.xtest.KeyRelease, keycode, 0, 0, 0, 0);
  }

  button(domButton, down) {
    const b = BUTTONS[domButton];
    if (!this.xtest || !b) return;
    if (down) this.pressedButtons.add(b); else if (!this.pressedButtons.delete(b)) return;
    this.xtest.FakeInput(down ? this.xtest.ButtonPress : this.xtest.ButtonRelease, b, 0, 0, 0, 0);
  }

  wheel(steps) {
    if (!this.xtest) return;
    const b = steps < 0 ? 4 : 5;
    for (let i = 0; i < Math.min(Math.abs(steps), 10); i++) {
      this.xtest.FakeInput(this.xtest.ButtonPress, b, 0, 0, 0, 0);
      this.xtest.FakeInput(this.xtest.ButtonRelease, b, 0, 0, 0, 0);
    }
  }

  // Relative motion (detail=1). The game warps the pointer back to the
  // window centre when it captures the mouse, so relative deltas map
  // directly onto camera movement, and onto the cursor in menus.
  move(dx, dy) {
    if (!this.xtest) return;
    const clamp = (v) => Math.max(-2000, Math.min(2000, Math.round(v)));
    this.xtest.FakeInput(this.xtest.MotionNotify, 1, 0, 0, clamp(dx), clamp(dy));
  }

  releaseAll() {
    if (!this.xtest) return;
    for (const k of this.pressedKeys) this.xtest.FakeInput(this.xtest.KeyRelease, k, 0, 0, 0, 0);
    for (const b of this.pressedButtons) this.xtest.FakeInput(this.xtest.ButtonRelease, b, 0, 0, 0, 0);
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }

  focusGame() {
    if (this.X && this.gameWindow) this.X.SetInputFocus(this.gameWindow, 1);
  }

  call(fn, ...args) {
    return new Promise((resolve) => {
      if (!this.X) return resolve(null);
      this.X[fn](...args, (err, res) => resolve(err ? null : res));
    });
  }

  async manageWindows() {
    const tree = await this.call('QueryTree', this.root);
    if (!tree) return;
    let best = null;
    for (const wid of tree.children) {
      const attrs = await this.call('GetWindowAttributes', wid);
      if (!attrs || attrs.mapState !== 2 || attrs.overrideRedirect) continue;
      const geo = await this.call('GetGeometry', wid);
      if (!geo) continue;
      const area = geo.width * geo.height;
      if (!best || area >= best.area) best = { wid, geo, area };
    }
    if (!best || !this.X) return;
    const { wid, geo } = best;
    if (geo.xPos !== 0 || geo.yPos !== 0 || geo.width !== this.width || geo.height !== this.height) {
      this.X.MoveResizeWindow(wid, 0, 0, this.width, this.height);
    }
    if (wid !== this.gameWindow) {
      this.gameWindow = wid;
      this.focusGame();
    }
  }
}

module.exports = { X11Input, EVDEV };
