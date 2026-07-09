// Native Windows console input pump.
//
// Node's console layer (libuv) is the wrong reader for a terminal middleman: it
// discards MOUSE_EVENT records outright, translates keys using the legacy console
// convention (Backspace arrives as 0x08), and console VT-input synthesis can't be
// relied on to fix that — measured in the field: the user's conhost accepted
// ENABLE_VIRTUAL_TERMINAL_INPUT but never synthesized, silently breaking both keys
// and mouse. INPUT_RECORDs, by contrast, are the representation every conhost
// version delivers reliably.
//
// So: a small C# loop — compiled in-memory by the in-box Windows PowerShell
// (Add-Type; no SDK, no build step, no new dependency) — opens CONIN$ directly,
// reads raw INPUT_RECORDs, and encodes xterm bytes itself:
//   keys   -> correct VT encodings (VK_BACK -> 0x7f, Ctrl+Backspace -> 0x08,
//             arrows/nav/F-keys -> CSI/SS3 with modifiers, Alt -> ESC prefix,
//             chars via UTF-8 incl. surrogate pairs; VT bytes the terminal relays
//             as plain char records flow through unchanged)
//   mouse  -> SGR sequences (ESC[<b;x;yM/m): wheel, buttons, drag, motion — so
//             claude's own wheel-scrolling and drag-selection work natively
//   focus  -> ESC[I / ESC[O
//   resize -> an APC sentinel (ESC _car:resize;COLS;ROWS ESC \) the launcher
//             consumes to resize the inner PTY (with Node's stdin paused, libuv
//             never sees console events, so process.stdout 'resize' won't fire)
//
// The pump is the console's ONLY reader while active — the launcher must never
// resume process.stdin in pump mode, or the two readers would race for records.
// The pump sets its own console mode (window+mouse input, extended flags with
// QuickEdit off, no processed input so ^C reaches claude as 0x03) and reports the
// original mode in its ready sentinel so the launcher can restore it at exit.

import { spawn } from 'node:child_process';

