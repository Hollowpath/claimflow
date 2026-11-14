import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import type { ChangeEvent, ReactNode } from 'react';

/**
 * Shared behaviour for every form field: a visible label bound to the control
 * by an explicit `id`, error messages shown as the field's helper text and
 * announced through `aria-describedby`, and the hint kept beside any error.
 * The `required` prop is deliberately not offered: Material UI appends " *"
 * to the accessible name, and ClaimFlow marks requirements in words.
 */
interface BaseFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Validation messages for this field; any message puts it in the error state. */
  readonly messages?: readonly string[];
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
}

function helperText(
  messages: readonly string[],
  hint: ReactNode | undefined,
): ReactNode {
  if (messages.length === 0) {
    return hint;
  }
  return (
    <>
      {hint === undefined ? null : (
        <Box component="span" sx={{ display: 'block' }}>
          {hint}
        </Box>
      )}
      <Box component="span" sx={{ display: 'block' }}>
        {messages.join(' ')}
      </Box>
    </>
  );
}

export function Field({
  id,
  label,
  value,
  onChange,
  messages = [],
  hint,
  disabled = false,
  multiline = false,
  rows,
  type,
  inputMode,
  autoComplete,
  maxLength,
  max,
  placeholder,
  autoFocus = false,
}: BaseFieldProps & {
  /** Focus the field when it appears, for the first field of a dialog. */
  readonly autoFocus?: boolean;
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly type?: 'text' | 'date';
  readonly inputMode?: 'decimal' | 'text';
  readonly autoComplete?: string;
  readonly maxLength?: number;
  readonly max?: string;
  readonly placeholder?: string;
}) {
  return (
    <TextField
      id={id}
      label={label}
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value)
      }
      error={messages.length > 0}
      helperText={helperText(messages, hint)}
      disabled={disabled}
      multiline={multiline}
      autoFocus={autoFocus}
      fullWidth
      {...(rows === undefined ? {} : { minRows: rows })}
      {...(type === undefined ? {} : { type })}
      {...(placeholder === undefined ? {} : { placeholder })}
      slotProps={{
        // A date input has no placeholder, so its label must stay raised.
        inputLabel: type === 'date' ? { shrink: true } : {},
        htmlInput: {
          ...(maxLength === undefined ? {} : { maxLength }),
          ...(max === undefined ? {} : { max }),
          ...(inputMode === undefined ? {} : { inputMode }),
          ...(autoComplete === undefined ? {} : { autoComplete }),
        },
      }}
    />
  );
}

/** A native, controlled select: the platform picker on mobile, and a plain `select` for assistive technology. */
export function SelectField({
  id,
  label,
  value,
  onChange,
  messages = [],
  hint,
  disabled = false,
  size = 'medium',
  children,
}: BaseFieldProps & {
  readonly size?: 'small' | 'medium';
  readonly children: ReactNode;
}) {
  return (
    <TextField
      id={id}
      select
      size={size}
      label={label}
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value)
      }
      error={messages.length > 0}
      helperText={helperText(messages, hint)}
      disabled={disabled}
      fullWidth
      slotProps={{
        select: { native: true },
        // The empty option means "nothing chosen", so the label stays raised.
        inputLabel: { shrink: true },
      }}
    >
      {children}
    </TextField>
  );
}

/**
 * A file chooser. The real `input` is visually hidden but stays focusable, so
 * keyboard users reach it and the label button shows a focus ring when it has
 * focus. The accessible name is the button text.
 */
export function FileButton({
  label,
  accept,
  disabled = false,
  onFile,
  variant = 'outlined',
}: {
  readonly label: string;
  readonly accept: string;
  readonly disabled?: boolean;
  readonly onFile: (file: File) => void;
  readonly variant?: 'outlined' | 'contained';
}) {
  return (
    <Button
      component="label"
      role={undefined}
      tabIndex={-1}
      variant={variant}
      disabled={disabled}
      sx={{
        '&:has(input:focus-visible)': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      {label}
      <Box
        component="input"
        type="file"
        accept={accept}
        aria-label={label}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          // Clear the value so choosing the same file again still fires.
          event.target.value = '';
          if (file !== undefined) {
            onFile(file);
          }
        }}
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          m: -0.125,
          p: 0,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      />
    </Button>
  );
}
