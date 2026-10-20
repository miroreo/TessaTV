# TessaTV — Architecture & Roadmap

This is the living reference for TessaTV's design and plan. It started as a planning
doc before any code existed; it's now kept in the repo so decisions and status don't
live only in chat history.

## Status (as of 2026-10-19)

Repo: https://github.com/miroreo/TessaTV (private).

- ✅ **M1 — Core domain + persistence + manual library + minimal UI.** Done. Manual
  filesystem import works end-to-end against a real library (movies + TV).
- ✅ **M2 — Metadata.** Both adapters done, tested, and live-verified. Default split:
  movies → TMDB, TV → TheTVDB (TheTVDB specifically for numbering/title accuracy — live
  sweep confirmed this: TMDB couldn't confidently match one show in the real library,
  TheTVDB resolved it correctly to its canonical title). `?provider=`/`{provider}` on the
  metadata routes can request the other provider explicitly. Auto-identify sweep
  (`autoIdentifyLibrary`, `POST /api/library/auto-identify`) picks the right provider per
  node's media kind, converges cleanly, and survives a transient provider failure on one
  node without losing the rest of the batch (see "Non-obvious implementation notes").
  Remaining from the original M2 scope, not yet done: wiring identification automatically
  *into* the import flow itself (today it's always a separate manual or sweep call), and a
  periodic metadata refresh job (needs the `jobs` package, which doesn't exist yet).
- ⬜ **M3 — Streaming + Jellyfin-compat phases 1–2.** Not started.
- ⬜ **M4 — Acquisition pipeline, first protocol.** Not started.
- ⬜ **M5 — Second protocol adapter.** Not started.
- ⬜ **M6 — Deeper Jellyfin-compat coverage.** Not started.
- ⬜ **M7 (stretch) — second media type (Music).** Not started.

Packages that exist today: `domain`, `persistence`, `config`, `library`, `metadata`
(TMDB + TheTVDB), `apps/server`, `apps/web`. Not yet built: `indexers`,
`download-clients`, `acquisition`, `streaming`, `jellyfin-compat`, `jobs`, `shared`.

## Context

TessaTV is a self-hosted application combining a Sonarr/Radarr-style automated media
acquisition/management pipeline with a Jellyfin-style streaming server.

The explicit goals driving every structural choice below:
- No unstated assumptions — every meaningful tradeoff was raised with the user and decided
  explicitly (see "Decisions" below).
- Code must be modular and must not repeat itself; abstraction is used wherever reasonably
  possible — most concretely, torrent and Usenet acquisition share one orchestration engine
  behind common `Indexer`/`DownloadClient` interfaces, and TV/Movies today (with Music/Books
  possible later) share one generic domain model instead of type-specific forks.
- Existing Jellyfin client apps should be able to connect to TessaTV directly via a
  Jellyfin-API-compatible layer, validated first against the official Jellyfin iOS app.

## Decisions (locked)

**Product scope**
- Full acquisition pipeline: monitor indexers, grab via download clients, auto-import —
  the Sonarr/Radarr model.
- Media types for v1: TV + Movies, built on a generic `MediaType` abstraction so Music/Books
  can be added later without reworking core domain, acquisition, or compat-layer code.
- Acquisition protocols: both torrent and Usenet/NZB from the start, unified behind one
  `Indexer` interface and one `DownloadClient` interface — this is the primary proof point
  for the "no duplicated logic" requirement.
- Metadata providers: TMDB **and** TheTVDB in v1 (TheTVDB specifically for TV
  season/episode-numbering edge cases TMDB handles less reliably). Started with TMDB only;
  TheTVDB is the agreed fast-follow once the `MetadataProvider` interface was proven.
- Jellyfin API compatibility: full REST surface, phased in (see Roadmap). Reference client
  for v1 validation is the **official Jellyfin iOS app** (confirmed testable on hand).
  Infuse, Findroid, and TV clients (Android TV/tvOS) are out of scope for now — not
  prioritized, revisit if/when that hardware becomes available.
- Hardware transcoding (VAAPI/NVENC/QSV) is in scope early, not deferred — moved up in the
  roadmap alongside the rest of the streaming subsystem.

**Deployment & stack**
- Single self-hosted app process, internally modular (clean package boundaries, could be
  split into services later without a rewrite). "Single instance" means one app process —
  Postgres runs as its own container, which is accepted.
- Backend: Node.js + TypeScript. Frontend: SvelteKit (TessaTV's own UI).
- Database: Postgres. ORM: **Drizzle** (plain-TS schema, no codegen, narrow per-package
  repository functions — fits the interface-driven module boundaries better than Prisma's
  generated client).
- Job scheduling (indexer polling, download monitoring, library scans, metadata refresh):
  **Postgres-backed polling** (a jobs table + advisory locks) — no Redis/BullMQ, since job
  volume here is low-throughput and latency-tolerant, and this avoids a third container.
- Process model: **one Node process, one HTTP listener** serving both the Jellyfin-compat
  API and the SvelteKit UI (SvelteKit's Node adapter mounted alongside the API routes).
- Monorepo tooling: **pnpm workspaces** (chosen specifically for its non-flat,
  symlink-based `node_modules` — it prevents a package from resolving a dependency it
  didn't explicitly declare, which is a real enforcement mechanism for the "no accidental
  coupling between modules" requirement, not just a convenience pick) + **Turborepo** for
  task graph/caching on top, + TS project references for compile-time import boundaries.
- Secrets: indexer/download-client credentials are **encrypted at rest** in Postgres
  (app-level encryption, key from an env-var secret) rather than stored plaintext. (Not
  yet implemented — no indexer/download-client credentials exist yet; revisit at M4.)
- Auth: **one shared user table** — a TessaTV account IS the Jellyfin-facing user; the
  compat layer issues Jellyfin-shaped tokens (`X-MediaBrowser-Token`) against the same
  account rather than maintaining a second parallel user system. (Not yet implemented —
  no auth exists yet; relevant starting at M3.)
- Dev environment: **Nix flake** (`flake.nix`) provides Node 22, pnpm, ffmpeg, and the
  Postgres client — `nix develop` before running any project command. Not an original
  locked decision, but a hard requirement of the actual dev machine.

## Architecture

### Repo layout

```
tessatv/
  apps/
    server/              # single Node/TS process: HTTP server, wires all modules together,
                          # mounts both the Jellyfin-compat API and the SvelteKit UI
    web/                  # SvelteKit app (TessaTV's own UI)
  packages/
    domain/               # core domain model: MediaType descriptor, LibraryNode, Unit,
                          # Release, Grab, QualityProfile. Pure, no I/O, depends on nothing.
    persistence/          # Postgres schema (Drizzle) + repository implementations of
                          # domain's repository interfaces. Only package that imports the ORM.
    indexers/
      newznab-protocol/    # shared Torznab/Newznab XML client (same underlying protocol)
      adapters-torrent/     # Torznab-based torrent indexer adapters
      adapters-usenet/      # Newznab-based Usenet indexer adapters
    download-clients/
      adapters-torrent/     # qBittorrent, Transmission adapters
      adapters-usenet/      # SABnzbd, NZBGet adapters
    acquisition/           # protocol- and media-type-agnostic orchestration:
                          # search -> decide -> grab -> monitor -> import
    metadata/              # MetadataProvider interface; TMDB + TheTVDB adapters (both done)
                          # adapters; cache decorator
    library/               # file organization, naming/rename, scanning, import pipeline
    streaming/             # ClientCapabilities/PlaybackPlan, FFmpeg/TranscodeSession
                          # orchestration, hardware-accel strategy selection — deliberately
                          # has no knowledge of Jellyfin's wire format
    jellyfin-compat/       # Jellyfin REST+WS wire-format translation layer only — zero
                          # business logic, talks to domain/streaming/library via their
                          # public interfaces
    jobs/                  # generic JobDefinition/JobRunner abstraction, Postgres-backed
                          # polling implementation
    config/                 # typed config loading/validation (zod), secrets handling
    shared/                  # cross-cutting utils/logging/error types — kept deliberately
                          # small to avoid becoming a dumping ground
  docker/
    docker-compose.yml       # app + postgres
    Dockerfile
  flake.nix                  # Nix dev shell: Node 22, pnpm, ffmpeg, postgresql client
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  eslint.config.js            # encodes the package dependency graph (see Boundary rule)
```

**Boundary rule**: `domain` depends on nothing; every other package depends inward on
`domain`'s interfaces, never on another package's implementation. `jellyfin-compat` only
calls into `domain` and `streaming` — never `indexers`, `download-clients`, or
`acquisition` — so the large Jellyfin-API surface stays decoupled from acquisition.
Enforced via pnpm's strict `node_modules` + TS project references (`exports` restricted to
each package's public barrel) + `eslint-plugin-boundaries` as a lint-time backstop.

### Core domain model

A generic `MediaType` descriptor (not a hardcoded enum used throughout business logic)
tells the engine, per type: hierarchy shape (flat `Unit` like a Movie vs. a container tree
like Series → Season → Episode, modeled as a recursive `LibraryNode`), identity scheme
(external IDs stored in a generic polymorphic `external_id` table — `entity_type`,
`entity_id`, `provider`, `provider_id` — rather than per-type ID columns), naming tokens for
the renamer, and a `ReleaseParser` for matching release filenames to identities. Adding
Music/Books later means a new descriptor + parser + metadata adapter — no changes to
`LibraryNode`, `Unit`, `Release`, acquisition orchestration, jobs, or the compat layer.

Key entities: `LibraryNode` (generic tree node), `Unit` (the thing that gets a file and
gets played — Episode/Movie/etc.), `MediaFile`, `Release` (indexer search result,
protocol-agnostic with a small `ReleasePayload` union for magnet vs NZB specifics),
`QualityProfile`/`QualityDefinition` (already type-agnostic), `Grab` (audit trail linking a
selected Release through to an imported MediaFile).

### Library / manual import (built)

`packages/library` scans a movies directory and a shows directory on disk and creates
`LibraryNode`/`Unit`/`MediaFile` rows via `domain`'s `LibraryRepository` port — this is the
M1 stand-in for the real acquisition-driven import pipeline. Idempotent: re-running
against the same paths skips anything already imported (movies matched by title at the
root, episodes matched by `(season, episode)` under their series/season, not by title).

Filename/foldername parsing is deliberately scoped to **documented, public conventions**,
not tuned against any one library's files (that was an explicit correction mid-build —
see git history around the parser-hardening commits):
- Movies: Radarr/Jellyfin's `Title (Year)` folder convention, tolerant of trailing
  provider-id tags (`{tmdb-123}`, `[imdbid-tt...]`). A movie's video file(s) must be
  **directly inside** its folder — deliberately not recursive, so a folder that happens to
  contain a nested duplicate library root gets reported as "no video file found" instead of
  being misidentified as one giant movie.
- TV episodes: tries, in order, `SxxExx` (modern), `NxEE` (legacy Kodi/XBMC-style), then
  absolute/anime-style numbering (season defaults to 1, since that convention carries no
  season info) — read from the filename itself, not the season-folder name, since real
  libraries have inconsistent/duplicate/empty season folders.

### Metadata (done)

`packages/metadata` defines `MetadataProvider` (`search`, `fetchDetails`) against generic
shapes, not any one provider's wire format. `TmdbMetadataProvider` and
`TvdbMetadataProvider` are the two adapters. `CachedMetadataProvider` wraps either so
`fetchDetails` reads/writes a persisted cache (`metadata_cache` table) instead of hitting
the provider's API per request — search results are intentionally never cached (one-off
disambiguation, not something to replay).

Provider selection, confirmed in a locked decision: **movies default to TMDB, TV defaults
to TheTVDB** (TheTVDB specifically for season/episode numbering and title accuracy — see
the real example below). `apps/server` wires both into a `MetadataProvidersByKind` map
(`{ movie: tmdb, series: tvdb }`, built in `index.ts`), and every metadata route accepts an
explicit `?provider=`/`{provider}` override to use the other one instead of the default.

Identification flow: `GET /api/library/:id/metadata/candidates` (search by the node's
title, optional `?year=`) → `POST /api/library/:id/metadata/identify {externalId}` (fetch
details, update the node's title + record the provider's external id) → `GET
/api/library/:id/metadata` (cached details). Restricted to root-level nodes (movies,
top-level series) — seasons/episodes aren't independently searchable. All three routes,
plus auto-identify below, return `503` for a media kind with no provider configured
(missing `TMDB_API_KEY`/`TVDB_API_KEY`), rather than crashing the app.

`POST /api/library/auto-identify` (`autoIdentifyLibrary` in `packages/library`) sweeps
every root node, picks the right provider for its media kind, and auto-applies the top
search candidate — the "auto" policy built on the same primitives as the manual flow.
Live-verified on the real library with both providers configured: 30 series + 26 movies,
0 errors, 0 no-matches. Concretely validated the TMDB→TheTVDB rationale in the same run:
one show ("...2018" baked into the title, no parens-year) had no confident TMDB match but
TheTVDB resolved it correctly to its canonical title. A failure on one node (e.g. a
transient network error) is recorded in the summary's `errors` list rather than aborting
the whole sweep — the first live run (TMDB-only, before this was added) hit exactly this,
a `fetch failed` mid-sweep that killed the whole batch with a 500. Known limitation, not
a bug: auto-applying the *top*
candidate can pick the wrong title for an ambiguous query (e.g. a short/generic title
matched the wrong film in the real library) — visible and correctable via the manual
`candidates`/`identify` endpoints, not silently wrong forever.

TheTVDB-specific quirks, confirmed empirically against the live API before writing any
code (not guessed from memory):
- Auth is a login step, not a static key: `POST /login { apikey }` returns a bearer token
  (confirmed valid ~1 month). `TvdbClient` caches it in memory and reactively re-logs-in
  exactly once on a `401`, rather than proactively tracking expiry.
- `GET /movies/{id}/extended` does **not** include overview text — only which languages a
  translation exists in. Getting the actual text needs a second call,
  `GET /movies/{id}/translations/eng`. Series' `extended` endpoint has no such gap.
- Artwork `type` ids are **not** shared between record types — confirmed via TheTVDB's own
  `/artwork/types` reference endpoint rather than assumed: series poster=2/background=3,
  movie poster=14/background=15. The top-level `image` field conveniently already gives
  the primary poster for both, so only backdrop needs an artworks-array lookup.

### Acquisition subsystem (not yet built)

One `Indexer` port (`search`, `fetchDownloadPayload`, `capabilities`) and one
`DownloadClient` port (`add`, `getStatus`, `remove`), each implemented by torrent and
Usenet adapters. Torznab and Newznab are the same underlying XML protocol, so both indexer
adapter families share a `newznab-protocol` helper package — the first concrete place the
no-duplication requirement bites. The `acquisition` package's orchestration
(search → decide → grab → monitor → import) is written once, parameterized by `MediaType`
and by which indexer/download-client instances are enabled; it has no protocol- or
media-type-specific branches. M4/M5 in the roadmap below exist specifically to prove this
holds when the second protocol is added.

### Streaming subsystem (not yet built)

`streaming` exposes `resolvePlaybackPlan(mediaFile, clientCapabilities)` and
`startTranscodeSession(plan)` using generic `ClientCapabilities`/`PlaybackPlan` shapes —
not Jellyfin's `DeviceProfile`/`PlaybackInfoResponse`. `jellyfin-compat` translates at the
boundary in both directions. Hardware-accel is a `HardwareAccel` strategy (none/VAAPI/
NVENC/QSV) selected via config/auto-detection, changing only the FFmpeg args produced by
the same `TranscodeSession` abstraction — built in from the streaming milestone, not bolted
on later.

### Jellyfin compatibility layer (not yet built)

Pure adapter/BFF: owns Jellyfin's routes, JSON shapes, auth header conventions, and
WebSocket session protocol; contains no business logic. Phased: (1) auth + server
discovery + read-only browse, (2) images/artwork, (3) direct play, (4) transcode
negotiation + HLS delivery + progress reporting, (5) deeper coverage (resume/watched state,
collections, playlists, favorites, search). Live TV is out of scope (different acquisition
model entirely) — stub as unsupported.

### Jobs (not yet built)

Generic `JobDefinition` (name, handler, trigger, concurrency/retry policy) + `JobRunner`
port, Postgres-backed polling implementation (jobs table, `next_run_at`, advisory locks for
single-instance safety). Indexer polling, download-status monitoring, library scans, and
metadata refresh all register `JobDefinition`s rather than using ad hoc timers.

## Roadmap

Reordered from the original acquisition-first sequence per an earlier decision to get a
watchable player working sooner, before both acquisition protocols are complete:

- **M1 — Core domain + persistence + manual library + minimal UI.** ✅ Done.
- **M2 — Metadata.** 🔄 In progress. TMDB adapter done and verified live; TheTVDB adapter
  next.
- **M3 — Streaming + Jellyfin-compat phases 1–2.** `streaming`'s `PlaybackPlan`/
  `TranscodeSession` (including hardware-accel strategy selection), plus compat-layer auth,
  browse, images, direct play, transcode negotiation, and HLS delivery — enough for the
  official Jellyfin iOS app to log in, browse, and play content end-to-end. This is the
  "watchable" milestone.
- **M4 — Acquisition pipeline, first protocol.** Full search→decide→grab→monitor→import
  flow for one `Indexer` + one `DownloadClient` adapter pair.
- **M5 — Second protocol adapter.** Add the other protocol family's adapters against the
  *same* `acquisition` orchestration code with zero changes to it — the explicit proof
  point for the no-duplication requirement. If this milestone needs changes to
  `acquisition`, that's a signal the interface needs revisiting before building further on
  it.
- **M6 — Deeper Jellyfin-compat coverage.** Resume/watched-state, collections, playlists,
  favorites, search; revisit Infuse/Findroid/TV-client support if/when that hardware
  becomes available.
- **M7 (stretch)** — second media type (Music), validating the `MediaType` abstraction
  holds for a different hierarchy shape (Artist → Album → Track).

## Verification

- **M1** ✅: `pnpm turbo run build test` across the workspace; manual import verified
  against a real library (movies + TV, including nested-folder and anime-numbering edge
  cases).
- **M2** 🔄: TMDB search/identify/cache verified live against a real imported movie,
  confirmed persisted in Postgres. TheTVDB verification pending that adapter's build.
- **M3**: connect the official Jellyfin iOS app to the running server, authenticate, browse
  the library, and play a file via both direct play and a forced-transcode path (including
  a hardware-accel path if test hardware supports it).
- **M4/M5**: for each protocol, configure a real (or sandboxed/test) indexer + download
  client, confirm a search → grab → import cycle completes; after M5, diff `acquisition`'s
  source against its M4 state to confirm no protocol-specific branching was added.
- **M6**: re-test the M3 playback flows plus resume/watched-state and collections in the
  iOS app after adding deeper compat coverage, confirming no regression.

## Developer quick reference

```bash
# Enter the dev shell (Node 22, pnpm, ffmpeg, postgresql client)
nix develop

# Install dependencies
pnpm install

# Start Postgres
docker compose -f docker/docker-compose.yml up -d postgres

# Generate / apply DB migrations (after changing packages/persistence/src/schema.ts)
pnpm --filter @tessatv/persistence db:generate
pnpm --filter @tessatv/persistence db:migrate

# Hot-reload dev loop for the server + web app (rebuilds/restarts on any dependency change)
pnpm exec turbo watch dev --filter=@tessatv/server --filter=@tessatv/web
# server: http://localhost:8096   web: http://localhost:5173 (proxies /api to the server)

# Build + test everything
pnpm turbo run build test

# Lint — MUST run from the repo root, not per-package (see note below)
pnpm lint

# Trigger a manual library import
curl -X POST http://localhost:8096/api/library/import \
  -H 'Content-Type: application/json' \
  -d '{"moviesPath":"/path/to/movies","showsPath":"/path/to/shows"}'

# Identify a movie/series against TMDB
curl http://localhost:8096/api/library/<id>/metadata/candidates
curl -X POST http://localhost:8096/api/library/<id>/metadata/identify \
  -H 'Content-Type: application/json' -d '{"externalId":"<tmdb id>"}'

# Auto-identify every un-identified item in the library at once
curl -X POST http://localhost:8096/api/library/auto-identify
```

`.env` (git-ignored) needs `DATABASE_URL`, `APP_SECRET` (32+ chars), and optionally
`TMDB_API_KEY` / `TVDB_API_KEY`. The server's `dev` script loads it via Node's native
`--env-file` flag — Turborepo does **not** forward the shell's exported env vars through
its task graph, so relying on `source .env` alone silently breaks under `turbo watch`.

### Non-obvious implementation notes

- `eslint-plugin-boundaries` only works when ESLint runs **once from the repo root**
  (`pnpm lint` → `eslint .`). Running it per-package (`eslint src` inside a package
  directory) silently does nothing — the plugin's path matching breaks under that cwd.
  It also needs `eslint-import-resolver-typescript` (not the plain `node` resolver) to
  correctly follow pnpm's symlinked workspace packages to their real path.
- Movie folder scanning is deliberately non-recursive — see "Library / manual import"
  above. This was a real bug caught during manual testing, not a design guess.
- Episode filename parsing is intentionally built against public conventions (Jellyfin's
  naming spec, Kodi/XBMC's `1x05`, fansub absolute numbering) rather than iteratively
  patched to fit one library's files — that distinction was an explicit course-correction
  mid-build.
- `tsx --watch` runs as a supervisor process that respawns a child worker on file
  changes — `ps aux` shows two node processes for the server (the outer one keeps
  `--watch` in its args, the respawned child doesn't). If something goes wrong and the
  child stops tracking changes, `ps aux | grep node` and killing the whole tree (not just
  one PID) is the reliable fix — this happened once mid-build and silently served stale
  code (no crash, no error) until caught by a live response not matching the latest code.
- Don't trust a running dev server's behavior as proof the latest code is deployed —
  verify the response shape itself changed (e.g. a new field you just added) before
  trusting live-test results, exactly because of the above.
