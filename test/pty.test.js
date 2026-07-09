import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import xtermPkg from '@xterm/headless';
import { keyToSequence, SUBMIT_DELAY_MS, captureFromTerminal, KEY_SEQUENCES, swapBackspaceEncoding, createOutputFilter, translateAltScroll } from '../src/pty.js';

const { Terminal } = xtermPkg;

function newTerm() {
  return new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
}
function write(term, data) {
  return new Promise((res) => term.write(data, res));
}

describe('keyToSequence', () => {
  it('maps named navigation keys to escape sequences (drives the rate-limit menu)', () => {
    assert.equal(keyToSequence('Up'), '\x1b[A');
    assert.equal(keyToSequence('Down'), '\x1b[B');
    assert.equal(keyToSequence('Enter'), '\r');
    assert.equal(keyToSequence('Escape'), '\x1b');
  });
  it('passes unknown keys/strings through verbatim', () => {
    assert.equal(keyToSequence('x'), 'x');
    assert.equal(keyToSequence('continue'), 'continue');
  });
  it('exposes the sequence table', () => {
    assert.equal(KEY_SEQUENCES.Down, '\x1b[B');
  });
});

describe('SUBMIT_DELAY_MS', () => {
  it('is a positive number giving Ink time to reconcile before Enter', () => {
    assert.equal(typeof SUBMIT_DELAY_MS, 'number');
    assert.ok(SUBMIT_DELAY_MS >= 50 && SUBMIT_DELAY_MS <= 1000);
  });
});

describe('captureFromTerminal', () => {
  it('returns the rendered screen tail with ANSI interpreted away', async () => {
    const term = newTerm();
    await write(term, 'line one\r\n\x1b[31mline two (red)\x1b[0m\r\nline three\r\n');
    const cap = captureFromTerminal(term, 5);
    assert.deepEqual(cap.split('\n').filter((l) => l.trim()), ['line one', 'line two (red)', 'line three']);
    assert.ok(!cap.includes('\x1b'), 'no escape sequences remain in captured text');
  });

  it('limits to the last N content rows', async () => {
    const term = newTerm();
    for (let i = 1; i <= 10; i++) await write(term, `row ${i}\r\n`);
    const cap = captureFromTerminal(term, 3);
    assert.deepEqual(cap.split('\n').filter((l) => l.trim()), ['row 8', 'row 9', 'row 10']);
  });

  it('ends at the last non-empty row, not the viewport bottom (short session)', async () => {
    // Only 2 lines written into a 24-row viewport: reading the absolute bottom would
    // return blank rows. We must still surface the actual content.
    const term = newTerm();
    await write(term, "You've hit your limit\r\n· resets 3pm (UTC)\r\n");
    const cap = captureFromTerminal(term, 12);
    const lines = cap.split('\n').filter((l) => l.trim());
    assert.deepEqual(lines, ["You've hit your limit", '· resets 3pm (UTC)']);
  });

  it('collapses a cursor-overwrite redraw instead of accumulating frames', async () => {
    // The core reason we run a real terminal emulator: a TUI redraws by moving the
    // cursor and overwriting, not by appending. A naive strip of the raw byte stream
    // ("stale...\rfresh...") would smear both frames together; the emulator shows only
    // the final rendered text.
    const term = newTerm();
    await write(term, 'stale banner text');
    await write(term, '\rfresh banner text\r\n');
    const cap = captureFromTerminal(term, 3);
    assert.deepEqual(cap.split('\n').filter((l) => l.trim()), ['fresh banner text']);
  });

  it('handles an empty buffer without throwing', () => {
    const term = newTerm();
    assert.equal(typeof captureFromTerminal(term, 5), 'string');
  });
});

describe('swapBackspaceEncoding', () => {
  // The Windows console layer delivers Backspace as 0x08 and Ctrl+Backspace as 0x7f
  // (legacy convention); claude expects the xterm convention (0x7f char / 0x08 word).
  it('maps legacy Backspace 0x08 to xterm 0x7f (single-char delete)', () => {
    assert.equal(swapBackspaceEncoding('\b'), '\x7f');
  });
  it('maps legacy Ctrl+Backspace 0x7f to xterm 0x08 (word delete)', () => {
    assert.equal(swapBackspaceEncoding('\x7f'), '\b');
  });
  it('leaves ordinary text, escape sequences, and multi-byte UTF-8 untouched', () => {
    for (const s of ['hello world', '\x1b[A', '\x1b[8;14;8;1;0;1_', '\x1b[<64;10;10M', 'émoji 🎉', '\x1b[200~pasted\x1b[201~']) {
      assert.equal(swapBackspaceEncoding(s), s);
    }
  });
  it('swaps within mixed content', () => {
    assert.equal(swapBackspaceEncoding('ab\bc\x7f'), 'ab\x7fc\b');
  });
});

