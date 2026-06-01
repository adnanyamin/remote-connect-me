/**
 * Cross-platform input injection.
 *
 * Tries to load @nut-tree-fork/nut-js. If unavailable (e.g. native build failed
 * during npm install), it logs a warning and silently drops events so the rest
 * of the app keeps working — you'll be able to see the screen but not control it.
 *
 * Coordinates from the viewer are 0..1 fractions of the rendered video. They
 * map to whichever display we're currently capturing — set by setActiveDisplay()
 * from main.js when the user picks a monitor.
 */

let nut = null;
try {
  // eslint-disable-next-line global-require
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.mouseSpeed = 1500;
  nut.keyboard.config.autoDelayMs = 0;
} catch (e) {
  console.warn('[input] nut-js not available — input injection disabled:', e.message);
}

const { screen } = require('electron');

let activeDisplay = null;
function setActiveDisplay(d) { activeDisplay = d; }
function getActiveDisplay() { return activeDisplay || screen.getPrimaryDisplay(); }

/**
 * Translate a fractional (x: 0..1, y: 0..1) coordinate into absolute virtual-
 * desktop pixels of the currently captured display. We use bounds (not size)
 * because secondary displays are offset from (0,0) in the virtual desktop.
 */
function frac(x, y) {
  const d = getActiveDisplay();
  const w = d.size.width, h = d.size.height;
  const ox = d.bounds.x, oy = d.bounds.y;
  return {
    x: Math.max(ox, Math.min(ox + w - 1, Math.round(ox + x * w))),
    y: Math.max(oy, Math.min(oy + h - 1, Math.round(oy + y * h))),
  };
}

const BUTTON = { 0: 'LEFT', 1: 'MIDDLE', 2: 'RIGHT' };

async function handle(evt) {
  if (!nut) return;
  if (evt.kind === 'mouse') {
    const { x, y } = frac(evt.x, evt.y);
    if (evt.op === 'move') return nut.mouse.setPosition(new nut.Point(x, y));
    const btn = nut.Button[BUTTON[evt.button] || 'LEFT'];
    if (evt.op === 'down') {
      await nut.mouse.setPosition(new nut.Point(x, y));
      return nut.mouse.pressButton(btn);
    }
    if (evt.op === 'up') return nut.mouse.releaseButton(btn);
    return;
  }
  if (evt.kind === 'wheel') {
    if (evt.dy) await nut.mouse.scrollDown(Math.round(Math.abs(evt.dy) / 10) * Math.sign(evt.dy));
    if (evt.dx) await nut.mouse.scrollRight(Math.round(Math.abs(evt.dx) / 10) * Math.sign(evt.dx));
    return;
  }
  if (evt.kind === 'key') {
    const key = mapKey(evt.code, evt.key);
    if (!key) return;
    if (evt.op === 'down') return nut.keyboard.pressKey(key);
    if (evt.op === 'up')   return nut.keyboard.releaseKey(key);
  }
}

function mapKey(code, _key) {
  if (!nut) return null;
  const K = nut.Key;
  if (code.startsWith('Key'))   return K[code.slice(3)];
  if (code.startsWith('Digit')) return K['Num' + code.slice(5)];
  if (code.startsWith('Arrow')) return K[code.replace('Arrow', '')];
  if (code.startsWith('F') && /^F\d+$/.test(code)) return K[code];
  const map = {
    Backspace: K.Backspace, Tab: K.Tab, Enter: K.Enter, Escape: K.Escape, Space: K.Space,
    ShiftLeft: K.LeftShift, ShiftRight: K.RightShift,
    ControlLeft: K.LeftControl, ControlRight: K.RightControl,
    AltLeft: K.LeftAlt, AltRight: K.RightAlt,
    MetaLeft: K.LeftSuper, MetaRight: K.RightSuper,
    CapsLock: K.CapsLock, Delete: K.Delete, Insert: K.Insert,
    Home: K.Home, End: K.End, PageUp: K.PageUp, PageDown: K.PageDown,
    Comma: K.Comma, Period: K.Period, Slash: K.Slash, Backslash: K.Backslash,
    Semicolon: K.Semicolon, Quote: K.Quote, BracketLeft: K.LeftBracket, BracketRight: K.RightBracket,
    Minus: K.Minus, Equal: K.Equal, Backquote: K.Grave,
  };
  return map[code] || null;
}

module.exports = { handle, setActiveDisplay, getActiveDisplay };
