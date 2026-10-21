import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { setAuth } from '../src/auth';
import { CognitoAuth } from '../src/auth/cognito';
import { setRuntimeConfig } from '../src/config';
import { apiError, claim, renderApp, sessionFor } from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);
const hostedUiUrl = 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com';

const withReceipt = claim({
  receipt: {
    receiptId: 'r-1',
    fileName: 'taxi.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    checksumSha256: 'a'.repeat(64),
    attachedAt: '2026-10-14T09:30:00.000Z',
  },
});

beforeEach(() => {
  setRuntimeConfig({
    apiBaseUrl: 'https://abc.execute-api.ap-southeast-1.amazonaws.com/api/v1',
    cognito: { hostedUiUrl, clientId: 'client123' },
  });
  setAuth(
    new CognitoAuth({
      config: { hostedUiUrl, clientId: 'client123' },
      storage: sessionStorage,
      fetch: vi.fn(),
      now: () => Date.now(),
      navigate: vi.fn(),
      origin: 'https://d111.cloudfront.net',
    }),
  );
  sessionStorage.setItem(
    'claimflow.auth.tokens',
    JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
  mocked.getClaim.mockResolvedValue(withReceipt);
  mocked.getHistory.mockResolvedValue({ items: [] });
  mocked.listCategories.mockResolvedValue([]);
});

describe('receipt panel in Cognito mode', () => {
  it('replaces the protected-API link with an authenticated download', async () => {
    mocked.openReceipt.mockResolvedValue(undefined);
    const { user } = renderApp('/claims/c-1');

    expect(
      await screen.findByRole('button', { name: 'taxi.pdf' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'taxi.pdf' }),
    ).not.toBeInTheDocument();
    expect(mocked.receiptUrl).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'taxi.pdf' }));
    expect(mocked.openReceipt).toHaveBeenCalledExactlyOnceWith('c-1');
  });

  it('shows the existing error notice when the download fails', async () => {
    mocked.openReceipt.mockRejectedValue(
      apiError(404, 'NOT_FOUND', 'The receipt is no longer available.'),
    );
    const { user } = renderApp('/claims/c-1');

    await user.click(await screen.findByRole('button', { name: 'taxi.pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The receipt is no longer available.',
    );
    expect(screen.getByRole('button', { name: 'taxi.pdf' })).toBeEnabled();
  });

  it('shows an upload failure through the existing error notice', async () => {
    mocked.getClaim.mockResolvedValue(claim());
    mocked.attachReceiptFile.mockRejectedValue(
      apiError(
        0,
        'INTERNAL_ERROR',
        'The receipt could not be uploaded. Please try again.',
      ),
    );
    const { user } = renderApp('/claims/c-1');
    const file = new File(['%PDF'], 'taxi.pdf', { type: 'application/pdf' });

    await user.upload(await screen.findByLabelText('Upload receipt'), file);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The receipt could not be uploaded',
    );
    expect(mocked.attachReceiptFile).toHaveBeenCalledWith('c-1', 1, file);
  });
});
