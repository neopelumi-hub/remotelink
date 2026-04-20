// =============================================
// RemoteLink - Input Controller
// Simulates mouse and keyboard input on Windows
// using koffi FFI to call user32.dll directly.
// =============================================

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

// --- Windows API functions ---
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
const mouseEventFn = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, int32 dwData, uintptr dwExtraInfo)');
const keybdEventFn = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)');
const MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');

// --- Mouse event flags ---
const MOUSEEVENTF_LEFTDOWN   = 0x0002;
const MOUSEEVENTF_LEFTUP     = 0x0004;
const MOUSEEVENTF_RIGHTDOWN  = 0x0008;
const MOUSEEVENTF_RIGHTUP    = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP   = 0x0040;
const MOUSEEVENTF_WHEEL      = 0x0800;
const MOUSEEVENTF_HWHEEL     = 0x1000;

// --- Keyboard event flags ---
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP       = 0x0002;

// MapVirtualKey map type
const MAPVK_VK_TO_VSC = 0;

// --- Button flag lookup ---
const MOUSE_DOWN_FLAGS = {
  left:   MOUSEEVENTF_LEFTDOWN,
  right:  MOUSEEVENTF_RIGHTDOWN,
  middle: MOUSEEVENTF_MIDDLEDOWN,
};

const MOUSE_UP_FLAGS = {
  left:   MOUSEEVENTF_LEFTUP,
  right:  MOUSEEVENTF_RIGHTUP,
  middle: MOUSEEVENTF_MIDDLEUP,
};

// --- JavaScript event.code → Windows Virtual Key Code ---
const VK_MAP = {
  // Modifier keys
  ShiftLeft: 0x10, ShiftRight: 0x10,
  ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12,
  MetaLeft: 0x5B, MetaRight: 0x5C,

  // Whitespace / editing
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, NumpadEnter: 0x0D,
  CapsLock: 0x14, Space: 0x20,
  Escape: 0x1B, Pause: 0x13, ScrollLock: 0x91, NumLock: 0x90,

  // Navigation
  Insert: 0x2D, Delete: 0x2E,
  Home: 0x24, End: 0x23,
  PageUp: 0x21, PageDown: 0x22,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  PrintScreen: 0x2C,

  // Digits
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,

  // Letters
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45,
  KeyF: 0x46, KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A,
  KeyK: 0x4B, KeyL: 0x4C, KeyM: 0x4D, KeyN: 0x4E, KeyO: 0x4F,
  KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52, KeyS: 0x53, KeyT: 0x54,
  KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58, KeyY: 0x59,
  KeyZ: 0x5A,

  // Numpad
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63,
  Numpad4: 0x64, Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67,
  Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
  NumpadDecimal: 0x6E, NumpadDivide: 0x6F,

  // Function keys
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,

  // Punctuation / OEM keys
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD,
  Period: 0xBE, Slash: 0xBF, Backquote: 0xC0,
  BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE,
  IntlBackslash: 0xE2,
};

// Keys that require the EXTENDEDKEY flag
const EXTENDED_KEYS = new Set([
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'NumpadEnter', 'NumpadDivide',
  'ControlRight', 'AltRight', 'MetaLeft', 'MetaRight',
  'PrintScreen',
]);

// --- Command handler ---

function handleCommand(data, displayBounds) {
  try {
    switch (data.type) {
      case 'mouse-move':
        moveMouse(data.x, data.y, displayBounds);
        break;
      case 'mouse-down':
        moveMouse(data.x, data.y, displayBounds);
        mouseDown(data.button);
        break;
      case 'mouse-up':
        mouseUp(data.button);
        break;
      case 'mouse-scroll':
        mouseScroll(data.deltaX, data.deltaY);
        break;
      case 'key-down':
        keyDown(data.code);
        break;
      case 'key-up':
        keyUp(data.code);
        break;
    }
  } catch (err) {
    console.error('[InputController] Error handling command:', data.type, err.message);
  }
}

function moveMouse(nx, ny, bounds) {
  if (!bounds || nx === undefined || ny === undefined) return;
  const x = Math.round(bounds.x + nx * bounds.width);
  const y = Math.round(bounds.y + ny * bounds.height);
  SetCursorPos(x, y);
}

function mouseDown(button) {
  const flag = MOUSE_DOWN_FLAGS[button || 'left'];
  if (flag) mouseEventFn(flag, 0, 0, 0, 0);
}

function mouseUp(button) {
  const flag = MOUSE_UP_FLAGS[button || 'left'];
  if (flag) mouseEventFn(flag, 0, 0, 0, 0);
}

function mouseScroll(deltaX, deltaY) {
  // Browser deltaY positive = scroll down; Windows positive = scroll up.
  // Negate deltaY. Pass raw value — Chromium on Windows reports ~100-120 per notch
  // which is close to WHEEL_DELTA (120).
  if (deltaY) {
    mouseEventFn(MOUSEEVENTF_WHEEL, 0, 0, Math.round(-deltaY), 0);
  }
  if (deltaX) {
    mouseEventFn(MOUSEEVENTF_HWHEEL, 0, 0, Math.round(deltaX), 0);
  }
}

function keyDown(code) {
  const vk = VK_MAP[code];
  if (vk === undefined) return;

  const scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  let flags = 0;
  if (EXTENDED_KEYS.has(code)) flags |= KEYEVENTF_EXTENDEDKEY;

  keybdEventFn(vk, scan, flags, 0);
}

function keyUp(code) {
  const vk = VK_MAP[code];
  if (vk === undefined) return;

  const scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  let flags = KEYEVENTF_KEYUP;
  if (EXTENDED_KEYS.has(code)) flags |= KEYEVENTF_EXTENDEDKEY;

  keybdEventFn(vk, scan, flags, 0);
}

module.exports = { handleCommand };
