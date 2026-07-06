// Shared filename-sanitizer for pane-keyed marker/status files.
//
// tmux pane ids (e.g. "%2") and other free-form keys derived from them need to become
// safe filename components. Previously this one-line rule was copy-pasted into
// events.js, status-file.js, and the `tr` call in bin/tmux-status.sh — three places
// that all had to be kept in sync by hand. Centralizing the JS-side copies here so
// there is exactly one definition to update.
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, '_');
}
