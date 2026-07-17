import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    _keys: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}

function mockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

const MENU_UPGRADE_FIRST = [
  "You've hit your session limit · resets 6:50pm (Europe/London)",
  'What do you want to do?',
  '❯ 1. Upgrade your plan',
  '  2. Stop and wait for limit to reset',
  'Enter to confirm · Esc to cancel',
].join('\n');

const MENU_WAIT_FIRST = [
  "You've hit your session limit · resets 12:10am (Europe/Dublin)",
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '  2. Upgrade your plan',
  'Enter to confirm · Esc to cancel',
].join('\n');

describe('processOneTick', () => {
  it('returns monitoring when no rate limit', async () => {
    const t = mockTmux('Normal output');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('enters waiting on rate limit', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });

  it('navigates the menu down to "Stop and wait" when "Upgrade" is the default (#19)', async () => {
    const t = mockTmux(MENU_UPGRADE_FIRST);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'menu-confirmed');
    // One Down to move off "Upgrade", then Enter to confirm "Stop and wait".
    assert.deepEqual(t._keys, ['Down', 'Enter']);
    assert.equal(t._sent.length, 0);            // never typed a stray message
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });

  it('confirms directly when "Stop and wait" is already highlighted (#19)', async () => {
    const t = mockTmux(MENU_WAIT_FIRST);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'menu-confirmed');
    assert.deepEqual(t._keys, ['Enter']);       // no navigation needed
    assert.equal(s.status, 'waiting');
  });

  it('does not drive the menu when Claude is not in the foreground (#19 safety)', async () => {
    // Menu is up, but some other app (vim) is focused and the process isn't fg.
    const t = mockTmux(MENU_UPGRADE_FIRST, 'vim', false);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'skipped-not-claude');
    assert.equal(t._keys.length, 0);   // pressed no menu keys
    assert.notEqual(s.status, 'waiting');
  });

  // --- Regression: a menu only quoted in scrollback is NOT the live prompt. Driving
  //     arrow keys + Enter on it would act on whatever is actually on screen. ---
  it('does NOT drive a /rate-limit-options menu only quoted above the live tail', async () => {
    const pane = [...MENU_UPGRADE_FIRST.split('\n'), ...Array(12).fill('● unrelated work below the quoted menu'), '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    const r = await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger());
    assert.notEqual(r, 'menu-confirmed');
    assert.equal(t._keys.length, 0);   // no arrow/Enter keys driven
  });

  it('refuses to press Enter when the menu layout is unreadable (#19)', async () => {
    // Cursor marker absent → we cannot tell which option is highlighted.
    const noCursor = ['What do you want to do?', '  1. Upgrade your plan', '  2. Stop and wait for limit to reset', 'Enter to confirm'].join('\n');
    const t = mockTmux(noCursor);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'menu-unreadable');
    assert.equal(t._keys.length, 0);            // pressed nothing
    assert.equal(t._sent.length, 0);
  });
  it('exits when PID dead', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => false, mockLogger()), 'exit');
  });
  it('sends retry when wait expired and rate limit visible', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.attempts, 1);
    // Should stay in 'waiting' with a cooldown to let Claude process
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('detects multi-line TUI rate limit', async () => {
    const t = mockTmux('⚠ You\'ve hit your limit\n· resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });

  // --- Regression: do not spam an already-resumed session. The usage path used to
  //     re-send every poll (up to maxRetries) while the limit banner lingered in
  //     scrollback after a successful resume — observed live as 5 injections into a
  //     working session. The isWorking gate stops the moment Claude resumes. ---
  it('does NOT re-send once Claude has resumed and is working (2-tick debounce)', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)\n· Doing… (esc to interrupt)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 1;
    // First expiry tick: evidence noted, but not yet declared (debounce).
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    assert.equal(s._continuedPending, true);
    s.waitUntil = Date.now() - 1;
    // Second consecutive tick with the same evidence: declared.
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'user-continued');
    assert.equal(t._sent.length, 0);          // never injects into the working session
    assert.equal(s.status, 'monitoring');
    assert.equal(s.attempts, 0);
  });

  // --- Regression (field report): a single banner-free capture at wait expiry —
  //     repaint, overlay, scrolled transcript — must NOT be read as "user continued";
  //     it silently stopped the monitor from ever sending the retry. ---
  it('cancels a pending user-continued when the banner reappears (transient hide)', async () => {
    const t = mockTmux('nothing that looks limited');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    assert.equal(s._continuedPending, true);
    // Banner is back on the next capture: the pending verdict is cancelled and the
    // normal expired-wait handling (retry) proceeds.
    t.capturePane = async () => '5-hour limit reached - resets 3pm (UTC)';
    s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'retried');
    assert.equal(s._continuedPending, false);
    assert.equal(t._sent.length, 1);
  });

  // --- The persistent-hide case (the debounce alone can't catch it): banner out of
  //     view for good, session never resumed. Output-silence during the wait is the
  //     discriminator — a resumed session (or claude's own reset countdown) produces
  //     output; a stuck one is silent. Silent + hidden banner ⇒ retry, not stand-down.
  it('retries a silent session even when the banner is persistently hidden', async () => {
    const t = mockTmux('❯ ');                        // idle prompt, banner nowhere in view
    const enteredAt = Date.now() - 3600_000;         // wait began an hour ago
    t.lastOutputAt = () => enteredAt + 2_000;        // ...and claude has been silent since
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1000; s._waitEnteredAt = enteredAt;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'retried');
    assert.equal(t._sent.length, 1);                 // the session gets its retry
    assert.equal(s._hiddenBannerRetry, true);        // flagged for the log line
    assert.equal(s.status, 'waiting');
  });

  it('stands down (user-continued) when output flowed during the wait', async () => {
    const t = mockTmux('❯ ');
    const enteredAt = Date.now() - 3600_000;
    t.lastOutputAt = () => Date.now() - 60_000;      // claude produced output mid-wait
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1000; s._waitEnteredAt = enteredAt;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting'); // debounce
    s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'user-continued');
    assert.equal(t._sent.length, 0);
  });

  it('does NOT declare user-continued while the rate-limit menu covers the banner', async () => {
    // Menu without the banner line, and the menu handler in cooldown — the exact
    // window where the old code misread "banner absent" as a resume.
    const t = mockTmux(MENU_UPGRADE_FIRST.split('\n').slice(1).join('\n'));
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    s._menuCooldownUntil = Date.now() + 60_000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    assert.equal(s.status, 'waiting');
    assert.equal(s._continuedPending, false);      // menu ≠ evidence of resume
  });

  // --- Regression: self-referential false positive. A limit banner only quoted in
  //     scrollback (a conversation discussing limits, a stale banner scrolled past) is
  //     NOT the live state. Tail-anchoring stops it from driving a retry. ---
  it('does NOT enter a wait for a limit banner buried above the live tail', async () => {
    const pane = ['You hit your session limit · resets 3pm (UTC)', ...Array(15).fill('● working on unrelated code'), '❯ '].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'monitoring');
    assert.equal(s.status, 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('still enters a wait when the limit banner is in the live tail', async () => {
    const pane = ['earlier output', 'more output', "You've hit your session limit · resets 3pm (UTC)"].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
  });
  it('retries when Claude process is in foreground (fixes macOS zsh issue)', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'zsh', true);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('falls back to pane_current_command when process state is false', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', false);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('falls back to pane_current_command when process state is null', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('accepts custom foregroundCommands in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'my-claude-wrapper', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    const config = { ...DEFAULT_CONFIG, foregroundCommands: ['my-claude-wrapper'] };
    assert.equal(await processOneTick(s, t, '%0', config, () => true, mockLogger()), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('matches npx in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'npx', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'retried');
  });
  it('resets counter when rate limit disappears (after debounce)', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 2;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'user-continued');
    assert.equal(s.attempts, 0);
  });
  it('stops retrying after max attempts and stays in waiting', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 5;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'max-retries');
    // Should stay in 'waiting' to avoid re-detection loop
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
    // Flagged so external consumers (tmux status bar) don't render a perpetually
    // resetting countdown for a monitor that will not send further retries.
    assert.equal(s._gaveUp, true);
  });
  it('resets from max-retries when rate limit clears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 10; s._gaveUp = true;
    // Rate limit cleared → should detect user-continued (after debounce) before
    // the max-retries check.
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'waiting');
    s.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'user-continued');
    assert.equal(s.attempts, 0);
    assert.equal(s._gaveUp, false);
  });
});

