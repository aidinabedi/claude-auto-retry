// PTY-backed terminal session — the Windows/cross-platform replacement for tmux.
//
// tmux gave us two things the monitor depends on: a way to READ the rendered screen
// (`capture-pane`) and a way to INJECT keys (`send-keys`). This module provides both
// in-process by hosting Claude inside a pseudo-terminal:
//
//   • @lydell/node-pty spawns Claude in a real PTY (ConPTY on Windows, forkpty on
//     POSIX) so its Ink/React TUI renders exactly as it would in a normal terminal.
//     Prebuilt binaries ship for every platform — no compiler needed at install.
//   • @xterm/headless parses the PTY's raw byte stream into a rendered screen grid,
//     so `capture()` returns the *interpreted* screen (cursor moves, clears and
//     redraws already applied) — the same clean 2D text tmux `capture-pane -p` gave
//     us. Scraping the raw stream directly would accumulate every partial redraw a
//     TUI emits and wreck the tail-anchored detection the monitor relies on.
//
// Unlike tmux, the PTY lives inside the launcher process, so the session cannot
// survive a disconnect (closed terminal, laptop sleep). That trade-off is deliberate
// for this port; the monitor's only job here is to auto-retry while you're away, not
// to persist across sessions.

import * as pty from '@lydell/node-pty';
import xtermPkg from '@xterm/headless';

const { Terminal } = xtermPkg;

// Named-key → escape sequence, for driving the interactive /rate-limit-options menu
// (Up/Down to move the cursor, Enter to confirm). Anything not in the map is written
// verbatim, so a bare character passes through unchanged.
export const KEY_SEQUENCES = {
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Enter: '\r',
  Escape: '\x1b',
  Space: ' ',
  Tab: '\t',
  Backspace: '\x7f',
};

export function keyToSequence(key) {
  return Object.prototype.hasOwnProperty.call(KEY_SEQUENCES, key) ? KEY_SEQUENCES[key] : key;
}

// Submit delay: when submitting a message to an Ink TUI, the text and the Enter must
// be written separately with a brief pause between them. Without it, Ink often folds
// the Enter into the same input burst and inserts a newline instead of submitting, or
// processes the Enter before React has reconciled the text into input state. Same
// rationale (and value) as the old tmux send-keys split — see git history.
export const SUBMIT_DELAY_MS = 150;