describe('createOutputFilter', () => {
  it('strips mouse-tracking DECSET/DECRST (all variants)', () => {
    const f = createOutputFilter();
    for (const seq of ['\x1b[?1000h', '\x1b[?1002h', '\x1b[?1003h', '\x1b[?1006h', '\x1b[?9h', '\x1b[?1000l', '\x1b[?1003l']) {
      assert.equal(createOutputFilter()(seq), '', seq);
    }
    assert.equal(f('before\x1b[?1003hafter'), 'beforeafter');
  });
  it('keeps non-mouse private modes (win32-input, focus, alt-screen, paste, sync)', () => {
    const f = createOutputFilter();
    const s = '\x1b[?9001h\x1b[?1004h\x1b[?1049h\x1b[?2004h\x1b[?2026h\x1b[?25l';
    assert.equal(f(s), s);
  });
  it('preserves co-set parameters when stripping (\\x1b[?1004;1002h)', () => {
    assert.equal(createOutputFilter()('\x1b[?1004;1002h'), '\x1b[?1004h');
    assert.equal(createOutputFilter()('\x1b[?1000;1006h'), '');
  });
  it('reassembles a sequence split across chunks', () => {
    const f = createOutputFilter();
    assert.equal(f('text\x1b[?100'), 'text');
    assert.equal(f('3h\x1b[?25l'), '\x1b[?25l');
  });
  it('carries a bare trailing ESC into the next chunk', () => {
    const f = createOutputFilter();
    assert.equal(f('abc\x1b'), 'abc');
    assert.equal(f('[?1003h rest'), ' rest');
  });
  it('passes SGR colors, cursor moves, and plain text through unchanged', () => {
    const f = createOutputFilter();
    const s = '\x1b[31mred\x1b[0m \x1b[2J\x1b[H plain \x1b]0;title\x07';
    assert.equal(f(s), s);
  });

  it('drain() reports suppressed modes still in the set state (for VT-upgrade re-emit)', () => {
    const f = createOutputFilter();
    f('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1002l');   // 1002 set then reset
    const { tail, activeDropped } = f.drain();
    assert.equal(tail, '');
    assert.deepEqual(activeDropped.sort(), ['1000', '1003', '1006']);
    // Drained state is cleared — a second drain reports nothing.
    assert.deepEqual(f.drain().activeDropped, []);
  });

  it('drain() flushes a held partial escape as tail', () => {
    const f = createOutputFilter();
    assert.equal(f('x\x1b[?100'), 'x');
    const { tail } = f.drain();
    assert.equal(tail, '\x1b[?100');
  });
});

describe('translateAltScroll', () => {
  it('translates a wheel notch (3 identical arrows in one chunk) to one page key', () => {
    assert.equal(translateAltScroll('\x1b[A\x1b[A\x1b[A'), '\x1b[5~');
    assert.equal(translateAltScroll('\x1b[B\x1b[B\x1b[B'), '\x1b[6~');
  });
  it('handles application cursor mode encodings (\\x1bOA)', () => {
    assert.equal(translateAltScroll('\x1bOA\x1bOA\x1bOA'), '\x1b[5~');
  });
  it('scales multiple notches batched into one chunk', () => {
    assert.equal(translateAltScroll('\x1b[A'.repeat(6)), '\x1b[5~\x1b[5~');
  });
  it('leaves single keystrokes and short repeats alone', () => {
    assert.equal(translateAltScroll('\x1b[A'), null);
    assert.equal(translateAltScroll('\x1b[A\x1b[A'), null);
  });
  it('leaves mixed or non-arrow input alone', () => {
    assert.equal(translateAltScroll('\x1b[A\x1b[B\x1b[A'), null);
    assert.equal(translateAltScroll('abc'), null);
    assert.equal(translateAltScroll('\x1b[5~'), null);
  });
});
