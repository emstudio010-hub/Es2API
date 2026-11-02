/** Start of the ops window, floored to the minute. */
export function opsSince(window = '1h'): string {
  const ms =
    window === '24h' ? 24 * 3600_000 : window === '6h' ? 6 * 3600_000 : 3600_000
  const t = Date.now() - ms
  return new Date(t - (t % 60_000)).toISOString()
}
