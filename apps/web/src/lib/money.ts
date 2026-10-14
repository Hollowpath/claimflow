/** Number of minor-unit digits for a currency, e.g. 2 for MYR, 0 for JPY. */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatMoney(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  try {
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
    }).format(amountMinor / 10 ** digits);
  } catch {
    return `${currency} ${toAmountInput(amountMinor, currency)}`;
  }
}

/** Minor units as an editable decimal string, without float rounding. */
export function toAmountInput(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) {
    return String(amountMinor);
  }
  const text = String(amountMinor).padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * Parses a decimal amount such as "1,250.5" into integer minor units using
 * string arithmetic, so no binary floating-point value is ever involved.
 * Returns `undefined` for invalid input.
 */
export function parseAmount(
  input: string,
  currency: string,
): number | undefined {
  const digits = minorDigits(currency);
  const cleaned = input.trim().replace(/,/g, '');
  const pattern =
    digits === 0 ? /^\d+$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${digits}}))?$`);
  const match = pattern.exec(cleaned);
  if (match === null) {
    return undefined;
  }
  const whole = match[1] ?? match[0];
  const fraction = (match[2] ?? '').padEnd(digits, '0');
  const value = Number(`${whole}${fraction}`);
  return Number.isSafeInteger(value) ? value : undefined;
}
