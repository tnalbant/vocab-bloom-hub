# Docker

Three published images — the API, the admin UI and the project website — and a
`docker-compose.yml` that adds Postgres.

| Image                                         | What                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `ghcr.io/fristail27/vocab-bloom-hub-server`   | the API (NestJS), port 3010                                           |
| `ghcr.io/fristail27/vocab-bloom-hub-frontend` | the admin UI (Next.js), port 3000                                     |
| `ghcr.io/fristail27/vocab-bloom-hub-site`     | the website (Next.js), port 3020 — the `site` profile, off by default |

All three are built for `linux/amd64` and `linux/arm64`. The tags:

| Tag                 | Built from                | Use it for                                                      |
| ------------------- | ------------------------- | --------------------------------------------------------------- |
| `1.2.3`, `1.2`, `1` | the release tag `v1.2.3`  | production — pin `1.2` to get patch releases, `1.2.3` to freeze |
| `latest`            | the newest stable release | trying it out                                                   |
| `1.1.0-beta.1`      | a prerelease tag          | exactly that prerelease; no `latest`, no floating tag           |
| `main`, `sha-…`     | every push to `main`      | following development; may break between pushes                 |

`docker-compose.yml` defaults to `main`; production pins a release with `VBH_TAG` in `.env`.

## Quick start

No checkout needed — the compose file and the environment template are enough:

```bash
mkdir vocab-bloom-hub && cd vocab-bloom-hub
curl -fsSLO https://raw.githubusercontent.com/Fristail27/vocab-bloom-hub/main/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/Fristail27/vocab-bloom-hub/main/.env.example -o .env
# edit .env: ADMIN_PASSWORD, POSTGRES_PASSWORD (and VBH_TAG to pin a release, e.g. 1.1.0)
docker compose up -d               # pulls the images, starts Postgres, the API, the UI
curl -s localhost:3240/api/ready   # {"status":"ok"} once migrations ran and the dictionary is in
```

The admin UI is at `http://localhost:3241`, the API at `http://localhost:3240`, both published
on **localhost only**. The dictionary loads itself on the first start (next section).

## First start: the dictionary loads itself

The compose file sets `DICTIONARY_AUTO_IMPORT=true`: on a start with no recorded dataset
version the server loads the published dictionary (~300 k entries) from HuggingFace — or from
the newest dataset in `./imports` when one is there ([`../offline-import.md`](../offline-import.md)).
The download and the import take a few minutes each. Meanwhile:

- `docker compose logs -f server` shows the progress;
- `GET /api/ready` answers `503 { "status": "error", "reason": "importing", "percent": 37, "stage": 0 }`
  while `GET /api/health` is `200`;
- the admin UI signs in and shows a progress banner; the public API answers with what is loaded
  so far.

When it is done `/api/ready` is `200` and `GET /api/v1/meta` shows the counts and
`dataset_version`. Later starts do nothing. An interrupted import resumes on the next start. A
failed one (HuggingFace unreachable) answers `503 import_failed`, and the next start tries
again — or import from a file through the card of the dataset on the admin's datasets page. `DICTIONARY_AUTO_IMPORT=false` keeps
an instance empty on purpose.

Everything the containers need comes from `.env` ([`../environment.md`](../environment.md));
`docker compose` reads the same file for its own variables (`POSTGRES_*`, the host ports,
`VBH_TAG`).

> [!TIP]
> Another file:
> `ENV_FILE=/etc/vocab-bloom-hub/.env docker compose --env-file /etc/vocab-bloom-hub/.env up -d`.

## Additional dictionaries

