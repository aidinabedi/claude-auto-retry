import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSafeguard, safeguardMatch, isWorking } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_SAFEGUARD } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

const PATS = DEFAULT_SAFEGUARD.patterns;

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => claudeForeground,
  };
  return t;
}

function cfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, safeguard: { ...DEFAULT_SAFEGUARD, ...overrides } };
}

// The real render, verbatim-ish.
const FLAG = [
  '❯ continue',
  '',
  "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). They may flag safe, normal content as well. Claude Code can't respond to this request with Fable 5.",
  '  Double press esc to edit your last message, or try a different model with /model.',
  '  Request ID: req_011Ccfhw8avogXF48ed42Xjt',
  '❯ ',
].join('\n');

describe('detectSafeguard', () => {
  it('matches the safeguards-flagged render', () => assert.equal(detectSafeguard(FLAG, PATS), true));
  it('matches the "can\'t respond to this request with" phrasing next to the API Error line', () =>
    assert.equal(detectSafeguard([
      "● API Error: Fable 5's safeguards flagged this message",
      "  (https://www.anthropic.com/legal/aup). Claude Code can't respond to this request with Fable 5.",
    ].join('\n'), PATS), true));
  it('matches a wrapped render (phrase on a different physical line than "API Error")', () =>
    assert.equal(detectSafeguard([
      '● API Error: Fable',
      "  5's safeguards flagged",
      '  this message (https://www.anthropic.com/legal/aup).',
    ].join('\n'), PATS), true));
  it('is case-insensitive', () =>
    assert.equal(detectSafeguard('API ERROR: SAFEGUARDS FLAGGED THIS MESSAGE', PATS), true));
  it('does NOT fire on the phrases without the API Error render nearby (anti false-positive anchor)', () => {
    // Regression: Claude ANSWERING a question about AUP flags must not trigger a retry.
    assert.equal(detectSafeguard('see https://www.anthropic.com/legal/aup for the policy', PATS), false);
    assert.equal(detectSafeguard("Claude Code can't respond to this request with Opus 4.8.", PATS), false);
    assert.equal(detectSafeguard('they said safeguards flagged this message yesterday', PATS), false);
  });
  it('returns false for normal output', () => assert.equal(detectSafeguard('Here is the refactor you asked for.', PATS), false));
  it('returns false for empty patterns/text', () => {
    assert.equal(detectSafeguard(FLAG, []), false);
    assert.equal(detectSafeguard('', PATS), false);
  });
  it('does NOT fire on the phrase quoted far up in scrollback (tail-anchored)', () => {
    const pane = ['discussing safeguards flagged this message', ...Array(15).fill('● unrelated work'), '❯ '].join('\n');
    assert.equal(detectSafeguard(pane, PATS), false);
  });
  it('reports the matched pattern + line', () => {
    const m = safeguardMatch(FLAG, PATS);
    assert.ok(m && /safeguards flagged/.test(m.pattern));
    assert.ok(m.line.length <= 200);
  });
});

