import { createTheme } from '@mui/material/styles';

/** System fonts only: no font package, no web-font request. */
export const systemFontStack =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * The single Material UI theme. Both colour schemes are generated as CSS
 * variables and the default mode is `system`, so the interface follows the
 * operating system's light or dark preference until a choice is made.
 * Primary is a restrained deep blue: dark enough for white text and for text
 * on white in light mode, light enough for text on the dark surface in dark
 * mode. Everything else is Material UI's default.
 */
export const theme = createTheme({
  // A scheme is activated through a `data-mui-color-scheme` attribute on the
  // document element, so an explicit choice overrides the operating system.
  // The default `media` selector would follow the system only.
  cssVariables: { colorSchemeSelector: 'data-mui-color-scheme' },
  colorSchemes: {
    light: {
      palette: {
        primary: {
          light: '#3f61c4',
          main: '#1e40af',
          dark: '#162f84',
          contrastText: '#ffffff',
        },
      },
    },
    dark: {
      palette: {
        primary: {
          light: '#b8cdfa',
          main: '#93b4f8',
          dark: '#6a92ec',
          contrastText: '#0b1b3d',
        },
      },
    },
  },
  typography: {
    fontFamily: systemFontStack,
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    // Touch screens get a 44 px target; desktop (fine pointer) is unchanged.
    MuiButton: {
      styleOverrides: {
        root: { '@media (pointer: coarse)': { minHeight: 44, minWidth: 44 } },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: { '@media (pointer: coarse)': { minHeight: 44, minWidth: 44 } },
      },
    },
  },
});
