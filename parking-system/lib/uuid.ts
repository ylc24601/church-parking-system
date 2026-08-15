// Canonical UUID format check for request-body identifiers (Phase 9 Slice 1). Job
// routes must reject a present-but-malformed explicit eventId with a 400 rather than
// let it fall through to a DB error — or worse, silently fall back to server-side
// event resolution, which would hide a scheduler misconfiguration.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuidFormat(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
