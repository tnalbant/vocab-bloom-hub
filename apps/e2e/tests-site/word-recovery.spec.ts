import { expect, test } from '@playwright/test';

import { SITE_STUB_URL } from '../config';

test.describe('word pages during API recovery', () => {
  for (const failure of [429, 502, 503, 504, 'disconnect']) {
    test(`recovers from ${failure} within the first server render`, async ({ page, request }) => {
      const word = `recovery-${failure}`;
      const control = `${SITE_STUB_URL}/__test__/word-failure/${word}`;
      await request.post(control, { data: [failure] });

      const response = await page.goto(`/en/word/${word}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1, name: word })).toBeVisible();
      await expect(page.getByText('to move fast').first()).toBeVisible();
      // The retry must reach the API even inside React's memoized render;
      // metadata and the page share it, rather than issuing competing retries.
      expect((await (await request.get(control)).json()).calls).toBe(2);
    });
  }

  test('an outage is not cached as a missing word or an empty successful page', async ({ page, request }) => {
    const word = 'recovery-outage';
    const control = `${SITE_STUB_URL}/__test__/word-failure/${word}`;
    await request.post(control, { data: [503, 503] });

    const failed = await page.goto(`/en/word/${word}`);
    expect(failed?.status()).toBe(500);
    expect(failed?.headers()['cache-control'] ?? '').not.toMatch(/public|s-maxage/);

    const recovered = await page.goto(`/en/word/${word}`);
    expect(recovered?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: word })).toBeVisible();
  });
});
