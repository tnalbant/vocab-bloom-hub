import React, { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { PublicChangeV1T } from 'server/types';

import { JsonLd } from '@/components/JsonLd';
import { WordSearch } from '@/components/WordSearch';
import {
  DictionaryUnavailableError,
  fetchDatasetHistory,
  fetchDatasetTerms,
  fetchHeadword,
  fetchHeadwordDatasets,
  fetchHeadwordHistory,
} from '@/core/dictionary';
import { pageMeta, trimDescription } from '@/core/site';
import { breadcrumbJsonLd, definedTermJsonLd } from '@/core/structuredData';
import { defaultPanel, wordPanels } from '@/core/wordDatasets';
import { leadDefinition, localeTranslations } from '@/core/wordPage';
import type { WordPanelT } from '@/core/wordPanel';
import { LocaleParamsP } from '@/types/common';

import styles from '../word.module.scss';
import { DatasetPanels } from './_components/DatasetPanels';
import { wordPath } from './_components/Entry';
import { Panel } from './_components/Panel';

type WordPageP = LocaleParamsP<{ word: string }>;

// Rendered on the first request from the instance's API and regenerated
// after an hour (ISR, next.config.ts): no headword is known at build time,
// so nothing is prerendered. The API being down throws — a render that
// failed is not kept, the stale copy is served when there is one
export const revalidate = 3600;
export const generateStaticParams = () => [];

const headwordOf = async (params: WordPageP['params']) => {
  const { locale, word } = await params;

  return { locale, word: decodeURIComponent(word) };
};

type ResolvedT =
  | { kind: 'unavailable' }
  | { kind: 'not_found' }
  | {
      kind: 'found';
      /** The datasets that hold the headword, a panel each, and the one the page renders: the first */
      panels: WordPanelT[];
      lead: WordPanelT;
    };

/**
 * What the page shows (issue #538): the headword in the datasets of the
 * instance, a tab each. The server renders the first tab — the dataset of
 * the project where it holds the word — and names the others, which the
 * browser reads when their tab is pressed. The served dataset has to
 * answer: a page that lost it to a failure must not be cached as the page
 * of the other datasets. A headword only another dataset holds is a page
 * too, the links of its entries lead to it.
 *
 * The one URL of a headword is its normalized spelling (issue #480):
 * /en/word/Bloom answered 200 with a canonical of its own, one indexable
 * page per spelling variant. A 308 folds them. Where a dataset holds "Test"
 * next to "test" they are two words and the API keeps the case of the one
 * that was asked for: a spelling some dataset holds as it is stays a page,
 * so its tab can be opened, and names the page of the first tab as its
 * canonical
 */
// Share the result (including its retry) between metadata and the page.
const resolve = cache(async (locale: string, word: string): Promise<ResolvedT> => {
  const [headword, terms, groups] = await Promise.all([
    fetchHeadword(word),
    fetchDatasetTerms(),
    fetchHeadwordDatasets(word),
  ]);
  if (headword.kind === 'unavailable') return { kind: 'unavailable' };

  const panels = wordPanels({ headword: headword.kind === 'found' ? headword.result : null, terms, groups });
  const lead = defaultPanel(panels);
  if (!lead) return { kind: 'not_found' };
  if (!panels.some((panel) => panel.word === word)) permanentRedirect(`/${locale}${wordPath(lead.word)}`);

  return { kind: 'found', panels, lead };
});

// how many of the locale's translations fit a title
const TITLE_TRANSLATIONS = 4;

export const generateMetadata = async ({ params }: WordPageP): Promise<Metadata> => {
  const { locale, word } = await headwordOf(params);
  const t = await getTranslations({ locale, namespace: 'word' });
  const resolved = await resolve(locale, word);
  // the API being down must not get thin placeholder pages indexed (issue #399)
  if (resolved.kind === 'unavailable') return { title: word, robots: { index: false } };
  if (resolved.kind === 'not_found') return { title: word };

  const { panels, lead } = resolved;
  const definition = leadDefinition(lead.entries);
  // the locale's own translations lead the title and the description (issue
  // #480): "bloom — перевод: цветок, цветение"; the English pattern otherwise
  const translations = localeTranslations(lead.entries, locale);
  const title = translations.length
    ? t('page_title_translated', {
        word: lead.word,
        translations: translations.slice(0, TITLE_TRANSLATIONS).join(', '),
      })
    : t('page_title', { word: lead.word });
  const description = translations.length
    ? [t('translations_of', { word: lead.word, translations: translations.join(', ') }), definition]
        .filter(Boolean)
        .join(' ')
    : definition || t('page_description', { word: lead.word });
  // The search engines are given the words of the dictionary the site
  // serves: the sitemap and the index of words are its headwords. A word the
  // served dataset does not hold is a page for a reader who followed a link
  if (!panels.some((panel) => panel.active)) {
    return { title, description: trimDescription(description), robots: { index: false, follow: true } };
  }

  return pageMeta({
    locale,
    path: wordPath(lead.word),
    title,
    // a snippet's length: search engines cut a description at about 160 characters
    description: trimDescription(description),
    type: 'article',
  });
};

// what was changed on the instance (issue #531): asked for only where an entry says it was
const historyOf = async (panel: WordPanelT): Promise<PublicChangeV1T[]> => {
  if (!panel.entries.some((entry) => entry.modified)) return [];

  return panel.active ? fetchHeadwordHistory(panel.word) : fetchDatasetHistory(panel.word, panel.dataset);
};

export default async function WordPage({ params }: WordPageP) {
  const { locale, word } = await headwordOf(params);
  setRequestLocale(locale);
  const t = await getTranslations('word');
  const nav = await getTranslations('nav');
  const termsNames = await getTranslations('terms');
  const resolved = await resolve(locale, word);

  // the page is cacheable (next.config.ts); one the API failed to render must not be
  if (resolved.kind === 'unavailable') throw new DictionaryUnavailableError();
  if (resolved.kind === 'not_found') notFound();

  const { panels, lead } = resolved;
  const history = await historyOf(lead);

  return (
    <div className={`container ${styles.page}`}>
      {/* structured data for search engines (issues #350, #480): the trail and the term in its dictionary */}
      <JsonLd
        data={[
          breadcrumbJsonLd(locale, [
            { name: t('index_title'), path: '/word' },
            { name: lead.word, path: wordPath(lead.word) },
          ]),
          definedTermJsonLd({
            locale,
            word: lead.word,
            description: leadDefinition(lead.entries),
            terms: lead.terms,
          }),
        ]}
      />
      {/* the other datasets are named, not sent: the browser reads the one whose tab is pressed */}
      <DatasetPanels
        word={word}
        tabs={panels.map(({ dataset, title }) => ({ dataset, title }))}
        headline={{
          word: lead.word,
          transcription: lead.entries.find((entry) => entry.transcription)?.transcription ?? null,
        }}
      >
        <Panel
          panel={lead}
          history={history}
          locale={locale}
          t={t}
          termsNames={termsNames}
          languageLabel={nav('language')}
        />
      </DatasetPanels>
      <div className={styles.footer}>
        <WordSearch />
      </div>
    </div>
  );
}
