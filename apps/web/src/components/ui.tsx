import type { FieldError } from '@claimflow/contracts';

// Loading, empty, and error states are the shared Material UI components. The
// old names stay so existing imports keep working.
export { EmptyState, Loading, ErrorAlert as ErrorNotice } from '../ui/feedback';

/** Messages for one form field, matching `amount` to `amount.amountMinor`. */
export function fieldMessages(
  details: readonly FieldError[] | undefined,
  field: string,
): string[] {
  return (details ?? [])
    .filter((d) => d.field === field || d.field.startsWith(`${field}.`))
    .map((d) => d.message);
}
