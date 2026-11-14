import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

/**
 * Page title, optional status and subtitle, and the page's actions. On narrow
 * screens the actions move below the title and wrap instead of squeezing it.
 */
export function PageHeader({
  title,
  subtitle,
  status,
  actions,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      useFlexGap
      sx={{
        justifyContent: 'space-between',
        alignItems: { xs: 'stretch', sm: 'flex-start' },
        mb: 2,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography
            variant="h5"
            component="h1"
            sx={{ overflowWrap: 'anywhere' }}
          >
            {title}
          </Typography>
          {status}
        </Stack>
        {subtitle === undefined ? null : (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions === undefined ? null : (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', flexShrink: 0 }}
        >
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
