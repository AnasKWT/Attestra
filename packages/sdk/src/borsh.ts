/**
 * A small Borsh writer and reader: exactly what the Attestra contracts use for UIDs, attestation
 * data and signed digests. Integers are little endian; strings and byte vectors carry a u32
 * length; fixed arrays (bytes32) carry none; `Option` is a 0/1 tag.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class BorshWriter {
  private chunks: Uint8Array[] = [];
  private size = 0;

  private push(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.size += bytes.length;
    return this;
  }

  u8(v: number): this {
    return this.push(Uint8Array.of(v & 0xff));
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  /** Unsigned integer of `bits` (8 to 128) bits. */
  uint(v: bigint | number, bits: number): this {
    let n = BigInt(v);
    const max = (1n << BigInt(bits)) - 1n;
    if (n < 0n || n > max) throw new RangeError(`value ${v} does not fit in u${bits}`);
    const out = new Uint8Array(bits / 8);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return this.push(out);
  }

  /** Signed (two's complement) integer of `bits` bits. */
  int(v: bigint | number, bits: number): this {
    const n = BigInt(v);
    const half = 1n << BigInt(bits - 1);
    if (n < -half || n >= half) throw new RangeError(`value ${v} does not fit in i${bits}`);
    return this.uint(n < 0n ? (1n << BigInt(bits)) + n : n, bits);
  }

  u32(v: number): this {
    return this.uint(v, 32);
  }

  u64(v: bigint | number): this {
    return this.uint(v, 64);
  }

  /** Raw bytes with no length prefix (fixed arrays such as bytes32). */
  fixed(bytes: Uint8Array): this {
    return this.push(bytes);
  }

  /** Bytes with a u32 length prefix (`Vec<u8>`). */
  bytes(bytes: Uint8Array): this {
    this.u32(bytes.length);
    return this.push(bytes);
  }

  string(s: string): this {
    return this.bytes(textEncoder.encode(s));
  }

  option<T>(v: T | null | undefined, write: (w: this, v: T) => void): this {
    if (v === null || v === undefined) return this.u8(0);
    this.u8(1);
    write(this, v);
    return this;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) throw new RangeError('unexpected end of data');
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new RangeError(`invalid bool byte ${b}`);
    return b === 1;
  }

  uint(bits: number): bigint {
    const bytes = this.take(bits / 8);
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
  }

  int(bits: number): bigint {
    const n = this.uint(bits);
    const half = 1n << BigInt(bits - 1);
    return n >= half ? n - (1n << BigInt(bits)) : n;
  }

  u32(): number {
    return Number(this.uint(32));
  }

  fixed(n: number): Uint8Array {
    return this.take(n).slice();
  }

  bytes(): Uint8Array {
    return this.take(this.u32()).slice();
  }

  string(): string {
    return textDecoder.decode(this.bytes());
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export { textEncoder };
