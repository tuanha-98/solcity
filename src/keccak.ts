// Keccak-256, the hash Ethereum uses for function selectors, storage slots and address checksums.
// Kept small rather than fast (64-bit lanes as BigInt): solcity only hashes a few hundred short strings.

const MASK = (1n << 64n) - 1n
const rotl = (x: bigint, n: number) => (n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK : x)

// round constants (the LFSR of the Keccak reference) and the rotation offset of each lane
const RC: bigint[] = []
const ROT = new Array<number>(25).fill(0)
{
  let r = 1
  for (let round = 0; round < 24; round++) {
    let c = 0n
    for (let j = 0; j < 7; j++) {
      r = ((r << 1) ^ ((r >> 7) * 0x71)) & 0xff
      if (r & 2) c ^= 1n << ((1n << BigInt(j)) - 1n)
    }
    RC.push(c)
  }
  for (let t = 0, x = 1, y = 0; t < 24; t++) {
    ROT[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64
    ;[x, y] = [y, (2 * x + 3 * y) % 5]
  }
}

/** Keccak-f[1600] on 25 lanes, lane (x, y) at index x + 5y. */
function permute(s: bigint[]) {
  const c = new Array<bigint>(5)
  const b = new Array<bigint>(25)
  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d
    }
    // ρ and π
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y])
    // χ
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & b[((x + 2) % 5) + y] & MASK)
    // ι
    s[0] ^= RC[round]
  }
}

/** Keccak-256 of some bytes. (`pad` 0x06 instead of 0x01 gives SHA3-256, which tests this against node:crypto.) */
export function keccak256(data: Uint8Array, pad = 0x01): Uint8Array {
  const RATE = 136
  const len = (Math.floor(data.length / RATE) + 1) * RATE
  const buf = new Uint8Array(len)
  buf.set(data)
  buf[data.length] ^= pad
  buf[len - 1] ^= 0x80
  const s = new Array<bigint>(25).fill(0n)
  for (let off = 0; off < len; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(buf[off + 8 * i + k])
      s[i] ^= lane
    }
    permute(s)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number((s[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn)
  return out
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** keccak256 of a UTF-8 string, as hex without 0x */
export const keccakText = (s: string) => toHex(keccak256(new TextEncoder().encode(s)))

/** 4-byte function selector: selector('token0()') = '0x0dfe1681' */
export const selector = (signature: string) => `0x${keccakText(signature).slice(0, 8)}`

/** EIP-55 mixed-case form of an address */
export function checksum(address: string) {
  const a = address.toLowerCase().replace(/^0x/, '')
  const h = keccakText(a)
  return `0x${[...a].map((ch, i) => (parseInt(h[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('')}`
}
