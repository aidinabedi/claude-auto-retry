import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeKey } from '../src/pane-key.js';

describe('sanitizeKey', () => {
  it('passes through an already-safe key unchanged', () => {
    assert.equal(sanitizeKey('abc-123_XYZ'), 'abc-123_XYZ');
  });

  it('replaces tmux pane-id punctuation with underscores', () => {
    assert.equal(sanitizeKey('%2'), '_2');
  });

  it('replaces path separators (e.g. a socket path) with underscores', () => {
    assert.equal(sanitizeKey('/tmp/tmux-1000/default'), '_tmp_tmux-1000_default');
  });

  it('coerces non-string input via String()', () => {
    assert.equal(sanitizeKey(42), '42');
  });
});
