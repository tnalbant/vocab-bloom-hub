import 'server-only';

import type {
  PublicChangeV1T,
  PublicHeadwordHistoryV1ResT,
  PublicHeadwordV1ResT,
  PublicMetaV1ResT,
  PublicWordDatasetV1T,
  PublicWordDatasetsV1ResT,
  PublicWordV1ResT,
} from 'server/types';

import { serverApiBase } from './apiBase';
import { DatasetTermsT, OWN_DATASET_TERMS } from './datasetTerms';
import { getWithOneRetry, internalApiHeaders } from './internalApi';

// The word pages are rendered on the server from the instance's public API
// and cached for an hour: the dictionary changes rarely, a page is asked
// for often once it is indexed
const REVALIDATE_SECONDS = 3600;

// Keep enough detail to correlate a failed render with the API request log,
// without logging the internal token, response body or connection URL.
const logHeadwordFailure = (path: string, details: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console -- server-side diagnostics for the operator
  console.warn(
    JSON.stringify({
      event: 'dictionary_api_unavailable',
      path,
      internal_token_configured: Boolean(process.env.INTERNAL_API_TOKEN?.trim()),
      ...details,
    }),
  );
};

/**
 * Thrown by a page that cannot be rendered without the API (issue #480): the
 * route-level error boundary shows it and Next answers 500. The failed
 * render is not kept as a successful or missing page in the ISR cache.
 */
export class DictionaryUnavailableError extends Error {
  constructor() {
    super('the dictionary API is unavailable');
    this.name = 'DictionaryUnavailableError';
  }
}

export type HeadwordResultT =
  { kind: 'found'; result: PublicHeadwordV1ResT } | { kind: 'not_found' } | { kind: 'unavailable' };

/** GET /api/v1/words/{word}: every entry of a headword, or why there is none */
export const fetchHeadword = async (word: string): Promise<HeadwordResultT> => {
  const path = `/v1/words/${encodeURIComponent(word)}`;
  try {
    // the site's own traffic (internalApi.ts): not counted against the public
    // budget with INTERNAL_API_TOKEN set; transient failures get one retry
    const res = await getWithOneRetry((signal) =>
      fetch(`${serverApiBase()}${path}`, {
        headers: internalApiHeaders(),
        next: { revalidate: REVALIDATE_SECONDS },
        signal,
      }),
    );
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) {
      logHeadwordFailure(path, {
        status: res.status,
        request_id: res.headers.get('x-request-id'),
        retry_after: res.headers.get('retry-after'),
      });
      return { kind: 'unavailable' };
    }

    return { kind: 'found', result: (await res.json()) as PublicHeadwordV1ResT };
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    logHeadwordFailure(path, {
      error: error instanceof Error ? error.name : 'UnknownError',
      code: cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined,
    });
    return { kind: 'unavailable' };
  }
};

/**
 * GET /api/v1/words/{word}/history: what was changed on the instance in the
 * entries of a headword (issue #531). The page stands without it: no answer
 * is an empty history, the entries still say that they were changed.
 */
export const fetchHeadwordHistory = async (word: string): Promise<PublicChangeV1T[]> => {
  try {
    const res = await getWithOneRetry((signal) =>
      fetch(`${serverApiBase()}/v1/words/${encodeURIComponent(word)}/history`, {
        headers: internalApiHeaders(),
        next: { revalidate: REVALIDATE_SECONDS },
        signal,
      }),
    );
    if (!res.ok) return [];

    return ((await res.json()) as PublicHeadwordHistoryV1ResT).data;
  } catch {
    return [];
  }
};

/**
 * GET /api/v1/words/{word}/datasets: the headword as every dataset of the
 * instance has it, a group per dataset (issue #538). The page stands without
 * it: no answer — no dataset holds the word, the read failed, a server that
 * has no such route — is no group, and the page shows the served dataset.
 */
export const fetchHeadwordDatasets = async (word: string): Promise<PublicWordDatasetV1T[]> => {
  try {
    const res = await getWithOneRetry((signal) =>
      fetch(`${serverApiBase()}/v1/words/${encodeURIComponent(word)}/datasets`, {
        headers: internalApiHeaders(),
        next: { revalidate: REVALIDATE_SECONDS },
        signal,
      }),
    );
    if (!res.ok) return [];

    return ((await res.json()) as PublicWordDatasetsV1ResT).data;
  } catch {
    return [];
  }
};

/** GET /api/v1/words/{word}/datasets/{dataset}/history: the history read of a dataset that is not the served one */
export const fetchDatasetHistory = async (word: string, dataset: string): Promise<PublicChangeV1T[]> => {
  try {
    const res = await getWithOneRetry((signal) =>
      fetch(
        `${serverApiBase()}/v1/words/${encodeURIComponent(word)}/datasets/${encodeURIComponent(dataset)}/history`,
        { headers: internalApiHeaders(), next: { revalidate: REVALIDATE_SECONDS }, signal },
      ),
    );
    if (!res.ok) return [];

    return ((await res.json()) as PublicHeadwordHistoryV1ResT).data;
  } catch {
    return [];
  }
};

/** GET /api/v1/random: the headword of a random base-form entry, null when the API does not answer */
export const fetchRandomWord = async (): Promise<string | null> => {
  try {
    const res = await fetch(`${serverApiBase()}/v1/random`, {
      headers: internalApiHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return null;

    return ((await res.json()) as PublicWordV1ResT).data.word;
  } catch {
    return null;
  }
};

/** GET /api/v1/meta, reduced to the terms of the data; the project's own when the API does not say */
export const fetchDatasetTerms = async (): Promise<DatasetTermsT> => {
  try {
    const res = await getWithOneRetry((signal) =>
      fetch(`${serverApiBase()}/v1/meta`, {
        headers: internalApiHeaders(),
        next: { revalidate: REVALIDATE_SECONDS },
        signal,
      }),
    );
    if (!res.ok) return OWN_DATASET_TERMS;
    const { data } = (await res.json()) as PublicMetaV1ResT;
    if (!data.source) return OWN_DATASET_TERMS;
    return {
      ...(data.title && { title: data.title }),
      source: data.source,
      license: data.license,
      license_url: data.license_url,
      attribution: data.attribution,
      attribution_url: data.attribution_url ?? null,
      notice: data.notice,
      license_text: data.license_text ?? '',
      origins: data.origins ?? [],
      description: data.description ?? null,
    };
  } catch {
    return OWN_DATASET_TERMS;
  }
};
