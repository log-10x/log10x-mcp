/**
 * `tenx_hash` — the portable pattern-identity hash.
 *
 * Byte-for-byte reproduction of the engine's PatternHashEncoder
 * (l1x-inc/util/.../hashing/PatternHashEncoder.java). Contract, locked:
 *
 *   xxHash64 (seed 0, == net.openhft zero-allocation-hashing LongHashFunction.xx())
 *   over the UTF-8 bytes  ->  64-bit result serialized big-endian (8 bytes)
 *   ->  base64url (RFC 4648) without padding  ->  always 11 chars.
 *
 * Zero dependency on purpose: a hand-rolled XXH64 vetted by the shared
 * conformance vectors (test/pattern-hash-vectors.json, identical to the
 * engine's JUnit fixture) is more defensible than trusting an npm xxhash
 * port's edge cases, and it can never silently drift from the engine —
 * a mismatch fails the conformance test on both sides.
 *
 * Do NOT change the algorithm, byte order, or encoding. Every deployed
 * tenx_hash filter in a customer SIEM/forwarder, the engine, and this
 * code must all agree forever.
 */

const MASK = (1n << 64n) - 1n;

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

function rotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & MASK;
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + input * P2) & MASK;
  acc = rotl(acc, 31n);
  return (acc * P1) & MASK;
}

function mergeRound(acc: bigint, val: bigint): bigint {
  const v = round(0n, val);
  acc ^= v;
  return ((acc * P1) & MASK) + P4 & MASK;
}

function readLE(bytes: Uint8Array, p: number, n: number): bigint {
  let v = 0n;
  for (let i = 0; i < n; i++) v |= BigInt(bytes[p + i]) << BigInt(8 * i);
  return v;
}

function xxh64(bytes: Uint8Array): bigint {
  const len = bytes.length;
  let h: bigint;
  let p = 0;

  if (len >= 32) {
    let v1 = (P1 + P2) & MASK;
    let v2 = P2;
    let v3 = 0n;
    let v4 = (-P1) & MASK;
    const limit = len - 32;
    do {
      v1 = round(v1, readLE(bytes, p, 8)); p += 8;
      v2 = round(v2, readLE(bytes, p, 8)); p += 8;
      v3 = round(v3, readLE(bytes, p, 8)); p += 8;
      v4 = round(v4, readLE(bytes, p, 8)); p += 8;
    } while (p <= limit);
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = P5;
  }

  h = (h + BigInt(len)) & MASK;

  while (p + 8 <= len) {
    const k1 = round(0n, readLE(bytes, p, 8));
    h = (rotl(h ^ k1, 27n) * P1 + P4) & MASK;
    p += 8;
  }
  if (p + 4 <= len) {
    h = (rotl((h ^ ((readLE(bytes, p, 4) * P1) & MASK)) & MASK, 23n) * P2 + P3) & MASK;
    p += 4;
  }
  while (p < len) {
    h = (rotl((h ^ (BigInt(bytes[p]) * P5)) & MASK, 11n) * P1) & MASK;
    p += 1;
  }

  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  h ^= h >> 32n;
  return h & MASK;
}

/**
 * Compute the `tenx_hash` value for a pattern / symbol-sequence string.
 * Returns the 11-char base64url identifier the engine would emit for the
 * same string.
 */
export function tenxHash(value: string): string {
  const utf8 = Buffer.from(value, 'utf8');
  const h = xxh64(utf8);
  const be = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    be[i] = Number((h >> BigInt(56 - 8 * i)) & 0xffn);
  }
  return be.toString('base64url');
}
