import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvocation, MANAGEMENT_COMMANDS, stopFailureHookEntry } from '../bin/cli.js';
import { isRescanKey } from '../src/launcher.js';

describe('parseInvocation', () => {
  it('routes reserved barewords to management commands', () => {
    for (const cmd of ['install-hook', 'uninstall-hook', 'status', 'logs', 'version', 'help']) {
      const { command, args } = parseInvocation([cmd]);
      assert.equal(command, cmd);
      assert.deepEqual(args, []);
    }
  });

  it('passes the trailing args to a management command', () => {
    const { command, args } = parseInvocation(['install-hook', '/custom/config']);
    assert.equal(command, 'install-hook');
    assert.deepEqual(args, ['/custom/config']);
  });

  it('forwards a bare launch (no args) to claude', () => {
    const { command, args } = parseInvocation([]);
    assert.equal(command, null);
    assert.deepEqual(args, []);
  });

  it('forwards claude flags verbatim (not intercepted as our commands)', () => {
    for (const argv of [['-p', 'hello'], ['--print'], ['--version'], ['--help'], ['--model', 'opus']]) {
      const { command, args } = parseInvocation(argv);
      assert.equal(command, null, `should forward ${argv.join(' ')}`);
      assert.deepEqual(args, argv);
    }
  });

  it('forwards unknown claude subcommands verbatim (e.g. config, mcp)', () => {
    const { command, args } = parseInvocation(['config', 'set', 'x', 'y']);
    assert.equal(command, null);
    assert.deepEqual(args, ['config', 'set', 'x', 'y']);
  });

  it('only intercepts the reserved word in the FIRST position', () => {
    // "status" as an argument to claude, not our status command.
    const { command, args } = parseInvocation(['-p', 'status']);
    assert.equal(command, null);
    assert.deepEqual(args, ['-p', 'status']);
  });
});

describe('MANAGEMENT_COMMANDS', () => {
  it('is the exact reserved set (no install/uninstall — those were tmux-era)', () => {
    assert.deepEqual(
      [...MANAGEMENT_COMMANDS].sort(),
      ['_stopfailure-hook', 'clear-logs', 'help', 'install-hook', 'logs', 'status', 'uninstall-hook', 'version'].sort(),
    );
  });
});

describe('isRescanKey', () => {
  it('matches a lone F5 / Ctrl+F5 chunk', () => {
    assert.equal(isRescanKey('\x1b[15~'), true);
    assert.equal(isRescanKey('\x1b[15;5~'), true);
  });
  it('does not match F5 embedded in other input (paste, bursts)', () => {
    assert.equal(isRescanKey('a\x1b[15~'), false);
    assert.equal(isRescanKey('\x1b[15~\x1b[15~'), false);
    assert.equal(isRescanKey('\x1b[17~'), false);   // F6
    assert.equal(isRescanKey('hello'), false);
  });
});

describe('stopFailureHookEntry', () => {
  it('matches only the transient-overload classes, never rate_limit', () => {
    const entry = stopFailureHookEntry();
    assert.equal(entry.matcher, 'overloaded|server_error');
    assert.ok(!entry.matcher.includes('rate_limit'));
  });
  it('runs our hook handler via node with a quoted path', () => {
    const entry = stopFailureHookEntry();
    const cmd = entry.hooks[0].command;
    assert.match(cmd, /^node ".+" _stopfailure-hook$/);
    assert.equal(entry.hooks[0].type, 'command');
  });
});