const PUMP_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class Pump {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr se, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);
  [StructLayout(LayoutKind.Explicit)]
  public struct REC {
    [FieldOffset(0)]  public ushort EventType;
    // KEY_EVENT_RECORD
    [FieldOffset(4)]  public int    KeyDown;
    [FieldOffset(8)]  public ushort Repeat;
    [FieldOffset(10)] public ushort VK;
    [FieldOffset(12)] public ushort SC;
    [FieldOffset(14)] public ushort ChRaw;
    [FieldOffset(16)] public uint   Ctrl;
    // MOUSE_EVENT_RECORD overlay
    [FieldOffset(4)]  public short  MX;
    [FieldOffset(6)]  public short  MY;
    [FieldOffset(8)]  public uint   Btn;
    [FieldOffset(12)] public uint   MCtrl;
    [FieldOffset(16)] public uint   MFlags;
    // WINDOW_BUFFER_SIZE_RECORD / FOCUS_EVENT_RECORD overlay
    [FieldOffset(4)]  public short  WX;
    [FieldOffset(6)]  public short  WY;
    [FieldOffset(4)]  public int    Focus;
  }
  [DllImport("kernel32.dll")]
  static extern bool ReadConsoleInputW(IntPtr h, [Out] REC[] r, uint len, out uint n);

  const string ESC = "\u001b";
  static uint prevBtn = 0;
  static char hiSur = '\0';

  static int ModNum(uint cs) {
    int m = 1;
    if ((cs & 0x0010u) != 0) m += 1;                    // shift
    if ((cs & 0x0003u) != 0) m += 2;                    // alt
    if ((cs & 0x000Cu) != 0) m += 4;                    // ctrl
    return m;
  }
  static string Letter(string fin, uint cs) {           // Home/End/arrows: CSI [1;m] X
    int m = ModNum(cs);
    return m > 1 ? ESC + "[1;" + m + fin : ESC + "[" + fin;
  }
  static string Tilde(string num, uint cs) {            // nav/F5+: CSI num [;m] ~
    int m = ModNum(cs);
    return m > 1 ? ESC + "[" + num + ";" + m + "~" : ESC + "[" + num + "~";
  }
  static string Fn(string ss3, uint cs) {               // F1-F4: SS3 X, or CSI 1;m X
    int m = ModNum(cs);
    return m > 1 ? ESC + "[1;" + m + ss3 : ESC + "O" + ss3;
  }
  static string Key(REC r) {
    uint cs = r.Ctrl;
    bool ctrl = (cs & 0x000Cu) != 0;
    bool alt  = (cs & 0x0003u) != 0;
    switch (r.VK) {
      case 0x08: return ctrl ? "\b" : "\u007f";     // Backspace <-> Ctrl+Backspace
      case 0x09: return (cs & 0x0010u) != 0 ? ESC + "[Z" : "\t";
      case 0x0D: return alt ? ESC + "\r" : "\r";
      case 0x1B: return ESC;
      case 0x21: return Tilde("5", cs);
      case 0x22: return Tilde("6", cs);
      case 0x23: return Letter("F", cs);
      case 0x24: return Letter("H", cs);
      case 0x25: return Letter("D", cs);
      case 0x26: return Letter("A", cs);
      case 0x27: return Letter("C", cs);
      case 0x28: return Letter("B", cs);
      case 0x2D: return Tilde("2", cs);
      case 0x2E: return Tilde("3", cs);
      case 0x70: return Fn("P", cs);
      case 0x71: return Fn("Q", cs);
      case 0x72: return Fn("R", cs);
      case 0x73: return Fn("S", cs);
      case 0x74: return Tilde("15", cs);
      case 0x75: return Tilde("17", cs);
      case 0x76: return Tilde("18", cs);
      case 0x77: return Tilde("19", cs);
      case 0x78: return Tilde("20", cs);
      case 0x79: return Tilde("21", cs);
      case 0x7A: return Tilde("23", cs);
      case 0x7B: return Tilde("24", cs);
    }
    char c = (char)r.ChRaw;
    if (c == '\0') return "";
    string s;
    if (char.IsHighSurrogate(c)) { hiSur = c; return ""; }
    if (char.IsLowSurrogate(c) && hiSur != '\0') { s = new string(new char[]{ hiSur, c }); hiSur = '\0'; }
    else { s = c.ToString(); }
    // Ctrl+letter already arrives as the control byte in the char; Alt adds ESC.
    return alt ? ESC + s : s;
  }
  static string Mouse(REC r) {
    int x = r.MX + 1, y = r.MY + 1;
    uint fl = r.MFlags;
    if ((fl & 0x0004u) != 0) {                          // vertical wheel
      bool up = ((short)(r.Btn >> 16)) > 0;
      return ESC + "[<" + (up ? 64 : 65) + ";" + x + ";" + y + "M";
    }
    if ((fl & 0x0008u) != 0) return "";                 // horizontal wheel: skip
    uint changed = r.Btn ^ prevBtn;
    if (changed != 0) {
      string o = "";
      if ((changed & 1u) != 0) o += ESC + "[<0;" + x + ";" + y + ((r.Btn & 1u) != 0 ? "M" : "m");
      if ((changed & 2u) != 0) o += ESC + "[<2;" + x + ";" + y + ((r.Btn & 2u) != 0 ? "M" : "m");
      if ((changed & 4u) != 0) o += ESC + "[<1;" + x + ";" + y + ((r.Btn & 4u) != 0 ? "M" : "m");
      prevBtn = r.Btn;
      return o;
    }
    if ((fl & 0x0001u) != 0) {                          // motion (drag or hover)
      int b = (r.Btn & 1u) != 0 ? 32 : (r.Btn & 4u) != 0 ? 33 : (r.Btn & 2u) != 0 ? 34 : 35;
      return ESC + "[<" + b + ";" + x + ";" + y + "M";
    }
    return "";
  }
  public static void Run() {
    IntPtr h = CreateFileW("CONIN$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
    uint orig; GetConsoleMode(h, out orig);
    // ENABLE_WINDOW_INPUT | ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS (QuickEdit off).
    // No processed input (^C flows as 0x03), no line/echo, no VT synthesis (we encode).
    SetConsoleMode(h, 0x0098u);
    Stream o = Console.OpenStandardOutput();
    Encoding u8 = new UTF8Encoding(false);
    REC[] buf = new REC[64];
    byte[] b = u8.GetBytes(ESC + "_car:ready;" + orig + ESC + "\\");
    o.Write(b, 0, b.Length); o.Flush();
    while (true) {
      uint n;
      if (!ReadConsoleInputW(h, buf, (uint)buf.Length, out n) || n == 0) break;
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < (int)n; i++) {
        REC r = buf[i];
        if (r.EventType == 1) {
          if (r.KeyDown != 0) {
            int rep = r.Repeat > 1 ? r.Repeat : 1;
            for (int k = 0; k < rep; k++) sb.Append(Key(r));
          }
        }
        else if (r.EventType == 2) sb.Append(Mouse(r));
        else if (r.EventType == 4) sb.Append(ESC + "_car:resize;" + r.WX + ";" + r.WY + ESC + "\\");
        else if (r.EventType == 16) sb.Append(r.Focus != 0 ? ESC + "[I" : ESC + "[O");
      }
      if (sb.Length > 0) { b = u8.GetBytes(sb.ToString()); o.Write(b, 0, b.Length); o.Flush(); }
    }
  }
}
"@
[Pump]::Run()
`;

// Sentinels the pump embeds in its byte stream (APC ... ST — never produced by real
// terminal input, so they can't collide with keystrokes).
const READY_RE = /\x1b_car:ready;(\d+)\x1b\\/;
const RESIZE_RE = /\x1b_car:resize;(-?\d+);(-?\d+)\x1b\\/g;

// Split a pump stream chunk into { data, resizes[], ready, origMode } with a carry for
// a sentinel split across chunk boundaries (rare — pump writes are small and atomic —
// but a split sentinel would otherwise be typed into claude as literal text). Pure.
export function createPumpParser() {
  let carry = '';
  return (chunk) => {
    let data = carry + chunk;
    carry = '';
    // Incomplete trailing sentinel? Hold from its start. A trailing bare ESC is NOT
    // held — it is far more likely the user's Escape key (latency matters for claude's
    // double-ESC binding) than a torn sentinel, given the pump's small atomic writes.
    const start = data.lastIndexOf('\x1b_');
    if (start !== -1 && data.indexOf('\x1b\\', start + 2) === -1 && data.length - start <= 40) {
      carry = data.slice(start);
      data = data.slice(0, start);
    }
    const resizes = [];
    let ready = false;
    let origMode = null;
    data = data.replace(new RegExp(READY_RE.source, 'g'), (_, m) => {
      ready = true;
      origMode = parseInt(m, 10);
      return '';
    });
    data = data.replace(RESIZE_RE, (_, c, r) => {
      resizes.push({ cols: parseInt(c, 10), rows: parseInt(r, 10) });
      return '';
    });
    return { data, resizes, ready, origMode };
  };
}

// Fire-and-forget: restore the console input mode the pump captured at startup. Used
// at session exit — killing the pump skips its cleanup (TerminateProcess), and the
// launcher never entered raw mode itself in pump regime, so nothing else restores it.
export function restoreConsoleMode(mode) {
  if (process.platform !== 'win32' || typeof mode !== 'number') return;
  const script = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CM {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr se, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);
  public static void Restore(uint m) { SetConsoleMode(CreateFileW("CONIN$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero), m); }
}
"@
[CM]::Restore(${mode})
`;
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // Same console-inheritance requirement as the pump spawn: no windowsHide.
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore', detached: false,
    });
    ps.unref();
  } catch { /* best-effort */ }
}

