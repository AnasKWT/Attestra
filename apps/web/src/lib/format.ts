/** Formatting helpers for hashes, accounts, amounts and times. */

export function truncate(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return '';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

/** Account ids are readable up to about 28 characters; implicit (64 hex) ids are shortened. */
export function shortAccount(id: string | null | undefined): string {
  if (!id) return '';
  if (/^[0-9a-f]{64}$/.test(id)) return truncate(id, 6, 6);
  if (id.length > 30) return truncate(id, 14, 10);
  return id;
}

export function formatTime(secs: number | null | undefined): string {
  if (!secs) return 'never';
  return new Date(secs * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

export function timeAgo(secs: number | null | undefined, now = Date.now() / 1000): string {
  if (!secs) return '';
  const d = Math.round(now - secs);
  const abs = Math.abs(d);
  const unit = abs < 60 ? [abs, 's'] : abs < 3600 ? [Math.round(abs / 60), 'm'] : abs < 86400 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  return d >= 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}

/** yoctoNEAR (or any 10^decimals amount) to a short decimal string. */
export function formatAmount(raw: string | bigint | null | undefined, decimals = 24, digits = 4): string {
  if (raw === null || raw === undefined || raw === '') return '0';
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString();
}

/** Decimal string ("1.5") to the smallest unit. */
export function parseAmount(value: string, decimals = 24): string {
  const [w, f = ''] = value.trim().split('.');
  if (!/^\d+$/.test(w || '0') || !/^\d*$/.test(f)) throw new Error('not a number');
  return (BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}
