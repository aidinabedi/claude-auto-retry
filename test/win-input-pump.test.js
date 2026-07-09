import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPumpParser } from '../src/win-input-pump.js';

describe('createPumpParser', () => {
  it('passes plain input bytes through', () => {
    const p = createPumpParser();
    const { data, resizes, ready } = p('hello \x1b[A\x1b[<64;10;10M');
    assert.equal(data, 'hello \x1b[A\x1b[<64;10;10M');
    assert.deepEqual(resizes, []);
    assert.equal(ready, false);
  });

  it('extracts the ready sentinel with the original console mode', () => {
    const p = createPumpParser();
    const { data, ready, origMode } = p('\x1b_car:ready;503\x1b\\');
    assert.equal(ready, true);
    assert.equal(origMode, 503);
    assert.equal(data, '');
  });

  it('extracts resize sentinels and removes them from the data', () => {
    const p = createPumpParser();
    const { data, resizes } = p('abc\x1b_car:resize;120;44\x1b\\def');
    assert.equal(data, 'abcdef');
    assert.deepEqual(resizes, [{ cols: 120, rows: 44 }]);
  });

  it('reassembles a sentinel split across chunks', () => {
    const p = createPumpParser();
    const first = p('xy\x1b_car:resi');
    assert.equal(first.data, 'xy');
    assert.deepEqual(first.resizes, []);
    const second = p('ze;80;24\x1b\\z');
    assert.equal(second.data, 'z');
    assert.deepEqual(second.resizes, [{ cols: 80, rows: 24 }]);
  });

  it('does NOT hold back a bare trailing ESC (Escape-key latency)', () => {
    const p = createPumpParser();
    assert.equal(p('\x1b').data, '\x1b');
  });

  it('flushes an over-long fake sentinel prefix as data', () => {
    const p = createPumpParser();
    const junk = '\x1b_car:' + 'x'.repeat(60);
    assert.equal(p(junk).data, junk);
  });
});
