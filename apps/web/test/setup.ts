import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { setAuth } from '../src/auth';
import { localConfig, setRuntimeConfig } from '../src/config';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setRuntimeConfig(localConfig);
  setAuth(undefined);
  sessionStorage.clear();
});
