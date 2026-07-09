#!/usr/bin/env node

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync, watchFile, unwatchFile } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeStopFailureEvent, isRetryableError } from '../src/events.js';
import { launch } from '../src/launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Internal subcommand Claude Code invokes as the StopFailure hook (see cmdInstallHook).
const HOOK_MARKER = '_stopfailure-hook';

// Bareword subcommands claude-auto-retry owns. Everything else — including all flags
// like `-p`, `--model`, `--version` — is forwarded verbatim to `claude`, so the tool is
// a drop-in `claude` replacement. Only these exact first-argument barewords are
// intercepted (hyphenated hook names and uncommon words, to minimize collisions).
export const MANAGEMENT_COMMANDS = new Set([
  'install-hook', 'uninstall-hook', 'status', 'logs', 'clear-logs', 'version', 'help', HOOK_MARKER,
]);

// Split argv into a management command (or null → launch claude) plus its args.
export function parseInvocation(argv) {
  const first = argv[0];
  if (first !== undefined && MANAGEMENT_COMMANDS.has(first)) {
    return { command: first, args: argv.slice(1) };
  }
  return { command: null, args: argv };
}

const LOG_DIR = join(homedir(), '.claude-auto-retry', 'logs');
function todayLogFile() {
  return join(LOG_DIR, `${new Date().toISOString().split('T')[0]}.log`);
}

// --- status / logs ---

async function cmdStatus() {
  const logFile = todayLogFile();
  try {
    const content = await readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    console.log(`Log file: ${logFile}\n`);
    console.log('Last 10 entries:');
    console.log(lines.slice(-10).join('\n'));
  } catch {
    console.log('No activity today. Log directory:', LOG_DIR);
  }
}

// Delete all monitor log files. Only `.log` files inside the tool's own log directory
// are touched — never the directory itself or anything else in it.
async function cmdClearLogs() {
  let entries;
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    console.log(`No logs to clear (${LOG_DIR} does not exist).`);
    return;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    try { await unlink(join(LOG_DIR, name)); removed++; } catch { /* in use or gone */ }
  }
  console.log(removed > 0 ? `Removed ${removed} log file(s) from ${LOG_DIR}.` : `No log files in ${LOG_DIR}.`);
}

// Node-based `tail -f` (portable — no `tail` on Windows). Prints the current contents,
// then follows appends until Ctrl+C. watchFile polls, which is reliable across platforms.
async function cmdLogs() {
  const logFile = todayLogFile();
  let printed = 0;
  const flush = async () => {
    try {
      const content = await readFile(logFile, 'utf-8');
      if (content.length > printed) {
        process.stdout.write(content.slice(printed));
        printed = content.length;
      }
    } catch { /* not created yet — keep waiting */ }
  };
  if (!existsSync(logFile)) console.log(`Waiting for today's log: ${logFile}`);
  await flush();
  watchFile(logFile, { interval: 1000 }, flush);
  process.on('SIGINT', () => { unwatchFile(logFile); process.exit(0); });
  await new Promise(() => {}); // run until Ctrl+C
}

// --- StopFailure hook (event-driven overload trigger) ---

function resolveConfigDir(arg) {
  return arg || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function stopFailureHookEntry() {
  // Matcher filters on the StopFailure error type; only the transient-overload classes.
  // rate_limit is intentionally omitted — a session/usage limit is an hours-scale wait
  // owned by the scraper usage path, not a seconds-scale event retry (see src/events.js).
  // The path is quoted so a Windows install path containing spaces still parses.
  return {
    matcher: 'overloaded|server_error',
    hooks: [{ type: 'command', command: `node "${__filename}" ${HOOK_MARKER}`, timeout: 5 }],
  };
}

// Invoked BY Claude Code on a turn-ending API error. Reads the hook JSON on stdin and,
// for a retryable error, writes a session-keyed marker the monitor consumes. Must never
// disrupt the session: StopFailure output/exit is ignored, and we swallow all errors.
async function cmdStopFailureHook() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const session = process.env.CLAUDE_AUTO_RETRY_SESSION;
    if (session && isRetryableError(payload.error)) {
      await writeStopFailureEvent(session, payload);
    }
  } catch { /* swallow — never break the host session */ }
  process.exit(0);
}

async function cmdInstallHook(dirArg) {
  const settingsPath = join(resolveConfigDir(dirArg), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf-8')); } catch { /* new file */ }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const existing = Array.isArray(settings.hooks.StopFailure) ? settings.hooks.StopFailure : [];
  // Idempotent: drop any prior entry pointing at our handler, then add the current one.
  const kept = existing.filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
  kept.push(stopFailureHookEntry());
  settings.hooks.StopFailure = kept;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`StopFailure hook installed in ${settingsPath}`);
  console.log('New sessions launched via claude-auto-retry will use event-driven detection.');
}

async function cmdUninstallHook(dirArg) {
  const settingsPath = join(resolveConfigDir(dirArg), 'settings.json');
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    if (Array.isArray(settings.hooks?.StopFailure)) {
      settings.hooks.StopFailure = settings.hooks.StopFailure.filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
      if (settings.hooks.StopFailure.length === 0) delete settings.hooks.StopFailure;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    console.log(`StopFailure hook removed from ${settingsPath}`);
  } catch { console.log('No settings file to modify.'); }
}

async function cmdVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

function cmdHelp() {
  console.log('claude-auto-retry - Auto-retry Claude Code on subscription rate limits & API overload\n');
  console.log('Usage:');
  console.log('  claude-auto-retry [claude args...]   Launch Claude Code with the auto-retry monitor');
  console.log('                                       (drop-in replacement for `claude`)');
  console.log('  claude-auto-retry -p "..."           Print/piped mode with transparent retry\n');
  console.log('Management commands:');
  console.log('  claude-auto-retry install-hook [dir] Install the StopFailure hook (event-driven');
  console.log('                                       overload detection) into <dir>/settings.json');
  console.log('                                       (default: $CLAUDE_CONFIG_DIR or ~/.claude)');
  console.log('  claude-auto-retry uninstall-hook [dir]  Remove the StopFailure hook');
  console.log('  claude-auto-retry status             Show recent monitor activity');
  console.log('  claude-auto-retry logs               Follow today\'s log (Ctrl+C to stop)');
  console.log('  claude-auto-retry clear-logs         Delete all monitor log files');
  console.log('  claude-auto-retry version            Print version');
  console.log('  claude-auto-retry help               Show this help\n');
  console.log('Any other invocation is forwarded to `claude` unchanged.');
}

// --- Main ---
async function main() {
  const { command, args } = parseInvocation(process.argv.slice(2));

  switch (command) {
    case 'install-hook': await cmdInstallHook(args[0]); break;
    case 'uninstall-hook': await cmdUninstallHook(args[0]); break;
    case HOOK_MARKER: await cmdStopFailureHook(); break;
    case 'status': await cmdStatus(); break;
    case 'logs': await cmdLogs(); break;
    case 'clear-logs': await cmdClearLogs(); break;
    case 'version': await cmdVersion(); break;
    case 'help': cmdHelp(); break;
    default: {
      // Not a management command → run claude with all args, forwarding its exit code.
      const code = await launch(args);
      process.exit(code);
    }
  }
}

// Run only when executed directly (`claude-auto-retry ...` or the hook), never when a
// test imports this module for its exported helpers.
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
