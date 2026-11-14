import type { ClaimStatus } from '@claimflow/contracts';
import Chip, { type ChipProps } from '@mui/material/Chip';

import { statusLabels } from '../lib/format';

type StatusColor = Exclude<
  NonNullable<ChipProps['color']>,
  'primary' | 'secondary'
>;

/** Colour is never the only signal: every chip also carries the status text. */
const colors: Record<ClaimStatus, StatusColor> = {
  DRAFT: 'default',
  SUBMITTED: 'info',
  UNDER_REVIEW: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  PAID: 'success',
};

/**
 * The status colour tints the chip and outlines it; the label stays in the
 * normal text colour, so it keeps its contrast in light and dark mode (white
 * text on the saturated filled colours does not reach 4.5:1).
 */
export function StatusChip({ status }: { readonly status: ClaimStatus }) {
  const color = colors[status];
  return (
    <Chip
      size="small"
      label={statusLabels[status]}
      variant="outlined"
      color={color}
      sx={
        color === 'default'
          ? undefined
          : (theme) => {
              const channel = theme.vars?.palette[color].mainChannel;
              return {
                color: 'text.primary',
                fontWeight: status === 'PAID' ? 700 : undefined,
                ...(channel === undefined
                  ? {}
                  : { backgroundColor: `rgba(${channel} / 0.16)` }),
              };
            }
      }
    />
  );
}
