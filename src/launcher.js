import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPtySession, keyToSequence, SUBMIT_DELAY_MS, swapBackspaceEncoding, createOutputFilter, translateAltScroll } from './pty.js';
import { startInputPump, restoreConsoleMode } from './win-input-pump.js';
import { isRateLimited } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startMonitor } from './monitor.js';
import { readStopFailureEvent, clearStopFailureEvent } from './events.js';

// --- Claude binary resolution ---
// node-pty (and child_process) need a concrete executable. On Windows a launcher is
// usually a real `.exe`, but npm-global installs can leave a `.cmd`/`.bat` shim (which
// must run through cmd.exe) or a `.ps1` (through PowerShell). Classify accordingly so
// the PTY hosts the right thing.
export function classifyClaude(p) {
  if (process.platform === 'win32') {
    const lower = p.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return { file: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c', p] };
    }
    if (lower.endsWith('.ps1')) {
      return { file: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p] };
    }
  }
  return { file: p, prefix: [] };
}

// Resolve the claude command to { file, prefix }. Honors an explicit override, then the
// platform's PATH lookup, then a bare-name fallback.
export function resolveClaude() {
  const override = process.env.CLAUDE_AUTO_RETRY_CLAUDE_BIN;
  if (override) return classifyClaude(override);

  const isWin = process.platform === 'win32';
  try {
    // where.exe / which print candidates one per line; take the first.
    const out = execFileSync(isWin ? 'where.exe' : 'which', ['claude'], { encoding: 'utf-8' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return classifyClaude(first);
  } catch { /* not on PATH, or where/which unavailable — fall through */ }

  return classifyClaude(isWin ? 'claude.exe' : 'claude');
}

export function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

// F5 (or Ctrl+F5) pressed on its own: the manual-rescan hotkey. Intercepted — never
// forwarded to claude — and only when the chunk is exactly the key sequence, so F5
// inside a paste or a burst of other input passes through untouched. Both regimes
// produce these encodings (the pump's Tilde("15") and libuv's translation agree).
export function isRescanKey(s) {
  return s === '\x1b[15~' || s === '\x1b[15;5~';
}


// Build the monitor adapter over a PTY session — the PTY-backed stand-in for the tmux
// adapter the state machine expects. The `pane` argument the state machine passes is
// ignored (there is exactly one PTY); StopFailure markers are keyed by the session id.
export function buildPtyAdapter(session, sessionKey, config) {
  const eventMaxAgeMs = (config.overload?.eventMaxAgeSeconds || 120) * 1000;
  return {
    sessionKey,
    capturePane: async (_pane, lines = 200) => session.capture(lines),
    // We own the PTY and only ever spawn claude in it, so while it is alive claude IS the
    // foreground process. When it exits the PTY closes and the monitor stops — there is no
    // "switched to another app in the same pane" case to guard against as there was in tmux.
    getPaneCommand: async () => (session.isAlive() ? 'claude' : ''),
    isClaudeForeground: async () => session.isAlive(),
    sendKeys: async (_pane, text) => {
      session.write(text);
      await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
      session.write('\r');
    },
    sendKey: async (_pane, key) => { session.write(keyToSequence(key)); },
    readEvent: () => readStopFailureEvent(sessionKey, eventMaxAgeMs),
    clearEvent: () => clearStopFailureEvent(sessionKey),
  };
}

// --- Interactive launch (PTY-hosted, with the auto-retry monitor in-process) ---
export async function launchInteractive(args) {
  const config = await loadConfig();
  const logger = createLogger();
  const { file, prefix } = resolveClaude();
  const sessionKey = `car-${process.pid}-${randomUUID().slice(0, 8)}`;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;

  let session;
  try {
    session = createPtySession({
      file,
      args: [...prefix, ...args],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_AUTO_RETRY_ACTIVE: '1',
        // Inherited by the StopFailure hook (a child of claude) so it can write a
        // marker keyed to this exact session for the monitor to consume.
        CLAUDE_AUTO_RETRY_SESSION: sessionKey,
      },
      cols,
      rows,
    });
  } catch (err) {
    process.stderr.write(`[claude-auto-retry] Failed to start claude: ${err.message}\n`);
    return 1;
  }

  // Windows console I/O fidelity (see src/win-input-pump.js for the full rationale).
  // Node's console layer discards mouse events and mangles key encodings, so on
  // Windows the launcher prefers a native INPUT PUMP — a C# record reader hosted by
  // the in-box PowerShell — as the console's sole input reader, encoding correct
  // xterm bytes for keys AND mouse. Regimes:
  //   'pump'        pump owns input; Node stdin stays paused; mouse modes forwarded,
  //                 so claude's own wheel-scrolling and drag-selection work natively.
  //   'fallback'    pump unavailable/died: Node raw stdin with compensations — swap
  //                 the legacy Backspace bytes, strip mouse-tracking enables (they
  //                 could never be satisfied), and translate the terminal's
  //                 alternateScroll arrow bursts into PgUp/PgDn so the wheel still
  //                 scrolls claude's transcript.
  //   'passthrough' POSIX or CLAUDE_AUTO_RETRY_RAW_IO=1: verbatim byte forwarding.
  const compensate = process.platform === 'win32' && process.env.CLAUDE_AUTO_RETRY_RAW_IO !== '1';
  const stdin = process.stdin;
  const isTTY = !!stdin.isTTY;
  let regime = compensate && isTTY ? 'pending' : 'passthrough';
  let pump = null;

  // Assigned once the monitor starts (below); input handlers only fire afterwards.
  // F5 asks the monitor to re-parse the screen for a missed reset time — see
  // monitor.js's rescan handler. The bell is the only user-visible ack that doesn't
  // disturb claude's rendering.
  let monitor = null;
  const triggerRescan = () => {
    if (!monitor) return;
    monitor.rescan();
    if (process.stdout.isTTY) { try { process.stdout.write('\x07'); } catch { /* ignore */ } }
  };

  // Mirror the PTY output to our real stdout (this is what the user sees — the full
  // TUI). The mouse-strip filter applies while pending and in fallback; in pump regime
  // mouse enables must reach the terminal, so the filter is bypassed after a drain.
  const outputFilter = compensate ? createOutputFilter() : null;
  session.onData((d) => process.stdout.write(outputFilter && regime !== 'pump' ? outputFilter(d) : d));

  // Forward stdin to the PTY in raw mode so every keystroke — including Ctrl+C, which
  // Claude Code interprets as "interrupt turn" rather than "quit" — reaches Claude
  // intact. Attached for 'passthrough' immediately and for 'fallback' on demand; in
  // pump regime Node's stdin is never resumed (the pump must be the only reader).
  const onStdin = (d) => {
    const s = d.toString('utf8');
    if (isRescanKey(s)) { triggerRescan(); return; }
    if (regime !== 'fallback') { session.write(s); return; }
    const scrolled = translateAltScroll(s);
    session.write(scrolled ?? swapBackspaceEncoding(s));
  };
  const attachStdin = () => {
    if (isTTY) { try { stdin.setRawMode(true); } catch { /* ignore */ } }
    stdin.resume();
    stdin.on('data', onStdin);
  };
  if (regime === 'passthrough') attachStdin();

  if (regime === 'pending') {
    // Keyboard is intentionally left dead until the pump verdict (a few seconds at
    // most, fully masked by claude's own startup time). Attaching Node stdin now and
    // detaching later would race the pump for console input records.
    startInputPump().then((p) => {
      if (!session.isAlive()) { if (p) p.kill(); return; }
      if (!p) {
        regime = 'fallback';
        attachStdin();
        logger.warn('Input pump unavailable — using compensation input (Backspace swap, mouse-strip, wheel→PgUp/PgDn).').catch(() => {});
        return;
      }
      pump = p;
      regime = 'pump';
      p.onData((data, resizes) => {
        for (const r of resizes) session.resize(r.cols, r.rows);
        if (!data) return;
        if (isRescanKey(data)) { triggerRescan(); return; }
        session.write(data);
      });
      p.onExit(() => {
        if (regime !== 'pump' || !session.isAlive()) return;
        regime = 'fallback';
        attachStdin();
        logger.warn('Input pump exited — switched to compensation input.').catch(() => {});
      });
      const { tail, activeDropped } = outputFilter.drain();
      const reemit = tail + activeDropped.map((m) => `\x1b[?${m}h`).join('');
      if (reemit) process.stdout.write(reemit);
      logger.info('Native input pump active — full keyboard and mouse fidelity.').catch(() => {});
    }).catch(() => {});
  }

  // Keep the PTY sized to our terminal.
  const onResize = () => session.resize(process.stdout.columns || cols, process.stdout.rows || rows);
  process.stdout.on('resize', onResize);

  // Safety net: if a SIGINT is ever delivered to us (e.g. raw mode unavailable), forward
  // it to Claude as ^C instead of letting it kill the launcher out from under the session.
  const onSigint = () => { session.write('\x03'); };
  process.on('SIGINT', onSigint);

  const adapter = buildPtyAdapter(session, sessionKey, config);
  monitor = startMonitor(adapter, () => session.isAlive(), { config, logger });

  return new Promise((resolve) => {
    session.onExit((info) => {
      monitor.stop();
      // Pump cleanup first: killing it skips the C# loop's own restore, so put the
      // console input mode back to what the pump captured at startup. In pump regime
      // Node never entered raw mode, so there is nothing to setRawMode(false) from —
      // the guard below only unwinds what attachStdin() actually did.
      if (pump) {
        regime = 'exited';
        pump.kill();
        restoreConsoleMode(pump.origMode);
      }
      stdin.off('data', onStdin);
      if (isTTY && regime !== 'exited') { try { stdin.setRawMode(false); } catch { /* ignore */ } }
      stdin.pause();
      process.stdout.off('resize', onResize);
      process.off('SIGINT', onSigint);
      // Best-effort terminal restore. If claude exits cleanly it resets these itself and
      // the sequences are idempotent no-ops; if it crashed mid-render they keep the user's
      // shell usable (cursor shown, input-reporting/paste modes off). All are pure "off"/
      // "show" toggles — none clear the screen or the session's final output.
      if (process.stdout.isTTY) {
        try { process.stdout.write('\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?9001l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m'); } catch { /* ignore */ }
      }
      clearStopFailureEvent(sessionKey).catch(() => {});
      logger.info(`Claude exited (code ${info?.exitCode ?? 0}). Session ${sessionKey} ended.`).catch(() => {});
      resolve(typeof info?.exitCode === 'number' ? info.exitCode : 0);
    });
  });
}

// --- Print / piped mode (`claude -p "…"`) ---
// Non-interactive, so no PTY is needed: buffer output, and if the run was rate-limited,
// discard it, wait, and re-run with the same args. The consumer sees one clean response.
export async function launchPrintMode(args) {
  const { file, prefix } = resolveClaude();
  const config = await loadConfig();
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise((resolve) => {
      const chunks = [];
      const errChunks = [];
      const claude = spawn(file, [...prefix, ...args], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
      });

      claude.stdout.on('data', (d) => chunks.push(d));
      claude.stderr.on('data', (d) => errChunks.push(d));
      claude.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
      claude.on('exit', (code) => resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString(),
        stderr: Buffer.concat(errChunks).toString(),
      }));
    });

    const combined = result.stdout + result.stderr;

    if (!isRateLimited(combined, config.customPatterns)) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return result.code;
    }

    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
      return 1;
    }

    const parsed = parseResetTime(combined);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    process.stderr.write(`[claude-auto-retry] Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry ${retries}/${config.maxRetries}...\n`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Dispatch to the right launch path. Returns the child's exit code.
export async function launch(args) {
  return isPrintMode(args) ? launchPrintMode(args) : launchInteractive(args);
}
