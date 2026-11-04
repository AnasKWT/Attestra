/**
 * SchemaEncoder: encodes attestation data for a schema definition, and decodes it back.
 *
 * A definition is a comma-separated list of `type name` fields, for example
 * `string name, u8 level, bool verified, account_id issuer, string[] tags`.
 *
 * Types: `bool`, `u8`, `u16`, `u32`, `u64`, `u128`, `i8`, `i16`, `i32`, `i64`, `i128`, `string`,
 * `account_id`, `bytes`, `bytes32`, and any of these followed by `[]` for a list.
 *
 * Data is the Borsh encoding of the fields in order, so a Rust contract can decode it with
 * `borsh::from_slice::<(String, u8, bool, ...)>`. On the wire (contract JSON) it travels as base64.
 *
 * Decoded values: u8 to u32 and i8 to i32 as numbers, wider integers as decimal strings, bytes and
 * bytes32 as lowercase hex without a prefix.
 */

import { BorshReader, BorshWriter, base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from './borsh';
import type { SchemaFieldDefinition } from './types';

export const BASE_TYPES = [
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'string',
  'account_id',
  'bytes',
  'bytes32',
] as const;

export type BaseType = (typeof BASE_TYPES)[number];

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidSchemaType(type: string): boolean {
  const base = type.endsWith('[]') ? type.slice(0, -2) : type;
  return (BASE_TYPES as readonly string[]).includes(base);
}

/** Parses a definition, throwing a readable error on the first problem (same rules as the contract). */
export function parseSchema(definition: string): SchemaFieldDefinition[] {
  const trimmed = definition.trim();
  if (!trimmed) throw new Error('schema definition is empty');
  const fields: SchemaFieldDefinition[] = [];
  for (const segment of trimmed.split(',')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) throw new Error(`field "${segment.trim()}" must be "type name"`);
    const [type, name] = tokens;
    if (!isValidSchemaType(type)) throw new Error(`unknown type "${type}" for field "${name}"`);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid field name "${name}"`);
    if (fields.some((f) => f.name === name)) throw new Error(`duplicate field name "${name}"`);
    fields.push({ type, name });
  }
  if (fields.length > 256) throw new Error('more than 256 fields');
  return fields;
}

function intInfo(type: string): { bits: number; signed: boolean } | null {
  const m = /^(u|i)(8|16|32|64|128)$/.exec(type);
  return m ? { bits: Number(m[2]), signed: m[1] === 'i' } : null;
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new TypeError(`field "${field}" expects an integer`);
}

function toBytes(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return hexToBytes(value);
  throw new TypeError(`field "${field}" expects bytes (hex string or Uint8Array)`);
}

function writeValue(w: BorshWriter, type: string, value: unknown, field: string): void {
  if (type.endsWith('[]')) {
    if (!Array.isArray(value)) throw new TypeError(`field "${field}" expects a list`);
    w.u32(value.length);
    const inner = type.slice(0, -2);
    value.forEach((v, i) => writeValue(w, inner, v, `${field}[${i}]`));
    return;
  }
  const int = intInfo(type);
  if (int) {
    const n = toBigInt(value, field);
    if (int.signed) w.int(n, int.bits);
    else w.uint(n, int.bits);
    return;
  }
  switch (type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError(`field "${field}" expects true or false`);
      w.bool(value);
      return;
    case 'string':
      if (typeof value !== 'string') throw new TypeError(`field "${field}" expects text`);
      w.string(value);
      return;
    case 'account_id':
      if (typeof value !== 'string' || value.length < 2 || value.length > 64 || !ACCOUNT_ID.test(value)) {
        throw new TypeError(`field "${field}" expects a NEAR account id`);
      }
      w.string(value);
      return;
    case 'bytes':
      w.bytes(toBytes(value, field));
      return;
    case 'bytes32': {
      const b = toBytes(value, field);
      if (b.length !== 32) throw new TypeError(`field "${field}" expects 32 bytes`);
      w.fixed(b);
      return;
    }
    default:
      throw new TypeError(`unknown type ${type}`);
  }
}

function readValue(r: BorshReader, type: string): unknown {
  if (type.endsWith('[]')) {
    const n = r.u32();
    const inner = type.slice(0, -2);
    return Array.from({ length: n }, () => readValue(r, inner));
  }
  const int = intInfo(type);
  if (int) {
    const n = int.signed ? r.int(int.bits) : r.uint(int.bits);
    return int.bits <= 32 ? Number(n) : n.toString();
  }
  switch (type) {
    case 'bool':
      return r.bool();
    case 'string':
    case 'account_id':
      return r.string();
    case 'bytes':
      return bytesToHex(r.bytes());
    case 'bytes32':
      return bytesToHex(r.fixed(32));
    default:
      throw new TypeError(`unknown type ${type}`);
  }
}

function defaultValue(type: string): unknown {
  if (type.endsWith('[]')) return [];
  const int = intInfo(type);
  if (int) return int.bits <= 32 ? 0 : '0';
  switch (type) {
    case 'bool':
      return false;
    case 'bytes':
      return '';
    case 'bytes32':
      return '00'.repeat(32);
    default:
      return '';
  }
}

function jsonSchemaFor(type: string): Record<string, unknown> {
  if (type.endsWith('[]')) return { type: 'array', items: jsonSchemaFor(type.slice(0, -2)) };
  const int = intInfo(type);
  if (int) return int.bits <= 32 ? { type: 'integer' } : { type: 'string', pattern: int.signed ? '^-?\\d+$' : '^\\d+$' };
  if (type === 'bool') return { type: 'boolean' };
  if (type === 'bytes32') return { type: 'string', pattern: '^[0-9a-fA-F]{64}$' };
  if (type === 'bytes') return { type: 'string', pattern: '^([0-9a-fA-F]{2})*$' };
  return { type: 'string' };
}

export class SchemaEncoder {
  readonly fields: SchemaFieldDefinition[];
  private readonly source: string;

  constructor(definition: string) {
    this.source = definition;
    this.fields = parseSchema(definition);
  }

  static parseSchema(definition: string): SchemaFieldDefinition[] {
    return parseSchema(definition);
  }

  get definition(): string {
    return this.source;
  }

  /** Borsh bytes of `values` (every field required). */
  encodeBytes(values: Record<string, unknown>): Uint8Array {
    const w = new BorshWriter();
    for (const f of this.fields) {
      if (!(f.name in values)) throw new Error(`missing field "${f.name}"`);
      writeValue(w, f.type, values[f.name], f.name);
    }
    return w.toBytes();
  }

  /** Base64 of the Borsh bytes: what the contracts accept as `data`. */
  encode(values: Record<string, unknown>): string {
    return bytesToBase64(this.encodeBytes(values));
  }

  /** Decodes base64 (as returned by the contracts) or raw bytes. Throws on trailing bytes. */
  decode(data: string | Uint8Array): Record<string, unknown> {
    const bytes = typeof data === 'string' ? base64ToBytes(data) : data;
    const r = new BorshReader(bytes);
    const out: Record<string, unknown> = {};
    for (const f of this.fields) out[f.name] = readValue(r, f.type);
    if (r.remaining !== 0) throw new Error(`${r.remaining} unexpected trailing bytes`);
    return out;
  }

  /** True when `values` encode without error. */
  validate(values: Record<string, unknown>): boolean {
    try {
      this.encodeBytes(values);
      return true;
    } catch {
      return false;
    }
  }

  generateDefaults(): Record<string, unknown> {
    return Object.fromEntries(this.fields.map((f) => [f.name, defaultValue(f.type)]));
  }

  toJSONSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: Object.fromEntries(this.fields.map((f) => [f.name, jsonSchemaFor(f.type)])),
      required: this.fields.map((f) => f.name),
      additionalProperties: false,
    };
  }
}