// Start the pump. Resolves { origMode, onData, onExit, kill } once the pump reports
// ready, or null if it fails to start/compile/report within timeoutMs (caller falls
// back to the Node-stdin compensation regime).
export function startInputPump({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let ps;
    try {
      const encoded = Buffer.from(PUMP_PS, 'utf16le').toString('base64');
      // NOTE: no windowsHide — CREATE_NO_WINDOW would give PowerShell its OWN hidden
      // console instead of inheriting ours, and the pump would read an empty CONIN$
      // forever. Plain inheritance opens no new window (the parent already has one).
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return resolve(null); }

    const parser = createPumpParser();
    const dataHandlers = [];
    const exitHandlers = [];
    let ready = false;

    const handle = {
      origMode: null,
      onData: (cb) => dataHandlers.push(cb),
      onExit: (cb) => exitHandlers.push(cb),
      kill: () => { try { ps.kill(); } catch { /* ignore */ } },
    };

    const timer = setTimeout(() => {
      if (!ready) { handle.kill(); resolve(null); }
    }, timeoutMs);

    ps.stdout.on('data', (d) => {
      const { data, resizes, ready: sawReady, origMode } = parser(d.toString('utf8'));
      if (sawReady && !ready) {
        ready = true;
        handle.origMode = origMode;
        clearTimeout(timer);
        resolve(handle);
      }
      if (!ready) return;
      if (data || resizes.length) {
        for (const h of dataHandlers) { try { h(data, resizes); } catch { /* ignore */ } }
      }
    });
    ps.on('error', () => { clearTimeout(timer); if (!ready) resolve(null); });
    ps.on('exit', () => {
      clearTimeout(timer);
      if (!ready) { resolve(null); return; }
      for (const h of exitHandlers) { try { h(); } catch { /* ignore */ } }
    });
  });
}
