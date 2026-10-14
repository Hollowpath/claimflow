import { describe, expect, it, vi } from 'vitest';

import { request, setUnauthenticatedListener } from '../src/api/client';
import { formatMoney, parseAmount, toAmountInput } from '../src/lib/money';

describe('money', () => {
  it.each([
    ['125.50', 12_550],
    ['125.5', 12_550],
    ['1,250', 125_000],
    ['0.01', 1],
    [' 7 ', 700],
    ['12.345', undefined],
    ['-5', undefined],
    ['1e3', undefined],
    ['', undefined],
    ['abc', undefined],
  ])('parses %j as %s minor units', (input, expected) => {
    expect(parseAmount(input, 'MYR')).toBe(expected);
  });

  it('handles currencies without minor units', () => {
    expect(parseAmount('1500', 'JPY')).toBe(1500);
    expect(parseAmount('15.5', 'JPY')).toBeUndefined();
    expect(toAmountInput(1500, 'JPY')).toBe('1500');
  });

  it('formats minor units without float drift', () => {
    expect(toAmountInput(5, 'MYR')).toBe('0.05');
    expect(toAmountInput(12_550, 'MYR')).toBe('125.50');
    expect(formatMoney(12_550, 'MYR').replace(/\s/g, ' ')).toBe('RM 125.50');
  });
});

describe('API client', () => {
  it('returns nothing for 204 No Content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(
      request('DELETE', '/claims/c-1', { json: { expectedVersion: 1 } }),
    ).resolves.toBeUndefined();
  });

  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('sends an idempotency key on mutations and reuses it on retry', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      request('POST', '/claims', { json: { merchant: 'City Taxi' } }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>,
    );
    expect(first?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.['Idempotency-Key']).toBe(first?.['Idempotency-Key']);
  });

  it('does not send idempotency keys on reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await request('GET', '/categories');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('turns error responses into ApiError and reports lost sessions', async () => {
    const listener = vi.fn();
    setUnauthenticatedListener(listener);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Choose a local user to continue.',
            requestId: 'r-1',
          },
        }),
      ),
    );
    await expect(request('GET', '/me/claims')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      requestId: 'r-1',
    });
    expect(listener).toHaveBeenCalled();
  });

  it('reports an unreachable API safely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    await expect(request('GET', '/session')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('reports a non-JSON error, such as a proxy 502, as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 502 })),
    );
    await expect(request('GET', '/session')).rejects.toMatchObject({
      status: 502,
      code: 'NETWORK_ERROR',
      message: 'Cannot reach the ClaimFlow API. Check that it is running.',
    });
  });
});