// Read the rendered screen from an xterm buffer: the last `lines` rows ending at the
// app's most recent output, ANSI already interpreted, trailing whitespace trimmed.
//
// It ends at the last NON-EMPTY row rather than the viewport's absolute bottom because
// Ink (Claude Code's UI) renders inline — the input box and footer sit wherever the
// content ends, not pinned to the terminal's bottom. On a short session the bottom
// viewport rows are blank, so reading them would miss the banner/footer entirely. This
// yields the live tail the monitor's tail-anchored detection expects, at any session
// length. Pure and terminal-only, so it can be unit-tested without a live PTY.
export function captureFromTerminal(term, lines = 200) {
  const buf = term.buffer.active;
  let end = buf.length - 1;
  while (end > 0) {
    const line = buf.getLine(end);
    if (line && line.translateToString(true).trim() !== '') break;
    end--;
  }
  const start = Math.max(0, end - lines + 1);
  const out = [];
  for (let y = start; y <= end; y++) {
    const line = buf.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
}

// --- Windows console I/O compensation --------------------------------------------
// Two measured mismatches between what the user's console delivers to a Node process
// and what claude (hosted in our inner ConPTY) expects. Both verified empirically by
// probing a live claude session through the PTY (2026-07; see git history / PR notes).
//
// 1. Backspace bytes. Node's Windows console layer (libuv) translates key records
//    using the LEGACY console convention: Backspace arrives as 0x08 and
//    Ctrl+Backspace as 0x7f. Claude Code interprets keys by the xterm convention —
//    0x7f = delete one char, 0x08 = delete a word — so without compensation a plain
//    Backspace deletes a whole word. The inner ConPTY passes both bytes through
//    unchanged, so the fix is a swap at the boundary. The swap is safe in every
//    input mode: neither byte can appear inside a CSI/SGR/win32-input escape
//    sequence (those are all printable ASCII after ESC) or inside a UTF-8
//    multi-byte character (continuation bytes are >= 0x80).
export function swapBackspaceEncoding(s) {
  let out = '';
  for (const ch of s) out += ch === '\b' ? '\x7f' : ch === '\x7f' ? '\b' : ch;
  return out;
}

// 2. Mouse-tracking modes. Claude enables full mouse tracking (?1000/?1002/?1003 +
//    SGR encoding ?1006) and handles wheel/drag itself in a capable terminal. Under
//    the wrapper that contract cannot be honored: libuv silently discards
//    MOUSE_EVENT records from console input, so the events the user's terminal
//    would send us can never reach claude. Forwarding the enables anyway puts the
//    terminal into mouse-reporting mode — killing its native wheel-scrollback and
//    drag-selection — while claude still receives nothing: the worst of both.
//    Stripping them keeps the terminal's native mouse behavior. Everything else
//    (?9001 win32-input, ?1004 focus, ?1049 alt-screen, ?2004 bracketed paste,
//    ?2026 synchronized output, ...) is forwarded untouched.
export const SUPPRESSED_OUTPUT_MODES = new Set(['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016']);

// Streaming filter over PTY output: drops DECSET/DECRST (CSI ? ... h/l) parameters in
// `suppressed`, preserving co-set parameters (\x1b[?1004;1002h -> \x1b[?1004h) and all
// other bytes. Handles sequences split across data chunks by carrying an incomplete
// trailing escape prefix into the next call (bounded, so garbage can't buffer forever).
//
// The returned function also carries a `drain()` method for handing the stream back to
// unfiltered forwarding mid-session (used when the launcher upgrades the console to VT
// input mode and mouse events become deliverable): it returns any held partial escape
// plus the list of suppressed modes currently in the "set" state, so the caller can
// re-emit them and the terminal ends up where claude believes it is.
export function createOutputFilter(suppressed = SUPPRESSED_OUTPUT_MODES) {
  let carry = '';
  const active = new Set();
  const filter = (chunk) => {
    const data = carry + chunk;
    carry = '';
    let out = '';
    let i = 0;
    while (i < data.length) {
      const esc = data.indexOf('\x1b', i);
      if (esc === -1) { out += data.slice(i); break; }
      out += data.slice(i, esc);
      const rest = data.slice(esc);
      if (/^\x1b(?:\[(?:\?[0-9;]*)?)?$/.test(rest)) {
        // Chunk ends inside a potential DECSET/DECRST — hold it for the next chunk
        // (always short: the pattern above can't grow past a few dozen bytes).
        if (rest.length <= 32) { carry = rest; } else { out += rest; }
        break;
      }
      const m = /^\x1b\[\?([0-9;]+)([hl])/.exec(rest);
      if (m) {
        const kept = [];
        for (const p of m[1].split(';')) {
          if (!suppressed.has(p)) { kept.push(p); continue; }
          if (m[2] === 'h') active.add(p); else active.delete(p);
        }
        if (kept.length > 0) out += `\x1b[?${kept.join(';')}${m[2]}`;
        i = esc + m[0].length;
      } else {
        out += '\x1b';
        i = esc + 1;
      }
    }
    return out;
  };
  filter.drain = () => {
    const tail = carry;
    carry = '';
    const activeDropped = [...active];
    active.clear();
    return { tail, activeDropped };
  };
  return filter;
}

// Fallback-regime wheel support: with mouse-tracking stripped and claude in the
// alternate screen, terminals convert wheel notches into arrow-key bursts
// ("alternateScroll") — which claude interprets as input-history navigation, not
// scrolling. A burst is distinguishable from typing: one notch arrives as one chunk of
// 3+ identical arrow sequences, which key repeat (discrete events) never produces.
// Translate such a chunk into PgUp/PgDn (one per notch), which claude scrolls on.
// Returns the replacement string, or null when the chunk isn't a wheel burst.
export function translateAltScroll(s) {
  if (!/^(?:\x1b\[A|\x1bOA)+$/.test(s) && !/^(?:\x1b\[B|\x1bOB)+$/.test(s)) return null;
  const n = s.length / 3;                    // every arrow encoding is 3 chars
  if (n < 3) return null;
  const key = s.includes('A') ? '\x1b[5~' : '\x1b[6~';
  return key.repeat(Math.max(1, Math.round(n / 3)));
}

// Spawn `file args` in a PTY and mirror its output into a headless xterm screen.
// Returns a small session handle the launcher wires to stdio and the monitor scrapes.
export function createPtySession({ file, args = [], cwd, env, cols = 80, rows = 30, scrollback = 5000 }) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  let alive = true;
  let exitInfo = null;
  let lastDataAt = Date.now();
  const dataHandlers = [];
  const exitHandlers = [];

  child.onData((data) => {
    lastDataAt = Date.now();
    term.write(data);
    for (const h of dataHandlers) {
      try { h(data); } catch { /* a bad subscriber must not kill the stream */ }
    }
  });

  child.onExit((info) => {
    alive = false;
    exitInfo = info;
    for (const h of exitHandlers) {
      try { h(info); } catch { /* ignore */ }
    }
  });

  return {
    // ConPTY reports pid 0 for the pseudoconsole, so callers must not rely on pid for
    // liveness — use isAlive()/onExit() instead. Exposed only for diagnostics.
    get pid() { return child.pid; },
    get exitInfo() { return exitInfo; },
    isAlive: () => alive,
    // Timestamp of the last byte claude emitted. The monitor uses this to tell a
    // resumed-then-finished session (produced output during the wait) from a stuck,
    // never-resumed one (byte-for-byte silent) when the limit banner is out of view.
    lastOutputAt: () => lastDataAt,
    onData: (cb) => { dataHandlers.push(cb); },
    onExit: (cb) => { if (!alive && exitInfo) cb(exitInfo); else exitHandlers.push(cb); },
    write: (data) => { try { child.write(data); } catch { /* pty gone */ } },
    resize: (c, r) => {
      try { child.resize(c, r); } catch { /* pty gone */ }
      try { term.resize(c, r); } catch { /* ignore */ }
    },
    kill: (signal) => { try { child.kill(signal); } catch { /* already dead */ } },
    // Replicates `tmux capture-pane -p`: the rendered screen tail, ANSI interpreted.
    capture: (lines = 200) => captureFromTerminal(term, lines),
  };
}
