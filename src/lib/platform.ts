// Imperative shell: entropy and time.
export function createId(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  // Rejection sampling avoids modulo bias.
  let suffix = ''
  for (const byte of bytes) {
    if (byte < 248) {
      suffix += alphabet[byte % 62]
    }
  }
  while (suffix.length < 16) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0]!
    if (byte < 248) {
      suffix += alphabet[byte % 62]
    }
  }
  return `${prefix}_${suffix}`
}
export function nowJst() {
  return `${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 19)}+09:00`
}
/** Default audit round name when left blank, e.g. 2026/11/11 (JST). */
export function todayName() {
  return nowJst().slice(0, 10).replaceAll('-', '/')
}