describe('processOneTick — manual rescan (F5)', () => {
  it('re-parses the FULL screen and re-arms the wait (banner above an overlay)', async () => {
    // Banner sits ABOVE the 12-line tail (menu/overlay junk below) — normal detection
    // missed it, so the wait fell back. The rescan scans the whole capture.
    const pane = [
      'Please try again in 2 hours',
      ...Array(14).fill('│ menu junk covering the banner │'),
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    s.status = 'waiting';
    s.attempts = 3;
    s.waitUntil = Date.now() + 5 * 3600_000;   // the 5h fallback the user complained about
    s._rescanRequested = true;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'rescan-updated');
    const expected = Date.now() + 2 * 3600_000 + 60_000;   // 2h + margin
    assert.ok(Math.abs(s.waitUntil - expected) < 5_000, `waitUntil ${s.waitUntil} !~ ${expected}`);
    assert.equal(s.status, 'waiting');
    assert.equal(s.attempts, 0);               // manual request refreshes the budget
    assert.equal(s._rescanRequested, false);   // consumed
  });

  it('reports rescan-none and leaves state untouched when no reset text is on screen', async () => {
    const t = mockTmux('just ordinary output, nothing about limits');
    const s = createMonitorState();
    s.status = 'waiting';
    const before = Date.now() + 5 * 3600_000;
    s.waitUntil = before;
    s._rescanRequested = true;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'rescan-none');
    assert.equal(s.waitUntil, before);
    assert.equal(s.status, 'waiting');
    assert.equal(s._rescanRequested, false);
  });

  it('works from plain monitoring too (enters a wait when a banner is found)', async () => {
    const t = mockTmux(['Please try again in 1 hours', ...Array(14).fill('scrolled content')].join('\n'));
    const s = createMonitorState();
    s._rescanRequested = true;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true, mockLogger()), 'rescan-updated');
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
});