describe('safeguard config validation', () => {
  async function loadFrom(obj) {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-sg-${Date.now()}-${Math.round(Math.random() * 1e6)}.json`);
    await writeFile(f, JSON.stringify(obj));
    try { return await loadConfig(f); } finally { await unlink(f); }
  }
  it('is present on DEFAULT_CONFIG with a small retry cap', () => {
    assert.equal(DEFAULT_CONFIG.safeguard.enabled, true);
    assert.equal(DEFAULT_CONFIG.safeguard.maxRetries, 3);
    assert.ok(DEFAULT_CONFIG.safeguard.patterns.includes('safeguards flagged this message'));
  });
  it('merges a partial block onto defaults', async () => {
    const c = await loadFrom({ safeguard: { maxRetries: 1 } });
    assert.equal(c.safeguard.maxRetries, 1);
    assert.deepEqual(c.safeguard.patterns, DEFAULT_SAFEGUARD.patterns);
  });
  it('falls back on bad values', async () => {
    const c = await loadFrom({ safeguard: { maxRetries: -1, retryDelaySeconds: 0, patterns: [42] } });
    assert.equal(c.safeguard.maxRetries, DEFAULT_SAFEGUARD.maxRetries);
    assert.equal(c.safeguard.retryDelaySeconds, DEFAULT_SAFEGUARD.retryDelaySeconds);
    assert.deepEqual(c.safeguard.patterns, DEFAULT_SAFEGUARD.patterns);
  });
});

const near = (actual, expectedMs) => Math.abs(actual - expectedMs) < 2000;

describe('processOneTick — safeguard path', () => {
  it('enters the safeguard wait on detection (no send yet)', async () => {
    const t = mockTmux(FLAG);
    const s = createMonitorState();
    const r = await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(r, 'safeguard-detected');
    assert.equal(s.status, 'safeguard');
    assert.equal(t._sent.length, 0);
    assert.ok(near(s.safeguardWaitUntil - Date.now(), DEFAULT_SAFEGUARD.retryDelaySeconds * 1000));
  });

  it('sends the retry once the delay elapses', async () => {
    const t = mockTmux(FLAG);
    const s = createMonitorState();
    s.status = 'safeguard'; s.safeguardWaitUntil = Date.now() - 1;
    const r = await processOneTick(s, t, '%0', cfg(), () => true);
    assert.equal(r, 'safeguard-retried');
    assert.equal(t._sent[0], 'continue');
    assert.equal(s.safeguardAttempts, 1);
  });

  it('is BOUNDED — gives up after maxRetries instead of looping', async () => {
    const t = mockTmux(FLAG);
    const s = createMonitorState();
    const c = cfg({ maxRetries: 2, retryDelaySeconds: 1 });
    // detect
    await processOneTick(s, t, '%0', c, () => true);
    // two retries
    for (let i = 0; i < 2; i++) { s.safeguardWaitUntil = Date.now() - 1; await processOneTick(s, t, '%0', c, () => true); }
    assert.equal(s.safeguardAttempts, 2);
    assert.equal(t._sent.length, 2);
    // third pass → give up, no further send
    s.safeguardWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'safeguard-gave-up');
    assert.equal(t._sent.length, 2);
  });

  it('clears back to monitoring when the flag is gone', async () => {
    const t = mockTmux('All good — here is your answer.');
    const s = createMonitorState();
    s.status = 'safeguard'; s.safeguardWaitUntil = Date.now() - 1; s.safeguardAttempts = 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'safeguard-cleared');
    assert.equal(s.status, 'monitoring');
    assert.equal(s.safeguardAttempts, 0);
  });

  it('defers while Claude is working — WITHOUT resetting the attempt counter', async () => {
    // Regression: a tick landing while the retried request is in flight used to reset
    // safeguardAttempts to 0 via the clear path, so a sticky flag re-entered with a fresh
    // budget every cycle and the maxRetries bound never tripped (observed: 10+ sends with
    // maxRetries=3). Mirror the overload branch: defer without consuming or resetting.
    const t = mockTmux(FLAG + '\n✻ Thinking… (esc to interrupt)');
    const s = createMonitorState();
    s.status = 'safeguard'; s.safeguardWaitUntil = Date.now() - 1; s.safeguardAttempts = 2;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'safeguard-working');
    assert.equal(s.safeguardAttempts, 2);   // NOT reset
    assert.equal(s.status, 'safeguard');    // still owns the flag
    assert.equal(t._sent.length, 0);
  });

  it('stays BOUNDED even when working ticks interleave between retries (sticky flag)', async () => {
    const c = cfg({ maxRetries: 2, retryDelaySeconds: 1 });
    const flagged = mockTmux(FLAG);
    const s = createMonitorState();
    await processOneTick(s, flagged, '%0', c, () => true);            // detect
    let sent = 0;
    for (let i = 0; i < 10; i++) {
      // alternate: retry tick at idle-with-flag, then a mid-flight (working) tick
      s.safeguardWaitUntil = Date.now() - 1;
      const idle = mockTmux(FLAG);
      const r1 = await processOneTick(s, idle, '%0', c, () => true);
      sent += idle._sent.length;
      s.safeguardWaitUntil = Date.now() - 1;
      const working = mockTmux(FLAG + '\n✻ Thinking… (esc to interrupt)');
      await processOneTick(s, working, '%0', c, () => true);
      sent += working._sent.length;
      if (r1 === 'safeguard-gave-up' || r1 === 'safeguard-holding') break;
    }
    assert.equal(sent, 2);                  // exactly maxRetries sends, ever
    assert.equal(s.safeguardAttempts, 2);
  });

  it('gives up loudly ONCE, then holds quietly', async () => {
    const c = cfg({ maxRetries: 1 });
    const t = mockTmux(FLAG);
    const s = createMonitorState();
    s.status = 'safeguard'; s.safeguardWaitUntil = Date.now() - 1; s.safeguardAttempts = 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'safeguard-gave-up');
    s.safeguardWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', c, () => true), 'safeguard-holding');
    assert.equal(t._sent.length, 0);
  });

  it('does not inject into a healthy session whose reply mentions the AUP link at an idle prompt', async () => {
    // Regression: unanchored patterns fired on Claude ANSWERING a question about AUP flags.
    const pane = [
      '● The safeguard error you saw means the model flagged the message. See',
      '  https://www.anthropic.com/legal/aup for the policy. It can be a false positive.',
      '',
      '❯ ',
    ].join('\n');
    const t = mockTmux(pane);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });

  it('does not send into a non-claude foreground', async () => {
    const t = mockTmux(FLAG, 'vim', false);
    const s = createMonitorState();
    s.status = 'safeguard'; s.safeguardWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
  });

  it('usage-limit takes precedence over a co-present safeguard flag', async () => {
    const t = mockTmux(FLAG + '\nYou\'ve hit your session limit · resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'waiting');
    assert.equal(s.status, 'waiting');
  });

  it('does not enter safeguard while Claude is working', async () => {
    const t = mockTmux(FLAG + '\n· Cooking… (esc to interrupt)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg(), () => true), 'monitoring');
  });

  it('disabled safeguard block is ignored', async () => {
    const t = mockTmux(FLAG);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', cfg({ enabled: false }), () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
});
