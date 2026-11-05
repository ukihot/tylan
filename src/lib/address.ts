// Pure parsers: no DNS resolution or network access.
export function ipNumber(value: string): { value: bigint; bits: 32 | 128 } | null {
  if (!value.includes(':')) {
    const parts = value.split('.')
    if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || +p > 255)) {
      return null
    }
    return { value: parts.reduce((n, p) => (n << 8n) + BigInt(p), 0n), bits: 32 }
  }
  let ip = value.toLowerCase()
  if (ip.includes('.')) {
    const colon = ip.lastIndexOf(':')
    const tail = ipNumber(ip.slice(colon + 1))
    if (tail?.bits !== 32) {
      return null
    }
    ip =
      ip.slice(0, colon) +
      ':' +
      (tail.value >> 16n).toString(16) +
      ':' +
      (tail.value & 65535n).toString(16)
  }
  if (!/^[0-9a-f:]+$/.test(ip) || ip.split('::').length > 2) {
    return null
  }
  const [left = '', right = ''] = ip.split('::')
  const a = left ? left.split(':') : []
  const b = right ? right.split(':') : []
  const compressed = ip.includes('::')
  if ((compressed && a.length + b.length >= 8) || (!compressed && a.length !== 8)) {
    return null
  }
  const parts = compressed ? [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b] : a
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) {
    return null
  }
  return { value: parts.reduce((n, p) => (n << 16n) + BigInt(`0x${p}`), 0n), bits: 128 }
}
export function parseCidr(cidr: string) {
  const [address, prefix, extra] = cidr.split('/')
  const ip = ipNumber(address ?? '')
  if (
    !ip ||
    extra !== undefined ||
    !/^(0|[1-9]\d*)$/.test(prefix ?? '') ||
    Number(prefix) > ip.bits
  ) {
    return null
  }
  return { ...ip, prefix: Number(prefix) }
}
export function inCidr(address: string, cidr: string) {
  const ip = ipNumber(address)
  const net = parseCidr(cidr)
  return (
    !!ip &&
    !!net &&
    ip.bits === net.bits &&
    ip.value >> BigInt(ip.bits - net.prefix) === net.value >> BigInt(net.bits - net.prefix)
  )
}
export function inRange(address: string, range: { start: string; end: string }) {
  const ip = ipNumber(address)
  const a = ipNumber(range.start)
  const b = ipNumber(range.end)
  return (
    !!ip &&
    !!a &&
    !!b &&
    ip.bits === a.bits &&
    a.bits === b.bits &&
    a.value <= ip.value &&
    ip.value <= b.value
  )
}
