import Table from '@mui/material/Table';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import type { ReactNode } from 'react';

/**
 * A table that scrolls sideways instead of clipping on narrow screens. The
 * scroll region is a labelled, keyboard-focusable landmark so keyboard users
 * can scroll it; the table keeps its own accessible name.
 */
export function DataTable({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <TableContainer
      role="region"
      aria-label={`${label} (scrollable)`}
      tabIndex={0}
    >
      {/* A minimum width makes narrow screens scroll the table sideways
          instead of squeezing every column into wrapped text. */}
      <Table
        size="small"
        aria-label={label}
        sx={{
          minWidth: 640,
          // The first column names each row, so it stays visible while the
          // rest of a wide table is scrolled sideways.
          '& th:first-of-type': {
            position: 'sticky',
            left: 0,
            minWidth: 160,
            zIndex: 1,
            bgcolor: 'background.paper',
          },
        }}
      >
        {children}
      </Table>
    </TableContainer>
  );
}

/** The cell that names its row, such as the merchant. */
export function RowHeader({ children }: { readonly children: ReactNode }) {
  return (
    <TableCell component="th" scope="row">
      {children}
    </TableCell>
  );
}
