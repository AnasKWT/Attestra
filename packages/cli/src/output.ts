/**
 * Output for every command: `--json` prints `{ success, data | error, tx_hash }` (parseable,
 * stable); otherwise a short human readable block.
 */

import type { ServiceResponse } from 'attestra';

const color = (code: number) => (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
export const dim = color(2);
export const bold = color(1);
export const green = color(32);
export const red = color(31);
export const orange = color(33);

function replacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v;
}

export function formatValue(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return dim('none');
  if (Array.isArray(value)) {
    if (value.length === 0) return dim('[]');
    if (value.every((v) => typeof v !== 'object' || v === null)) return value.map(String).join(', ');
    return '\n' + value.map((v, i) => `${indent}  ${dim(`[${i}]`)} ${formatValue(v, `${indent}  `)}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return dim('{}');
    return '\n' + entries.map(([k, v]) => `${indent}  ${dim(k)}: ${formatValue(v, `${indent}  `)}`).join('\n');
  }
  return String(value);
}

export function formatOutput(data: unknown, json?: boolean, txHash?: string, explorer?: string): string {
  if (json) return JSON.stringify(txHash ? { success: true, data, tx_hash: txHash } : { success: true, data }, replacer, 2);
  const lines: string[] = [];
  if (data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) lines.push(`${bold(k)}: ${formatValue(v)}`);
  } else if (data !== undefined) {
    lines.push(formatValue(data).trimStart());
  }
  if (txHash) lines.push(`${dim('tx')}: ${txHash}${explorer ? dim(`  ${explorer}/txns/${txHash}`) : ''}`);
  return lines.join('\n') || green('done');
}

export function formatError(type: string, message: string, json?: boolean): string {
  if (json) return JSON.stringify({ success: false, error: { type, message } }, null, 2);
  return `${red(`Error [${type}]`)}: ${message}`;
}

/** Prints a ServiceResponse and sets the exit code. */
export function print<T>(r: ServiceResponse<T>, json?: boolean, explorer?: string): void {
  if (r.success) {
    console.log(formatOutput(r.data, json, r.txHash, explorer));
  } else {
    console.error(formatError(r.error?.type ?? 'UNKNOWN_ERROR', r.error?.message ?? 'unknown error', json));
    process.exitCode = 1;
  }
}
