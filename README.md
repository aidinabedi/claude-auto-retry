# claude-auto-retry

> Automatically retry Claude Code sessions when you hit Anthropic subscription rate limits.

When Claude Code shows *"5-hour limit reached - resets 3pm"*, this tool waits for the reset and sends "continue" automatically. You come back to find your work done.

**Cross-platform (Windows, macOS, Linux). No tmux. Just install and run `claude-auto-retry`.**

[![npm version](https://img.shields.io/npm/v/claude-auto-retry.svg)](https://www.npmjs.com/package/claude-auto-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

> 💡 **Why wait out the limit at all?** This tool auto-resumes Claude Code the moment you're rate-limited — but if you run overnight jobs or always-on agents, there's a way to stop hitting the wall in the first place. **[See how it's done →](https://cheapestinference.com/blog/claude-code-usage-limit-auto-retry/)**

## The Problem

You're in the middle of a complex task with Claude Code. After a while, you see:

```
You've hit your limit · resets 3pm (Europe/Dublin)
```

Claude stops. You have to wait hours, come back, and type "continue". If you're running long tasks overnight or while AFK, this kills your productivity.

## The Solution

```bash
npm i -g claude-auto-retry
```

Then start Claude Code through the wrapper — everywhere you'd type `claude`, type `claude-auto-retry` instead:

```bash
claude-auto-retry              # instead of: claude
claude-auto-retry --model opus # any claude args pass straight through
```

That's it. When the rate limit hits, the tool:

1. Detects the rate limit message in Claude's output
2. Parses the reset time (timezone-aware)
3. Waits until the limit resets + 60s margin
4. Verifies Claude is still running and idle
5. Sends "continue" automatically

You come back to find your task completed.

## How it Works

`claude-auto-retry` hosts Claude Code inside a **pseudo-terminal (PTY)** in the same
process, so it can watch what Claude renders and type into it — the same two things tmux
used to provide, but built in and cross-platform.

```
You run "claude-auto-retry [args]"
       │
       ▼
  Launcher (one process)
       │
       ├─ Spawns `claude` in a PTY (ConPTY on Windows, forkpty on macOS/Linux)
       │     via @lydell/node-pty — Claude's full TUI renders exactly as normal
       │
       ├─ Wires your keyboard → PTY  and  PTY output → your screen
       │     (you can't tell the difference from running `claude` directly)
       │
       └─ Runs the MONITOR in-process (~0% CPU):
               ├─ Feeds Claude's output into a headless terminal emulator
               │     (@xterm/headless) to get a clean rendered screen
               ├─ Every 5s, scans the screen tail for a rate-limit banner
               ├─ Parses the reset time from the message
               ├─ Waits until reset + safety margin
               ├─ Verifies Claude is still alive and idle
               └─ Types "continue" into the PTY
```

### Why a PTY instead of tmux?

Claude Code is an [Ink](https://github.com/vadimdemedes/ink)/React terminal UI: it needs
a **real terminal** to render and to accept keystrokes. tmux provided one and let the
session survive a disconnect — but tmux doesn't exist on Windows. A PTY gives Claude a
real terminal on every platform (Windows included), and lets the monitor read the screen
and inject keys without any external program.

The trade-off: because the PTY lives inside the launcher process, the session **does not
survive a disconnect** (closing the terminal or sleeping the laptop ends it). If you need
disconnect survival on macOS/Linux, run `claude-auto-retry` inside your own tmux/screen
session — but that is no longer required for the tool to work.

## Features

- **Drop-in** — `claude-auto-retry` forwards all arguments to `claude`; same TUI, same everything
- **Cross-platform** — Windows, macOS, and Linux, from one code path (no tmux, no shell wrapper)
- **No native build step** — `@lydell/node-pty` ships prebuilt binaries for every platform
- **Timezone-aware** — parses reset times with full IANA timezone support (including half-hour offsets)
- **DST-safe** — iterative offset correction handles daylight saving transitions
- **Safe injection** — verifies Claude is still alive and idle before typing "continue"
- **Overload backoff** — detects sustained API overload (`429/500/502/503/504/529`) and retries on a configurable exponential backoff with jitter and a cumulative-wait cap, distinct from the usage-reset path ([details](#overload-backoff))
- **Safeguard retry** — auto-continues past an AUP-safeguard false-positive (often transient), capped at a few tries so a sticky flag can't loop ([details](#safeguard-retry))
- **`--print` mode support** — buffers output, retries cleanly for piped/scripted usage
- **Configurable** — retry count, wait margin, custom patterns, retry message
- **Config validation** — bad config values fall back to safe defaults instead of crashing

## Messages Detected (verbatim)

The tool acts on these real-world Claude Code renders — if you landed here after
pasting one of these errors into a search engine or an AI assistant: yes, this tool
automates the wait-and-retry for all of them.

### Usage / session limits — waits until the printed reset, then continues

| Render | Example |
|--------|---------|
| N-hour limit | `5-hour limit reached - resets 3pm (UTC)` |
| Session limit | `You've hit your session limit · resets 2am (Europe/Zurich)` |
| Weekly limit | `You've hit your weekly limit · resets Oct 9, 10am` |
| Usage limit | `Claude usage limit reached. Resets at 2pm` |
| Out of extra usage | `You're out of extra usage · resets 3pm` |
| Try again | `Please try again in 5 hours` |
| Hit your limit | `You've hit your limit · resets 3pm (Europe/Dublin)` |
| Rate limit | `Rate limit hit. Resets at 4pm` |
| Live-limit companion hint | `/usage-credits to finish what you're working on.` |

### The `/rate-limit-options` menu — driven to "Stop and wait", never "Upgrade"

```
What do you want to do?
❯ 1. Upgrade your plan
  2. Stop and wait for limit to reset (3pm)
```

Handled across any menu layout (the option order varies by Claude Code version); the
tool locates the cursor and the "Stop and wait" option, and refuses to press Enter if
the layout is unreadable.

### API overload / transient errors — exponential backoff with jitter

| Render | Example |
|--------|---------|
| Terminal API error (colon form) | `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` |
| 5xx family | `API Error: 500 / 502 / 503 / 504 …` (including bodyless renders like `503 no healthy upstream`) |
| API-level 429 | `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited` |

### Safeguard false positives — bounded immediate re-send

```
API Error: <model>'s safeguards flagged this message (https://www.anthropic.com/legal/aup).
They may flag safe, normal content as well. … Claude Code can't respond to this request with <model>.
```

Custom patterns can be added via config for future message format changes.

## Configuration

Optional. Create `~/.claude-auto-retry.json`:

```json
{
  "maxRetries": 5,
  "pollIntervalSeconds": 5,
  "marginSeconds": 60,
  "fallbackWaitHours": 5,
  "retryMessage": "Continue where you left off. The previous attempt was rate limited.",
  "customPatterns": ["my custom pattern"]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | `5` | Max retry attempts per rate-limit event |
| `pollIntervalSeconds` | `5` | How often to check the terminal (seconds) |
| `marginSeconds` | `60` | Extra wait after reset time (seconds) |
| `fallbackWaitHours` | `5` | Wait time if reset time can't be parsed |
| `retryMessage` | `"Continue where..."` | Message sent to Claude on retry |
| `customPatterns` | `[]` | Additional regex patterns to detect rate limits |

All fields optional. Invalid values fall back to defaults automatically.

To point at a different `claude` binary (e.g. a specific install or a wrapper), set
`CLAUDE_AUTO_RETRY_CLAUDE_BIN=/path/to/claude`. Otherwise the tool resolves `claude` from
your `PATH` (handling Windows `.exe`/`.cmd`/`.ps1` shims automatically).

On Windows the launcher reads console input through a **native input pump** — a small
C# record reader compiled in-memory by the in-box Windows PowerShell (no SDK, no build
step). Node's own console layer discards mouse events and delivers legacy key
encodings; the pump reads raw `INPUT_RECORD`s instead and encodes correct xterm bytes
for both keys and mouse. Result: Backspace/Ctrl+Backspace behave normally, and claude's
own mouse wheel scrolling and drag-selection work exactly like an unwrapped session.
If the pump can't start (PowerShell missing or blocked, piped stdin), the launcher
falls back to compensations: it swaps the legacy Backspace byte encodings, strips
claude's mouse-tracking requests, and translates wheel-generated arrow bursts into
PgUp/PgDn so the wheel still scrolls the transcript. Set `CLAUDE_AUTO_RETRY_RAW_IO=1`
to disable all of this (raw passthrough).

## Overload backoff

Separate from subscription rate limits, this tool also detects **sustained API
overload** — Claude Code's own terminal `API Error: <code>` line for the retryable
set (`429 / 500 / 502 / 503 / 504 / 529`, or an `overloaded_error` JSON body) — and
retries on an **exponential backoff** instead of waiting for a usage reset. The two
paths never collide; usage limits always take precedence.

> **Sustained only.** Claude Code already retries transient 5xx/529 internally
> with its own backoff. This feature fires only when those internal retries are
> exhausted and a *terminal* error is left on screen. It should rarely trigger.

> **Terminal vs. transient.** Claude Code renders an in-progress retry as the
> *parens* form `API Error (529 …) · Retrying in 5s · attempt 3/10`, and the final
> exhausted error as the *colon* form `API Error: 529 …`. Detection requires the
> colon form **and** suppresses the `· Retrying…` / `attempt n/m` suffix, so the tool
> never interrupts Claude's own backoff.

> **Anchored, tail-only matching (why it won't fire on your code).** Patterns are
> case-insensitive **regexes** matched against only the **last 12 lines** of the
> rendered screen — never the full scrollback. They are anchored to Claude Code's
> `API Error: <code>` render, so a bare `503` in code you're editing (`res.status(503)`),
> a port number, a quoted log, or a `status.claude.com` link in a comment will **not**
> trip detection. The one residual: a live tail that literally contains
> `API Error: 529` (e.g. editing this tool, or docs about Claude errors) will match —
> set `"enabled": false` while doing that. For a structured, ambiguity-free trigger see
> `DESIGN-NOTES.md`.

Configured under an `overload` block (shown with its defaults):

```json
{
  "overload": {
    "enabled": true,
    "patterns": ["API Error:\\s*(429|500|502|503|504|529)\\b", "overloaded_error", "temporarily limiting requests"],
    "backoffSeconds": [30, 60, 120, 240, 300],
    "steadyStateSeconds": 300,
    "jitterPct": 15,
    "maxTotalWaitMinutes": 120,
    "retryMessage": "Continue where you left off.",
    "relaunchOnExit": false,
    "relaunchCommand": "claude --continue"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Turn the overload path on/off |
| `patterns` | (see above) | Case-insensitive **regexes** matching a terminal overload error in the screen tail (last 12 lines) |
| `backoffSeconds` | `[30,60,120,240,300]` | Wait before each retry; index `i` for attempt `i` |
| `steadyStateSeconds` | `300` | Wait once the `backoffSeconds` array is exhausted |
| `jitterPct` | `15` | ±% jitter applied to every wait (clamped 0–100) |
| `maxTotalWaitMinutes` | `120` | Cumulative-wait cap — give up loudly past this |
| `retryMessage` | `"Continue where you left off."` | Sent to Claude on each retry |
| `relaunchOnExit` | `false` | See the gating decision below |
| `relaunchCommand` | `"claude --continue"` | Command used by `relaunchOnExit` |

The waits go `30 → 60 → 120 → 240 → 300 → 300 …`, each with ±15% jitter, until the
error clears (success) or the cumulative wait reaches `maxTotalWaitMinutes` (give
up — the cap guards against hammering a genuinely-down endpoint or masking a real
outage; check [status.claude.com](https://status.claude.com)).

### Event-driven detection (recommended — no scraping)

The scraper above is a heuristic over terminal output. For an exact, ambiguity-free
trigger, install the **`StopFailure` hook** — Claude Code fires it precisely when a
turn ends in an API error, with a typed error class:

```sh
claude-auto-retry install-hook                  # into $CLAUDE_CONFIG_DIR or ~/.claude
claude-auto-retry install-hook /path/to/config  # repeat per CLAUDE_CONFIG_DIR you use
```

This adds a `StopFailure` hook (matcher `overloaded|server_error`) that writes a
session-keyed marker the monitor consumes — no terminal scraping, so it cannot
false-positive on code or scrollback. Sessions launched via `claude-auto-retry` **after**
installing the hook use it automatically; the first marker latches event mode and
disables the scraper for that session. Sessions without the hook (or pre-install) fall
back to the anchored scraper. Remove with `uninstall-hook`. See `DESIGN-NOTES.md` for
the architecture.

> **Why not `rate_limit`?** The event path handles only *transient overloads*
> (seconds-scale backoff). A `rate_limit` is the subscription **session/usage limit** —
> an hours-scale wait until a printed reset time — so it's handled by the usage-wait
> path above, not the overload path. Routing it through the hook would fire premature
> retries against a session that's simply out of quota.

### Gating decision (alive-and-idle vs exited)

A transient API error in interactive Claude Code surfaces inline and leaves the
process **alive at its prompt** — it does not exit. So the default, robust behavior
reuses the existing usage-limit mechanism: only retry when Claude is **alive, idle, and
not working** (the `esc to interrupt` footer is absent). Retrying mid-internal-retry
would double-drive the session, so that case is deferred, never sent.

If a `500` ever causes Claude to exit, the PTY closes and `claude-auto-retry` exits with
it (there is no lingering shell to type into, as there was with tmux). Auto-relaunch is
**off by default**; `relaunchOnExit`/`relaunchCommand` remain configurable for parity but
rarely apply in the single-process model.

## Safeguard retry

A third failure mode, separate from usage limits and 5xx overloads: the model's
**safeguards flag your message** and Claude Code can't respond. It renders like:

```
● API Error: Fable 5's safeguards flagged this message (…/legal/aup). They may flag
  safe, normal content as well. … Claude Code can't respond to this request with Fable 5.
  Double press esc to edit your last message, or try a different model with /model.
```

These flags are **often false positives** (the message says so) and semi-random, so an
immediate re-send frequently clears them. When the tool sees this render at an idle
prompt, it sends a short retry message (`continue` by default), waits a few seconds, and
repeats — but only up to `maxRetries` times, then **gives up loudly** (logged) rather
than looping. A sticky flag means the content/model combination is genuinely blocked;
switch models with `/model` or rephrase.

Detection is tail-anchored (last 12 screen lines) like the overload path, and a match
additionally requires the `API Error` render line nearby — so the phrases appearing in
scrollback or in a conversation *about* safeguards won't trigger it.

Configured under a `safeguard` block (defaults shown):

```json
{
  "safeguard": {
    "enabled": true,
    "patterns": ["safeguards flagged this message", "can't respond to this request with", "legal/aup"],
    "maxRetries": 3,
    "retryDelaySeconds": 8,
    "retryMessage": "continue"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Turn the safeguard-retry path on/off |
| `patterns` | (see above) | Case-insensitive regexes marking the safeguard render (matched in the screen tail, near an `API Error` line) |
| `maxRetries` | `3` | Re-send attempts before giving up — kept small; retrying a sticky flag won't help |
| `retryDelaySeconds` | `8` | Wait between re-sends |
| `retryMessage` | `"continue"` | Message sent to nudge past the flag |

Usage limits always take precedence; the safeguard path only acts when Claude is idle
(no `esc to interrupt` footer).

## CLI Commands

```bash
claude-auto-retry [claude args...]   # Launch Claude Code with the auto-retry monitor
claude-auto-retry -p "..."           # Print/piped mode with transparent retry
claude-auto-retry install-hook       # Install the StopFailure hook (event-driven detection)
claude-auto-retry uninstall-hook     # Remove the StopFailure hook
claude-auto-retry status             # Show recent monitor activity
claude-auto-retry logs               # Follow today's log (Ctrl+C to stop)
claude-auto-retry version            # Print version
claude-auto-retry help               # Show help
```

Only those bareword subcommands are intercepted; **any other invocation is forwarded to
`claude` unchanged** (so `claude-auto-retry --version`, `claude-auto-retry mcp …`, etc.
all reach Claude).

## For AI Agents

If you are an AI agent (Claude Code, Codex, etc.) installing this for your user, the
full setup is non-interactive:

```bash
npm install -g claude-auto-retry
claude-auto-retry install-hook   # recommended: event-driven, scrape-free overload detection
```

Notes for agents:

- There is **no shell wrapper and no `install` step**. The user simply runs
  `claude-auto-retry` in place of `claude`. Suggest aliasing `claude` to
  `claude-auto-retry` in their shell profile if they want the old muscle memory.
- Verify with `claude-auto-retry status` (monitor activity) and `claude-auto-retry logs`.
- Configuration is optional and defaults are safe. To change it, write
  `~/.claude-auto-retry.json` (see [Configuration](#configuration)); invalid values fall
  back to defaults instead of crashing.
- If the user runs multiple `CLAUDE_CONFIG_DIR`s, repeat `claude-auto-retry install-hook <path>` per dir.
- Clean removal: `claude-auto-retry uninstall-hook` and `npm uninstall -g claude-auto-retry`.

## Platform Support

| OS | Status | PTY backend |
|----|--------|-------------|
| Windows 10/11 | Fully supported | ConPTY |
| macOS | Fully supported | forkpty |
| Linux | Fully supported | forkpty |

### Requirements

- **Node.js** >= 18
- **Claude Code** installed and on your `PATH` (or set `CLAUDE_AUTO_RETRY_CLAUDE_BIN`)
- No tmux, no shell configuration, no native compiler — the PTY backend
  (`@lydell/node-pty`) ships prebuilt binaries for every supported platform.

## `--print` Mode

For scripted/piped usage (`claude-auto-retry -p "..." | jq`), the tool:

1. Buffers all output (nothing goes to stdout until done)
2. If rate-limited: discards partial output, waits, re-executes with same args
3. Consumer receives a single clean response

```bash
# This just works — retries transparently if rate-limited
claude-auto-retry -p "Generate a JSON schema" | jq .
```

## Logging

Logs are written to `~/.claude-auto-retry/logs/YYYY-MM-DD.log`:

```
[2026-03-18 15:00:05] [INFO] Monitor started (session car-12345-ab12cd34)
[2026-03-18 15:32:10] [INFO] Rate limit detected: "5-hour limit reached - resets 3pm". Waiting 3547s...
[2026-03-18 16:01:10] [INFO] Sent retry message (attempt 1)
```

Logs rotate daily. Files older than 7 days are cleaned automatically.

## Uninstall

```bash
claude-auto-retry uninstall-hook   # if you installed the StopFailure hook
npm uninstall -g claude-auto-retry
```

## Known Limitations

1. **No disconnect survival** — the session lives in the launcher process, so closing the
   terminal or sleeping the machine ends it. Run inside tmux/screen yourself if you need
   this on macOS/Linux. (This is the deliberate trade for dropping the tmux dependency.)

2. **Retry message context** — The retry message is sent as plain text. If Claude was
   mid-confirmation or in a special input state, it may not interpret it as a
   continuation. You can customize the message via config.

3. **Claude must be on PATH** — resolved once at launch. Set `CLAUDE_AUTO_RETRY_CLAUDE_BIN`
   to override, or if you switch Node/Claude installs.

4. **Mouse on Windows requires the input pump** — claude's own mouse features (wheel
   scrolling, drag-selection inside its UI) work only when the launcher's native input
   pump starts (it normally does; check the log for "Native input pump active"). In
   the fallback regime the wheel scrolls via a PgUp/PgDn translation and your
   terminal's native selection works instead (see [Configuration](#configuration)).

## Contributing

Contributions are welcome! Here's how to get started:

### Development Setup

```bash
git clone https://github.com/cheapestinference/claude-auto-retry.git
cd claude-auto-retry
npm install         # installs the PTY + terminal-emulator deps
npm test            # run the test suite
npm link            # install locally for testing
```

### Project Structure

```
claude-auto-retry/
├── bin/cli.js              # CLI: launch + install-hook/uninstall-hook/status/logs/version
├── src/
│   ├── patterns.js         # Rate limit + overload + safeguard detection + ANSI stripping
│   ├── time-parser.js      # Reset time parsing with timezone support
│   ├── config.js           # Config loading + validation
│   ├── logger.js           # File-based logging with rotation
│   ├── pty.js              # PTY session (node-pty) + headless screen capture (xterm)
│   ├── events.js           # StopFailure hook event channel (session-keyed markers)
│   ├── pane-key.js         # Filename-safe session-key sanitizer
│   ├── monitor.js          # Core monitoring loop + retry logic (usage + overload + safeguard)
│   └── launcher.js         # PTY orchestration, stdio wiring, monitor wiring
├── test/                   # Unit + integration tests
├── package.json
├── LICENSE
└── README.md
```

### Architecture Decisions

- **PTY over tmux** — hosting Claude in an in-process pseudo-terminal works on Windows and
  needs no external program; a headless terminal emulator (`@xterm/headless`) turns the raw
  PTY stream into a clean rendered screen, so detection scrapes an interpreted grid (like
  `tmux capture-pane`) rather than a redraw-laden byte stream.
- **Adapter-driven monitor** — `processOneTick` is written against a small terminal adapter
  interface, so the state machine is platform-independent and unit-testable with a fake
  adapter (and was ported from tmux to PTY without changing its logic).
- **Prebuilt PTY binaries** — `@lydell/node-pty` ships prebuilt binaries for all platforms,
  so `npm i` needs no compiler on Windows.
- **Iterative DST correction** — timezone offset is computed via a 3-iteration convergence
  loop, not a single-shot formula that breaks at DST boundaries.
- **Config validation** — invalid user config values fall back to safe defaults instead of
  producing NaN/undefined behavior.

### Running Tests

```bash
npm test                              # All tests
node --test test/patterns.test.js     # Single file
node --test --watch test/             # Watch mode
```

### Areas for Contribution

- **New rate limit patterns** — If you see a Claude Code rate limit message that isn't detected, open an issue with the exact text.
- **Notification integration** — Desktop/Slack notification when rate limit detected or when Claude resumes.
- **Optional disconnect survival** — a supervised/daemon mode that outlives the launching terminal.

## Related Projects

- [claude-code-queue](https://github.com/JCSnap/claude-code-queue) — Queue-based task system for Claude Code with rate limit handling
- [opencode-claude-quota](https://github.com/nguyenngothuong/opencode-claude-quota) — Rate limit quota monitoring (display only)

## FAQ

**Q: Does this work with Claude Max/Pro/Team?**
A: Yes. It works with any Anthropic subscription that has usage-based rate limits.

**Q: Do I still need tmux?**
A: No. tmux is gone entirely; the tool hosts Claude in its own PTY on every platform, Windows included.

**Q: Does it survive me closing the terminal / the laptop sleeping?**
A: No — that was tmux's job and this port drops it deliberately. If you need it on macOS/Linux, launch `claude-auto-retry` inside your own tmux/screen session.

**Q: What if I continue manually before the retry fires?**
A: The monitor checks if the rate limit is still visible before sending keys. If you already continued, it resets and keeps watching.

**Q: What if Claude exits while the monitor is waiting?**
A: The PTY closes, the monitor stops, and `claude-auto-retry` exits with Claude's exit code.

**Q: Does it consume a lot of resources?**
A: No. Reading the emulated screen is extremely lightweight. The monitor uses ~0% CPU at a 5-second polling interval.

**Q: Can it accidentally type into the wrong program?**
A: The PTY only ever hosts Claude, and the monitor injects only while Claude is alive and idle. There's no separate pane that could be showing another app.

## License

MIT — see [LICENSE](LICENSE) for details.

---

Made with care by [CheapestInference](https://github.com/cheapestinference).
