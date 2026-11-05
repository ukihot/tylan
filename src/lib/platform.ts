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
