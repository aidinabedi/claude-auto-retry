// Shared filename-sanitizer for session-keyed marker files.
//
// A session key (e.g. "car-12345-ab12cd34") is a free-form string that must become a
// safe filename component before it is used to name a StopFailure marker file. Kept in
// one place so there is exactly one definition to update.
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, '_');
}
