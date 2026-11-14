import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

/**
 * A titled block of a page. It is a labelled region whose heading is a
 * level-two heading, so the page title stays the only level-one heading and
 * screen-reader users can jump between sections.
 */
export function Section({
  id,
  title,
  children,
}: {
  /** Used to build the heading id that labels the region. */
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <Card variant="outlined" component="section" aria-labelledby={headingId}>
      <CardContent>
        <Typography id={headingId} variant="h6" component="h2" sx={{ mb: 1.5 }}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Label and value pairs as a description list: stacked on narrow screens and
 * in two columns once there is room.
 */
export function DetailList({ children }: { readonly children: ReactNode }) {
  return (
    <Typography
      component="dl"
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'max-content 1fr' },
        columnGap: 3,
        rowGap: { xs: 0.5, sm: 1 },
      }}
    >
      {children}
    </Typography>
  );
}

export function DetailItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <Typography
        component="dt"
        variant="body2"
        sx={{ color: 'text.secondary', mt: { xs: 1, sm: 0 } }}
      >
        {label}
      </Typography>
      <Typography component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </>
  );
}
