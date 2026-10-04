/**
 * The site's own requests to the API (issue #483): the word pages rendered on
 * the server and the headword walk behind the sitemaps and the browse index
 * all leave the site's process from one address, and the public prefix
 * budgets by address — a walk of a thousand list pages emptied the budget a
 * word page needed, and the page answered 500. With `INTERNAL_API_TOKEN`
 * set on both sides these requests carry the token and the server does not
 * count them; without it, nothing changes on the wire.
 */
export const INTERNAL_API_TOKEN_HEADER = 'x-internal-token';

/** The header of the instance's own traffic, or nothing when no token is configured */
export const internalApiHeaders = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string> => {
  const token = env.INTERNAL_API_TOKEN?.trim();
  return token ? { [INTERNAL_API_TOKEN_HEADER]: token } : {};
};

/** A page render waits this long at most for the budget to free (`Retry-After`) */
export const RETRY_429_MAX_WAIT_MS = 5_000;
/** One short pause for a restarting API or reverse proxy */
export const TRANSIENT_RETRY_WAIT_MS = 1_000;

/** The wait a `429` asks for, in ms; null when it is missing, malformed or too long to wait in a render */
export const retryAfterWithin = (res: Response, maxMs: number = RETRY_429_MAX_WAIT_MS): number | null => {
  const seconds = Number(res.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  return ms <= maxMs ? ms : null;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Repeat a GET once after a network failure, 502/503/504 or a brief 429.
 * Respect Retry-After without making a render wait a minute. The callback
 * must pass the retry's signal to fetch: Next otherwise memoizes the first
 * failure within this render and no second request reaches the API. This
 * opts out of request memoization, not the persistent fetch data cache.
 */
export const getWithOneRetry = async (
  get: (signal?: AbortSignal) => Promise<Response>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<Response> => {
  let first: Response;
  try {
    first = await get();
  } catch (error) {
    // Native fetch wraps transport errors (connection refused/reset, DNS,
    // undici timeouts) in this TypeError. Programming errors are not retried.
    if (!(error instanceof TypeError) || error.message !== 'fetch failed') throw error;
    await sleep(TRANSIENT_RETRY_WAIT_MS);
    return get(new AbortController().signal);
  }
  if (![429, 502, 503, 504].includes(first.status)) return first;
  const wait =
    first.status === 429 || first.headers.has('retry-after')
      ? retryAfterWithin(first)
      : TRANSIENT_RETRY_WAIT_MS;
  if (wait === null) return first;
  // Next may have cloned this response for request memoization. Cancelling
  // one branch of a tee waits for the other branch, which may never be read.
  // Release our body without letting that wait prevent the retry.
  void first.body?.cancel().catch(() => undefined);
  await sleep(wait);
  return get(new AbortController().signal);
};