On PostgreSQL, install Wiktionary, either WordNet or OpenGloss from its card on the datasets
page. **Download on the server** needs outgoing access from the server container to the
catalog URLs (and their download redirects). Manual upload works without that access.
OpenGloss downloads six files totalling about 1.32 GB; allow temporary space for conversion
as well as the final database. These source downloads use the container's temporary directory,
not the read-only `./imports` mount. `DICTIONARY_AUTO_IMPORT` still fills only `default`.
See [datasets](../datasets.md#installing-a-dataset).

## What is in `docker-compose.yml`

| Service    | Image                                                        | Notes                                                                                                                                                               |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `postgres:17-alpine` (profile `db`)                          | Data in the named volume `postgres-data`; `pg_isready` healthcheck; credentials from `POSTGRES_*` in `.env`; `shm_size: 256m`; not started for an external database |
| `server`   | `ghcr.io/…/vocab-bloom-hub-server:${VBH_TAG}`                | Retries the database for a minute, runs pending migrations on start, listens on `3010`; `./imports` mounted read-only as `DICTIONARY_IMPORT_DIR`                    |
| `frontend` | `ghcr.io/…/vocab-bloom-hub-frontend:${VBH_TAG}`              | The standalone Next.js build on `3000`; server-side rendering reaches the API at `http://server:3010/api` (`API_INTERNAL_URL`)                                      |
| `site`     | `ghcr.io/…/vocab-bloom-hub-site:${VBH_TAG}` (profile `site`) | The project website on `3020` ([below](#the-website)); the word pages reach the API at `http://server:3010/api` (`API_INTERNAL_URL`)                                |

Host ports come from `SERVER_PORT` / `FRONT_PORT` / `SITE_PORT` in `.env` (defaults `3240` /
`3241` / `3242`, chosen away from the `3000` and `9090` other tools take; the observability
overlay continues with `3243` and `3244`); inside the containers the apps always listen on
`3010` / `3000` / `3020`, which are also the ports of a start without Docker.

**Without a reverse proxy** (a workstation, a LAN) the browser calls the API under the page origin
— `http://localhost:3241/api/…` — and the frontend forwards `/api/*` to the server
(`API_INTERNAL_URL`), cookies and progress streams included.

> [!WARNING]
> The admin cookie is plain on `http://`; the server logs a warning at every such login.

**With a reverse proxy** — production — Caddy or nginx on the host terminates TLS, forwards
`/api/*` to `127.0.0.1:3240` and everything else to `127.0.0.1:3241`
([`reverse-proxy.md`](./reverse-proxy.md)); the frontend's forwarding is then never used.

### Bundled or external Postgres

The `postgres` service is the compose profile **`db`**: `COMPOSE_PROFILES=db` in `.env` (the
template's default) starts it, and the server connects with the `POSTGRES_*` credentials. For a
database of your own — a managed instance, a Postgres on the Docker host — remove the profile
and set `DATABASE_URL`; `docker compose up -d` then starts the two apps only, and the server
migrates that database on start and loads the dictionary into it if it is empty. Both options
side by side, the `host.docker.internal` gotcha, `shm_size` for a Postgres container of your
own, backups: [`../database.md`](../database.md#two-ways-to-run-postgres).

### The website

The `site` service serves the project website next to _this_ instance: the documentation
(rendered from the repository's Markdown at build time), the public API reference and the
playground ([`../api-tools.md`](../api-tools.md)), and word pages — `/en/word/run` — rendered
from `GET /api/v1/words/run` of the instance, the search-engine entry points of a public
dictionary. Off by default; to have it:

```dotenv
COMPOSE_PROFILES=db,site
INTERNAL_API_TOKEN=<openssl rand -hex 32>          # the site's own API traffic, outside the public rate limit
# SITE_PORT=3242                                   # the host port
```

`docker compose up -d` then pulls the third image and the site answers on
`http://localhost:3242`. Behind the reverse proxy a public instance routes `/` to the site and
`/api/*` to the server ([`reverse-proxy.md`](./reverse-proxy.md#c-public-only-instance)); the
admin UI stays on another hostname or off (`ADMIN_API_ENABLED=false`). Like the admin UI, the
site calls the API under its own origin (`NEXT_PUBLIC_BASE_API_URL=/api`) and forwards `/api/*`
to `API_INTERNAL_URL` itself when no proxy does. The site of a given tag documents that tag;
the word pages are rendered on request and cached for an hour.

Compose waits for the server's `/api/ready` probe before starting the site, including
migrations and the automatic first-start import. The admin UI can start earlier, so the
operator can inspect a failed import. The readiness healthcheck allows up to 30 minutes
of startup grace for a fresh dictionary download; a successful probe releases the site
immediately. This controls startup order, not uninterrupted availability during an update:
an already-running site can still see an API restart.

Word-page API reads retry one network failure or `502`/`503`/`504` after one second, and
honour a short `Retry-After` (up to five seconds, also for `429`). The retry makes a fresh
request even within the same render. If the word still cannot be read, the page answers
`500` without caching that failure. The site logs `dictionary_api_unavailable` with the
API status, `request_id` and `retry_after`, or the connection error code. Compare it with
`docker compose logs --since 10m server site`; tokens and response bodies are not logged.

`INTERNAL_API_TOKEN` is a secret the two containers share (both read `.env`): the site's
server-side requests to the API — a word page being rendered, the daily walk of
`GET /api/v1/words` behind its sitemaps and `/word/browse` — carry it and are not counted against
`PUBLIC_API_RATE_LIMIT`. Without it they all come from the site's one address and share one
budget: the walk empties it, and a word page rendered in the meantime answers `500`.

> [!IMPORTANT]
> The public origin of the site — the canonical and hreflang links, the social cards,
> `sitemap.xml`, `robots.txt` — is baked in when the image is **built**: `NEXT_PUBLIC_SITE_URL`
> has no effect on a pulled image. The published image is the project's own website and says
> `https://vocab-bloom-hub.com`. For a website under your own hostname build it from a checkout,
> with the variable in `.env`:
>
> ```bash
> echo 'NEXT_PUBLIC_SITE_URL=https://dict.example.com' >> .env
> docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build site
> ```

#### Search engines

The site is built for them: one canonical URL per page (`/en/word/Bloom` redirects to
`/en/word/bloom`, an untranslated documentation page points at its English original), hreflang
links for the languages a page exists in, a description and a social card on every page,
structured data (`WebSite`, `BreadcrumbList`, `TechArticle`, `DefinedTerm`), and two sitemaps
named in `robots.txt`: `sitemap.xml` for the static pages and `sitemap-words.xml`, a sitemap
index over the dictionary's headwords — one file of 2 500 headwords in every interface language,
built from a walk of `GET /api/v1/words` that the site does once a day in the background (it
honours the public rate limit, waits for the instance to be ready, and answers `503` with
`Retry-After` until the first walk is through). `/word/browse` is the crawlable A–Z index of the
same list. The word and browse pages are regenerated on demand and kept for an hour, and say so
to a cache in front of the site (`Cache-Control: s-maxage=3600, stale-while-revalidate=86400`).

To watch the site in the webmaster tools, verify the origin — by DNS, which needs nothing here,
or by the meta tag, whose token is a **build** variable next to `NEXT_PUBLIC_SITE_URL`
(`SITE_VERIFICATION_GOOGLE`, `SITE_VERIFICATION_BING`, `SITE_VERIFICATION_YANDEX`,
[`../environment.md`](../environment.md)) — then submit both sitemaps in Google Search Console,
Bing Webmaster Tools and Yandex Webmaster. That registration is a manual step; nothing in the
compose stack does it.

## Everything together

The instance with its bundled database, the website and the metrics stack, on one host — what a
full installation looks like. No checkout is needed, but the observability overlay mounts its
configuration from an `observability/` folder next to the compose files, so those five small
files come along:

```bash
mkdir vocab-bloom-hub && cd vocab-bloom-hub
BASE=https://raw.githubusercontent.com/Fristail27/vocab-bloom-hub/main

curl -fsSLO $BASE/docker-compose.yml
curl -fsSLO $BASE/docker-compose.observability.yml
curl -fsSL  $BASE/.env.example -o .env
for f in prometheus.yml \
         alerts.yml \
         grafana/dashboards/vocab-bloom-hub.json \
         grafana/provisioning/dashboards/provider.yml \
         grafana/provisioning/datasources/prometheus.yml; do
  curl -fsSL --create-dirs $BASE/observability/$f -o observability/$f
done
```

(`git clone` gives the same files. To pin a release, replace `main` in `BASE` with its tag,
`v1.1.0`, and set `VBH_TAG=1.1.0`: the dashboard and the configuration then match the images.)

In `.env`:

```dotenv
ADMIN_PASSWORD=…                 # the admin login
POSTGRES_PASSWORD=…              # the bundled database
COMPOSE_PROFILES=db,site         # the database and the website next to the two apps
# GRAFANA_ADMIN_PASSWORD=…       # admin / admin otherwise
```

Start it with both compose files:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
curl -s localhost:3240/api/ready   # 503 while the dictionary loads, then {"status":"ok"}
```

| Service    | Address                 | Port variable     |
| ---------- | ----------------------- | ----------------- |
| API        | `http://localhost:3240` | `SERVER_PORT`     |
| Admin UI   | `http://localhost:3241` | `FRONT_PORT`      |
| Website    | `http://localhost:3242` | `SITE_PORT`       |
| Prometheus | `http://localhost:3243` | `PROMETHEUS_PORT` |
| Grafana    | `http://localhost:3244` | `GRAFANA_PORT`    |

Everything is published on **localhost only**; Postgres is not published at all. To move a
service, set its variable in `.env` — nothing inside the compose network changes, the apps keep
talking to each other on their container ports. Only `CORS_ORIGINS` follows the admin UI and the
website, and only for browsers that call the API directly.

The state lives in three named volumes that survive `docker compose down`: `postgres-data` (the
dictionary), `prometheus-data` (the metrics, `PROMETHEUS_RETENTION`, 15 days) and `grafana-data`
(Grafana's own settings). `./imports` is a read-only bind mount for datasets loaded from a file.

> [!IMPORTANT]
> Pass both `-f` files to every later command — `pull`, `up -d`, `logs`, `down`. With the first
> file alone compose treats Prometheus and Grafana as orphans (`down` leaves them running) and
> `up -d` recreates the server without its metrics endpoint.

What the dashboard shows and how to scrape an instance with a Prometheus of your own:
[`../observability.md`](../observability.md#prometheus--grafana-in-docker). Putting it on a
domain: [`reverse-proxy.md`](./reverse-proxy.md).

## Building the images yourself

Forks and unpublished changes build from the checkout with the override file (a whole
installation done this way, on a VPS, with its update script: [`vps.md`](./vps.md)):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
# or one image at a time, from the repository root
docker build -f apps/server/Dockerfile   -t ghcr.io/fristail27/vocab-bloom-hub-server:main   .
docker build -f apps/frontend/Dockerfile -t ghcr.io/fristail27/vocab-bloom-hub-frontend:main .
docker build -f apps/site/Dockerfile     -t ghcr.io/fristail27/vocab-bloom-hub-site:main     .
```

Multi-stage builds on `node:22-alpine`, from the **repository root** (the workspace install
needs every `package.json`; the frontend and the site import types from the server workspace):

- **server** — Nest build, then a runtime stage with `dist/` and the production dependencies of
  the `server` workspace only. Runs `node dist/src/main.js` as user `node`, so SIGTERM reaches
  the server directly and it drains within `SHUTDOWN_TIMEOUT`
  ([`README.md`](./README.md#stopping-and-restarting)). `HEALTHCHECK` on `GET /api/health`.
- **frontend** — `next build` with `output: 'standalone'`; the runtime stage holds `server.js`,
  the traced `node_modules`, `.next/static` and `public`. `HEALTHCHECK` on `GET /en/login`.
- **site** — the same shape; the build stage also copies the READMEs, `docs/`, the licences and
  the OpenAPI document the pages are rendered from. `HEALTHCHECK` on `GET /en`.

> [!IMPORTANT]
> **`NEXT_PUBLIC_BASE_API_URL` is a build argument**: `next build` inlines it into the browser
> bundle, so starting the container with another value changes nothing.

The published images use the default `/api` — "the API is under the page's origin", which is what
the reverse proxy provides — so one image serves every hostname. Only an API on another origin
needs your own build:
`NEXT_PUBLIC_BASE_API_URL=https://api.example.com/api docker compose -f docker-compose.yml -f docker-compose.build.yml build frontend`
(plus `CORS_ORIGINS` on the server). Server-side rendering uses `API_INTERNAL_URL`, a runtime variable, instead.

## How the images are published

`.github/workflows/docker.yml` builds each image on a native runner per platform and merges them
into one multi-platform manifest with the tags above and the OCI labels that link the package to
the repository; a pull request that touches a Dockerfile builds the amd64 image without pushing.
The packages live at <https://github.com/Fristail27?tab=packages>.

> [!NOTE]
> GHCR creates a package **private** on its first push; until the owner makes it public,
> `docker compose up` needs `docker login ghcr.io`.

## Operating

- **Logs**: `docker compose logs -f server` — one JSON line per request (the images run with
  `NODE_ENV=production`). Fields, `jq` recipes and shipping them to a collector:
  [`../observability.md`](../observability.md#logs).
- **Probes**: `GET /api/health` and `GET /api/ready` ([`README.md`](./README.md#probes)). The
  server image checks liveness by default; Compose overrides this with readiness to gate
  website startup. An unreachable database makes the server unhealthy without restarting
  it (Docker's restart policy does not restart a running unhealthy container). The frontend
  and site healthchecks still check their own pages.
- **Metrics with dashboards**: `docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d`
  adds a local Prometheus + Grafana with a provisioned dashboard and alert rules — the files
  it needs and the whole stack in one place: [Everything together](#everything-together);
  the metrics themselves: [`../observability.md`](../observability.md#prometheus--grafana-in-docker),
  the alerts: [`../observability.md`](../observability.md#alerts).
- **Upgrade**: back up the database, bump `VBH_TAG`, `docker compose pull && docker compose up -d`;
  migrations run when the new server starts, rollback is the backup — step by step, for a build
  from a checkout too: [`../upgrading.md`](../upgrading.md); what it does to the database:
  [`../operations.md`](../operations.md#upgrading-the-code).
- **Migrations as an explicit step**:
  `docker compose run --rm server node ../../node_modules/typeorm/cli.js migration:run -d dist/src/db/data-source.js`
  ([`../migrations.md`](../migrations.md)).
- **Datasets from a folder**: drop an exported archive into `./imports` on the host; the import
  page lists it ([`../offline-import.md`](../offline-import.md)).

> [!CAUTION]
> The data lives in the `postgres-data` volume, not in the images: `docker compose down` keeps it,
> `down -v` deletes it.

CI builds the three images from the checkout and runs `docker compose up` against them on every
pull request, probing `/api/ready`, the login page and the website.
