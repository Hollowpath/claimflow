import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

/**
 * The first focusable element on the page: jumps past the navigation. Hidden
 * until it has keyboard focus.
 */
export function SkipLink({
  targetId,
  children = 'Skip to main content',
}: {
  readonly targetId: string;
  readonly children?: ReactNode;
}) {
  return (
    <Link
      href={`#${targetId}`}
      sx={{
        position: 'absolute',
        left: 8,
        top: -64,
        zIndex: (theme) => theme.zIndex.tooltip + 1,
        px: 2,
        py: 1,
        borderRadius: 1,
        bgcolor: 'background.paper',
        '&:focus': { top: 8 },
      }}
    >
      {children}
    </Link>
  );
}

/**
 * A navigation landmark of real links. Links, not tabs: moving between pages
 * is navigation, and `NavLink` marks the current page with `aria-current`.
 */
export function MainNav({ children }: { readonly children: ReactNode }) {
  return (
    <nav aria-label="Main">
      <Box
        component="ul"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.5,
          listStyle: 'none',
          m: 0,
          p: 0,
        }}
      >
        {children}
      </Box>
    </nav>
  );
}

export function NavItem({
  to,
  end = false,
  children,
}: {
  readonly to: string;
  readonly end?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li>
      <Button
        component={NavLink}
        to={to}
        end={end}
        color="inherit"
        sx={{ '&[aria-current="page"]': { bgcolor: 'action.selected' } }}
      >
        {children}
      </Button>
    </li>
  );
}
