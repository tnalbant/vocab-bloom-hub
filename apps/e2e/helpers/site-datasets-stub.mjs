// The API of the website suite as an instance with two datasets (issue #538).
// The suite runs on SQLite, which holds one dataset, and the tabs of a word
// page need two: this server stands between the site and the API, passes
// every request on and adds the group of a second dataset to the read of
// every dataset of a few headwords. The entries of that group are made from
// an entry the API answers, so they keep the shape of the contract. The
// render of the site and the browser are answered alike: the page names the
// tabs and the browser reads the dataset of the one that is pressed.
import http from 'node:http';

const [port, api] = process.argv.slice(2);
if (!port || !api) throw new Error('usage: node site-datasets-stub.mjs <port> <the URL of the API>');

// Controlled API failures for the production SSR recovery tests. Each test
// uses a distinct spelling, so an earlier ISR page cannot hide the failure.
const failures = new Map();

const SECOND_DATASET = {
  dataset: 'wordnet',
  active: false,
  source: 'wordnet',
  dataset_version: '2025',
  license: 'CC-BY-4.0',
  license_url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Open English WordNet',
  attribution_url: 'https://en-word.net',
  notice: '',
  license_text: 'The notice of the second dataset, in full.',
};

// what the second dataset says: "run" the served one holds too, "footrace" it alone
const SECOND_DATASET_WORDS = {
  run: { title: 'a race run on foot', synonyms: ['footrace'] },
  footrace: { title: 'a race between people who run', synonyms: ['run'] },
};

const json = async (path) => {
  const res = await fetch(`${api}${path}`);
  return { status: res.status, body: await res.json() };
};

const entryOfSecondDataset = (template, word, id) => {
  const { title, synonyms } = SECOND_DATASET_WORDS[word];
  const [meaning] = template.meanings;

  return {
    ...template,
    id,
    word,
    part_of_speech: 'noun',
    source: SECOND_DATASET.source,
    modified: false,
    word_level: null,
    transcription: '/second/',
    description: null,
    forms: [],
    short_translations: [],
    meanings: [
      { ...meaning, id, title, definition: `definition of ${title}`, examples: [], translations: [], synonyms },
    ],
  };
};

// a headword is matched without regard to case, as the API matches it
const headwordOf = (segment) => decodeURIComponent(segment).toLowerCase();

const datasetsOf = async (word) => {
  // the entry the groups are shaped after: the verb "run" of the fixture
  const template = (await json('/v1/words/run')).body.data[0];
  const served = await json(`/v1/words/${encodeURIComponent(word)}/datasets`);
  const groups =
    served.status === 200
      ? served.body.data
      : [{ ...(await json('/v1/words/run/datasets')).body.data[0], word, variants: [], count: 0, entries: [] }];
  const data = [
    ...groups,
    {
      ...SECOND_DATASET,
      word,
      variants: [],
      count: 1,
      entries: [
        entryOfSecondDataset(template, word, 900_000 + Object.keys(SECOND_DATASET_WORDS).indexOf(word)),
      ],
    },
  ];

  return { data, meta: { word, datasets: data.length, found: data.filter((group) => group.count > 0).length } };
};

const bodyOf = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
};

// the headers of one hop, and the ones `fetch` has already taken care of
const NOT_FORWARDED = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'host',
];

const forward = async (req, res) => {
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !NOT_FORWARDED.includes(name)),
  );
  const answer = await fetch(`${new URL(api).origin}${req.url}`, {
    method: req.method,
    headers,
    body: await bodyOf(req),
    redirect: 'manual',
  });
  const body = Buffer.from(await answer.arrayBuffer());
  res.writeHead(
    answer.status,
    Object.fromEntries([...answer.headers].filter(([name]) => !NOT_FORWARDED.includes(name))),
  );
  res.end(body);
};

http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://stub').pathname;
      const control = /^\/api\/__test__\/word-failure\/([^/]+)$/.exec(path)?.[1];
      if (control) {
        if (req.method === 'POST') {
          failures.set(control, { remaining: JSON.parse(await bodyOf(req)), calls: 0 });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failures.get(control)));
        return;
      }
      const faultWord = /^\/api\/v1\/words\/([^/]+)(?:\/(datasets|history))?$/.exec(path);
      const scenario = faultWord && failures.get(faultWord[1]);
      if (req.method === 'GET' && scenario) {
        const [, spelling, suffix] = faultWord;
        if (!suffix) {
          scenario.calls++;
          const failure = scenario.remaining.shift();
          if (failure === 'disconnect') {
            req.socket.destroy();
            return;
          }
          if (failure) {
            res.writeHead(failure, {
              'content-type': 'application/json',
              'x-request-id': `test-${spelling}-${scenario.calls}`,
              ...(failure === 429 ? { 'retry-after': '1' } : {}),
            });
            res.end(JSON.stringify({ error: 'temporarily unavailable' }));
            return;
          }
        }
        const { body } = await json(`/v1/words/run${suffix ? `/${suffix}` : ''}`);
        body.meta.word = spelling;
        if (suffix === 'datasets') {
          body.data.forEach((group) => {
            group.word = spelling;
            group.entries.forEach((entry) => {
              entry.word = spelling;
            });
          });
        } else if (suffix !== 'history') {
          body.data.forEach((entry) => {
            entry.word = spelling;
          });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      const word = /^\/api\/v1\/words\/([^/]+)\/datasets$/.exec(path)?.[1];
      if (req.method === 'GET' && word && headwordOf(word) in SECOND_DATASET_WORDS) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await datasetsOf(headwordOf(word))));
        return;
      }
      await forward(req, res);
    } catch (error) {
      // what went wrong is for the log of the suite, not for whoever asked
      process.stderr.write(`site-datasets-stub: ${req.method} ${req.url} failed: ${String(error)}\n`);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('the API did not answer');
    }
  })
  .listen(Number(port));
