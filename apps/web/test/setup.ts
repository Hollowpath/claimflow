import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { setAuth } from '../src/auth';
import { localConfig, setRuntimeConfig } from '../src/config';

// The first render in each test file pays for loading the Material UI
// components, which can exceed the default one-second wait when the whole suite
// runs in parallel. A longer ceiling only affects tests that would fail.
configure({ asyncUtilTimeout: 4000 });

// jsdom has no matchMedia, which Material UI's colour-scheme handling reads.
// Defined as a plain function so resetting mocks between tests cannot clear it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setRuntimeConfig(localConfig);
  setAuth(undefined);
  sessionStorage.clear();
  // Material UI stores an explicit colour mode here.
  localStorage.clear();
});
