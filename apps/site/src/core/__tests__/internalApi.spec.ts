import {
  getWithOneRetry,
  INTERNAL_API_TOKEN_HEADER,
  internalApiHeaders,
  RETRY_429_MAX_WAIT_MS,
  retryAfterWithin,
  TRANSIENT_RETRY_WAIT_MS,
} from '../internalApi';

// The site's own requests to the API (issue #483): the token that takes them
// out of the public rate budget, and the one retry a brief 429 gets

const response = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : '{}', { status, headers });

describe('internalApiHeaders', () => {
  it('carries INTERNAL_API_TOKEN when it is set, nothing otherwise', () => {
    expect(internalApiHeaders({ INTERNAL_API_TOKEN: ' secret-0123456789 ' })).toEqual({
      [INTERNAL_API_TOKEN_HEADER]: 'secret-0123456789',
    });
    expect(internalApiHeaders({})).toEqual({});
    expect(internalApiHeaders({ INTERNAL_API_TOKEN: '  ' })).toEqual({});
  });
});

describe('retryAfterWithin', () => {
  it('reads Retry-After in seconds and refuses a wait longer than a render may take', () => {
    expect(retryAfterWithin(response(429, { 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterWithin(response(429, { 'retry-after': '5' }))).toBe(RETRY_429_MAX_WAIT_MS);
    expect(retryAfterWithin(response(429, { 'retry-after': '60' }))).toBeNull();
    expect(retryAfterWithin(response(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeNull();
    expect(retryAfterWithin(response(429))).toBeNull();
    expect(retryAfterWithin(response(429, { 'retry-after': '0' }))).toBeNull();
  });
});

describe('getWithOneRetry', () => {
  const scripted = (answers: Response[]) => {
    let calls = 0;
    const get = async (): Promise<Response> => {
      calls += 1;
      const next = answers.shift();
      if (!next) throw new Error('unexpected request');
      return next;
    };
    return { get, calls: () => calls };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };

  beforeEach(() => sleeps.splice(0));

  it.each([200, 400, 401, 403, 404, 500])('answers %i without a retry', async (status) => {
    const { get, calls } = scripted([response(status)]);
    expect((await getWithOneRetry(get, sleep)).status).toBe(status);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('waits Retry-After once and asks again', async () => {
    const { get, calls } = scripted([response(429, { 'retry-after': '1' }), response(200)]);
    expect((await getWithOneRetry(get, sleep)).status).toBe(200);
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('gives the second 429 back rather than retrying again', async () => {
    const second = response(429, { 'retry-after': '1' });
    const { get, calls } = scripted([response(429, { 'retry-after': '1' }), second]);
    expect(await getWithOneRetry(get, sleep)).toBe(second);
    expect(calls()).toBe(2);
  });

  it('does not wait for a budget that frees in a minute', async () => {
    const first = response(429, { 'retry-after': '60' });
    const { get, calls } = scripted([first]);
    expect(await getWithOneRetry(get, sleep)).toBe(first);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it.each([502, 503, 504])(
    'recovers from %i with a fresh request and releases the first body',
    async (status) => {
      const first = response(status);
      const cancel = jest.spyOn(first.body!, 'cancel');
      const get = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(response(200));
      expect((await getWithOneRetry(get, sleep)).status).toBe(200);
      expect(get).toHaveBeenNthCalledWith(1);
      expect(get).toHaveBeenNthCalledWith(2, expect.any(AbortSignal));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([TRANSIENT_RETRY_WAIT_MS]);
    },
  );

  it('respects a short Retry-After on 503 and refuses a long one', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(response(503, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(200));
    expect((await getWithOneRetry(get, sleep)).status).toBe(200);
    expect(sleeps).toEqual([2000]);

    get.mockReset().mockResolvedValue(response(503, { 'retry-after': '60' }));
    expect((await getWithOneRetry(get, sleep)).status).toBe(503);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the unread memoized clone before retrying', async () => {
    const first = response(503);
    const clone = first.clone();
    const get = jest.fn().mockResolvedValueOnce(clone).mockResolvedValueOnce(response(200));
    // Cancelling clone.body cannot finish until first.body is consumed.
    // The retry must finish while that original branch is still unread.
    expect((await getWithOneRetry(get, sleep)).status).toBe(200);
    await first.text();
  });

  it('retries a refused connection once and keeps the final transport error', async () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }),
    });
    const get = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(response(200));
    expect((await getWithOneRetry(get, sleep)).status).toBe(200);
    expect(get).toHaveBeenNthCalledWith(2, expect.any(AbortSignal));

    get.mockReset().mockRejectedValue(error);
    await expect(getWithOneRetry(get, sleep)).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a programming error', async () => {
    const error = new TypeError('Invalid URL');
    const get = jest.fn().mockRejectedValue(error);
    await expect(getWithOneRetry(get, sleep)).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('stops after the second unavailable response', async () => {
    const get = jest.fn().mockResolvedValue(response(503));
    expect((await getWithOneRetry(get, sleep)).status).toBe(503);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
