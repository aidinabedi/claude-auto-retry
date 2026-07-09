# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-07-09

Cross-platform port — Windows, macOS, and Linux via an in-process PTY, replacing tmux.

### Changed (BREAKING)
- **No more tmux.** Claude Code now runs inside an in-process pseudo-terminal
  (`@lydell/node-pty` — ConPTY on Windows, forkpty on macOS/Linux), and its rendered
  screen is read via a headless terminal emulator (`@xterm/headless`). Together these are
  the cross-platform replacement for `tmux capture-pane` + `send-keys`. Works natively on
  Windows.
- **Run `claude-auto-retry` instead of `claude`.** The shell wrapper that overrode the
  `claude` command is gone, and so are the `install` / `uninstall` steps. All arguments
  are forwarded straight to `claude`; only a few bareword subcommands (`install-hook`,
  `uninstall-hook`, `status`, `logs`, `version`, `help`) are intercepted.
- The monitor now runs inside the launcher process — no detached daemon, no per-pane
  status files. StopFailure markers are keyed by a session id (`CLAUDE_AUTO_RETRY_SESSION`)
  instead of a tmux pane id.
- Introduces two runtime dependencies (`@lydell/node-pty`, `@xterm/headless`), both shipping
  prebuilt binaries (no compiler needed on install). The project is no longer
  zero-dependency.

### Removed
- tmux support and auto-install; the `claude`-overriding shell wrapper and its
  `install`/`uninstall` commands; the tmux status-bar indicator and the
  `claude-auto-retry-tmux-status` binary.
- **Disconnect survival.** The session no longer outlives its terminal (that was tmux's
  role). Launch `claude-auto-retry` inside tmux/screen yourself on macOS/Linux if you need
  it.

### Added
- Native Windows support (ConPTY), plus a `CLAUDE_AUTO_RETRY_CLAUDE_BIN` environment
  override for locating the `claude` binary (handles `.exe`/`.cmd`/`.ps1` shims).
- Best-effort terminal restore on exit (show cursor, disable focus/paste/win32-input
  modes) so a crashed session can't leave the shell in a broken state.
- Safeguard/AUP false-positive auto-retry: when the model's safeguards flag a
  message ("safeguards flagged this message"), re-send a short retry up to
  `safeguard.maxRetries` times, then give up loudly once. Detection is anchored
  to the `API Error` render (mentioning the phrases in conversation can't
  trigger it), and the retry budget is kept across working ticks so a sticky
  flag stays bounded (#33).

### Fixed
- Windows keyboard/mouse fidelity under the wrapper. Two measured root causes: Node's
  console layer delivers keys in the legacy byte convention (Backspace=`0x08`,
  Ctrl+Backspace=`0x7f`) while Claude Code expects the xterm convention — so Backspace
  deleted a whole word — and it silently discards mouse events, so claude's
  mouse-tracking modes (which it enables to handle wheel/drag itself) could never be
  satisfied, leaving both claude's and the terminal's mouse handling dead. (Console
  VT-input synthesis proved unreliable as a fix: one conhost accepted
  `ENABLE_VIRTUAL_TERMINAL_INPUT` without ever synthesizing.) The launcher now reads
  console input through a **native input pump** — a C# `ReadConsoleInput` loop compiled
  in-memory by the in-box Windows PowerShell — which encodes xterm bytes from raw
  `INPUT_RECORD`s: keys (VK_BACK→`0x7f`, arrows/nav/F-keys with modifiers, Alt as ESC
  prefix, UTF-8 incl. surrogate pairs), mouse as SGR (wheel/buttons/drag/motion), focus
  events, and window resizes (as sentinels that resize the inner PTY). Backspace and
  Ctrl+Backspace behave normally and claude's own wheel-scrolling and drag-selection
  work as in an unwrapped session. When the pump can't start (no PowerShell, piped
  stdin), the launcher falls back to compensations: swap the two backspace bytes, strip
  mouse-tracking modes, and translate alternateScroll arrow bursts into PgUp/PgDn so
  the wheel still scrolls the transcript. `CLAUDE_AUTO_RETRY_RAW_IO=1` disables all of
  this (raw passthrough).
- `rate_limit` StopFailure events are no longer routed through the seconds-scale
  overload path — a session/usage limit is an hours-scale wait owned by the
  usage path, and the misroute made the two fight (futile `Continue` retries
  into a session-limited session). The marker error type is validated at the
  consumer too, so an outdated installed hook can't reintroduce it (#31).

## [0.5.1] - 2026-06-30

**Upgrade if you installed `0.5.0` from npm.** The `0.5.0` npm artifact was built
before #29 was merged and shipped without the usage-retry anti-spam fix. `0.5.1`
includes it. (The git tag `v0.5.0` already contained #29; only the npm tarball was
behind.)

### Fixed
- Stop the usage-retry path from spamming an already-resumed session: a lingering
  limit banner in scrollback no longer re-injects `Continue…` every poll. Detection
  is now anchored to the live tail, and an `isWorking` gate stops the moment Claude
  resumes (#29).

## [0.5.0] - 2026-06-30

This release rolls up everything merged since `0.2.2`, including the API
overload backoff engine and interactive `/rate-limit-options` menu navigation.

### Added
- Detect sustained API overload (`529`/`500`/`503`) and retry with exponential
  backoff, including an event-driven (`StopFailure`) mode (#20, hardened).
- Interactive navigation of the `/rate-limit-options` menu, driving it to
  "Stop and wait" across any menu layout (#19, #26).
- Enable mouse scroll and vi copy-mode in tmux sessions created by the tool (#25).

### Fixed
- Require Claude to be in the foreground before driving the
  `/rate-limit-options` menu, preventing keystrokes from leaking into the wrong
  pane (#28).
- Reliable retry submission plus session/weekly rate-limit detection (#7, #15, #22).
- Correct an off-by-a-day wait when parsing reset times in offset timezones (#6, #23).
- Unalias `claude` before defining the wrapper, fixing a zsh/bash `source` error (#10, #24).
- Skip send-keys correctly when the foreground process is the shell, not Claude (#1).

## [0.2.2] - 2026-03-31

- Last published baseline release.
