/** NEAR amounts as exact yoctoNEAR bigints, and gas. */

export const YOCTO_PER_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

/** Parses a decimal NEAR amount ("0.02", "3", 1.5) into yoctoNEAR without floating point error. */
export function parseNear(amount: string | number): bigint {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a NEAR amount: ${amount}`);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > 24) throw new Error(`too many decimals: ${amount}`);
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'));
}

/** Formats yoctoNEAR as a decimal NEAR string, trimmed to `digits` decimals ("3.25"). */
export function formatNear(yocto: bigint, digits = 5): string {
  const negative = yocto < 0n;
  const abs = negative ? -yocto : yocto;
  const whole = abs / YOCTO_PER_NEAR;
  const frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
