/**
 * Make a value survive JSON round-tripping: drop `undefined` members, turn
 * non-finite numbers into null, and keep arrays dense. The host rejects any
 * tool output that does not survive that round trip.
 */
export function lossless(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value
  if (Array.isArray(value)) return value.map(lossless)
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue
    out[key] = lossless(child)
  }
  return out
}
