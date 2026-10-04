jest.mock('server-only', () => ({}));
jest.mock('../apiBase', () => ({ serverApiBase: () => 'http://api.test/api' }));

import { fetchHeadword } from '../dictionary';

describe('word page API diagnostics', () => {
  const fetchMock = jest.fn();
  let warn: jest.SpyInstance;
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = fetchMock;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    fetchMock.mockReset();
  });

  it('keeps the upstream status, request ID and Retry-After without logging credentials or body', async () => {
    const token = process.env.INTERNAL_API_TOKEN;
    process.env.INTERNAL_API_TOKEN = 'private-internal-token';
    try {
      fetchMock.mockResolvedValue(
        new Response('private response', {
          status: 429,
          headers: { 'x-request-id': 'request-123', 'retry-after': '60' },
        }),
      );
      expect(await fetchHeadword('look')).toEqual({ kind: 'unavailable' });
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
        event: 'dictionary_api_unavailable',
        path: '/v1/words/look',
        internal_token_configured: true,
        status: 429,
        request_id: 'request-123',
        retry_after: '60',
      });
      expect(warn.mock.calls[0][0]).not.toContain('private');
    } finally {
      if (token === undefined) delete process.env.INTERNAL_API_TOKEN;
      else process.env.INTERNAL_API_TOKEN = token;
    }
  });

  it('does not turn a missing word into an outage or log it as one', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await fetchHeadword('absent')).toEqual({ kind: 'not_found' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('records the connection error code after the retry fails', async () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }),
    });
    fetchMock.mockRejectedValue(error);
    expect(await fetchHeadword('look')).toEqual({ kind: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      path: '/v1/words/look',
      error: 'TypeError',
      code: 'ECONNREFUSED',
    });
  });
});
