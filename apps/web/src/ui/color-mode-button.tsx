import Button from '@mui/material/Button';
import { useColorScheme } from '@mui/material/styles';

/**
 * Switches between light and dark. Until the user chooses, the mode follows
 * the operating system, so the label offers the opposite of what is showing.
 * `setMode` stores an explicit choice in local storage (Material UI's own
 * colour-scheme persistence).
 */
export function ColorModeButton() {
  const { mode, systemMode, setMode } = useColorScheme();
  const effective = mode === 'system' ? systemMode : mode;
  if (effective === undefined) {
    // The mode is resolved after the first render.
    return null;
  }
  const next = effective === 'dark' ? 'light' : 'dark';
  return (
    <Button color="inherit" size="small" onClick={() => setMode(next)}>
      {next === 'dark' ? 'Use dark mode' : 'Use light mode'}
    </Button>
  );
}
