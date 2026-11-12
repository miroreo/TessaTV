# TessaTV — Architecture & Roadmap

This is the living reference for TessaTV's design and plan. It started as a planning
doc before any code existed; it's now kept in the repo so decisions and status don't
live only in chat history.

## Status (as of 2026-11-10)

Repo: https://github.com/miroreo/TessaTV (private).

- ✅ **M1 — Core domain + persistence + manual library + minimal UI.** Done. Manual
  filesystem import works end-to-end against a real library (movies + TV).
- ✅ **M2 — Metadata.** Fully done, including both original loose ends. Both adapters
  tested and live-verified. Default split: movies → TMDB, TV → TheTVDB (TheTVDB
  specifically for numbering/title accuracy — live sweep confirmed this: TMDB couldn't
  confidently match one show in the real library, TheTVDB resolved it correctly). Identify
  is now wired automatically into import (`POST /api/library/import` runs
  `autoIdentifyLibrary` on newly-created items as part of the same call) and
  `packages/jobs` provides a Postgres-backed scheduler running a daily
  `refreshLibraryMetadata` job to keep identified metadata current. Caught and fixed a real
  bug along the way: import matched existing items by `title`, but identify overwrites
  `title` — so re-running import after identification created an ever-growing duplicate
  every time. Fixed with a `sourceKey` field (the stable, original scanned folder name,
  never touched by identify) that import now matches on instead. Verified live:
  re-importing the full real library twice in a row now gives `created: 0` both times.
  Follow-up: fixing `sourceKey` surfaced a side effect — two *different* source folders
  for the same real show (e.g. "Ink Master" / "Ink.Master", split across seasons) no
  longer get accidentally merged by a title-matching coincidence. Built
  `mergeDuplicateSeries`/`confirmSeriesMerge` to handle this properly: root series nodes
  sharing an external id get auto-merged when the match is unambiguous (re-checked by
  re-searching each side's original folder-derived title), otherwise reported `pending`
  for `POST /api/library/merge-duplicates/confirm`. Wired into the end of
  `POST /api/library/import` automatically. Live-verified on the real "Ink Master" case —
  confirmed `pending` (TheTVDB has multiple similarly-named entries, correctly not
  auto-merged), then confirmed explicitly: one node survives with both seasons' full
  episode counts intact, and re-running the sweep afterward finds nothing left to merge.
  This also caught a second real bug — see "Non-obvious implementation notes".
- 🔄 **M3 — Streaming + Jellyfin-compat phases 1–2.** In progress. Sequencing decided:
  build `streaming` first (self-contained, verifiable with real ffmpeg/ffprobe against real
  library files, no client needed), *then* `jellyfin-compat` on top of a working playback
  engine. **`packages/streaming` is built** (see "Streaming subsystem" below): ffprobe
  probing, `resolvePlaybackPlan`, ffmpeg HLS `TranscodeSession`, and a `HardwareAccel`
  strategy with `none`/`vaapi` implemented. Live-verified on this machine: ffprobe parses
  2124/2125 real library files (the one failure is a genuinely 0-byte file on disk), and
  remux + software transcode + VAAPI transcode all succeed on a representative sample
  (HEVC 8/10-bit, AV1 10-bit + Opus, Hi10P H.264, XviD AVI, PGS-subtitled BluRay) — VAAPI
  encodes ~1.7–3.5× faster than software with first playlist ready in ~0.4–1.0s.
  **Playback, player and watch history are built** (see "Playback, UI and watch history"
  below) and verified end-to-end in headless Chromium against the real library. `jellyfin-compat` exists with discovery only
  (`/System/Info/Public`, `/System/Ping`); the SvelteKit UI is served by the Node process
  at the root — see the Jellyfin Mobile decision below for why. **Auth is built** (see
  "Auth" below): first-run setup page, login/logout, and every `/api` route locked behind
  a session — verified end-to-end in headless Chromium against a throwaway database.
  **Next:** deploy to the real server; then Jellyfin Mobile's native player via
  `window.NativeShell` (the web player is used inside its web view for now). Live client testing is the plan
  for the compat phase: the dev server's `PORT` was moved to **8080** (still binds
  `0.0.0.0`) specifically so the official Jellyfin iOS app can connect to this machine
  over LAN (`http://10.8.128.8:8080`) or Tailscale (`http://100.97.251.108:8080`) as each
  phase lands — update these addresses if they've changed. `apps/web`'s Vite proxy was
  updated to match (`/api` → `localhost:8080`). This machine has a real AMD iGPU with
  VAAPI support (`/dev/dri/renderD128`) — the `HardwareAccel` strategy is scoped to
  `none`/`vaapi` for now (actually verifiable here) rather than guessing at NVENC/QSV
  blind, structured so those slot in later without changing the abstraction.
- ✅ **Library-first refactor (2026-11-09).** Nine PRs, all merged: pg-boss, zod request
  validation, @fastify/cookie, ky, @ctrl/video-filename-parser, Argon2, execa (short commands),
  shared `/api` types, and a daisyUI UI. This is now a standing rule — see "Library-first"
  under Decisions. Migration 0005 drops the old `scheduled_job` table; pg-boss creates its
  own `pgboss` schema on first start.
- ⬜ **M4 — Acquisition pipeline, first protocol.** Not started.
- ⬜ **M5 — Second protocol adapter.** Not started.
- ⬜ **M6 — Deeper Jellyfin-compat coverage.** Not started.
- ⬜ **M7 (stretch) — second media type (Music).** Not started.

Packages that exist today: `domain`, `persistence`, `config`, `library`, `metadata`
(TMDB + TheTVDB), `jobs`, `streaming`, `auth`, `jellyfin-compat` (discovery only),
`apps/server`, `apps/web`. Not yet built: `indexers`, `download-clients`, `acquisition`,
`shared`.

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
- **"Official Jellyfin iOS app" = Jellyfin Mobile (jellyfin-expo), and it gets TessaTV's own
  UI** (decided 2026-10-20). Confirmed from its source: it only calls
  `/system/info/public` (requires `ProductName === "Jellyfin Server"`), then loads the
  server root in a web view with injected `window.NativeShell` hooks (native video/audio
  player via `ExpoVideoPlayer.play {url, backdropUrl}`, fullscreen, a Jellyfin device
  profile in `window.ExpoVideoProfile`). It does not need jellyfin-web — any page works.
  Chosen over serving the stock jellyfin-web bundle: the SvelteKit UI is served at the
  server root (explicit Fastify routes — `/api`, `/health`, Jellyfin's routes — win; any
  other GET falls through to SvelteKit) and calls the NativeShell hooks when present. Since
  routing is case-insensitive for Jellyfin clients, UI page paths must never collide with
  Jellyfin route names (`/Items`, `/Users`, `/System`, …).
  Consequence: for M3, Jellyfin Mobile exercises only the compat layer's discovery
  endpoint; the Jellyfin REST surface (Jellyfin-style login/browse/playback) is deferred
  until a native REST client (Swiftfin, Infuse) is targeted.
- **First user is created through a first-run setup page** in the UI (only available
  while no users exist), not env vars or a CLI. Once auth works, TessaTV's own `/api` is
  locked down behind login.
- Hardware transcoding (VAAPI/NVENC/QSV) is in scope early, not deferred — moved up in the
  roadmap alongside the rest of the streaming subsystem.

**Library-first (decided 2026-11-09)**

The owner asked for a full refactor to cut unnecessary overhead, then made it a standing
rule for all future work:
- Where a maintained open source library does the job, use it instead of hand-rolled code.
  Check for one *before* writing a parser, HTTP client, validator, or helper.
- Repeat code only when strictly necessary. Types shared by the server and the UI live in
  one place (`packages/domain/src/api.ts`), not copied on each side.
- UI and design components come from open source libraries: **daisyUI** (Tailwind classes,
  no JS components) with plain Svelte for the wiring — chosen over shadcn-svelte, Skeleton
  and Flowbite.
- Make no assumptions. If a choice between libraries (or between a library and our own code)
  isn't clear, ask.

How to apply it, learned from the nine refactor PRs (#1–#9, all merged):
- A library replaces our code only if it doesn't make results worse. Keep a thin wrapper of
  our own where the library falls short, and say why in a comment.
- Wrap a library behind our own narrow interface at the edges that matter for testing or
  swapping (`MetadataProvider`, `JobDefinition`/`JobScheduler`, `ProcessSpawner`,
  `AuthService`). Don't re-export a library's whole surface through our packages.
- Don't adopt a library that is unmaintained (fluent-ffmpeg is archived) or that fights a
  locked decision (a full auth framework like better-auth would fight the Jellyfin token flow).
- Weigh the dependency against the code it removes: the execa swap saves only ~10 lines, and
  was offered to the owner as optional for that reason.

What replaced what, and what was deliberately kept:
- Job scheduling: **pg-boss** replaced the hand-rolled polling `JobRunner` (adds cron,
  retries and locking; its `pgboss` schema replaced the `scheduled_job` table).
- API validation: **fastify-type-provider-zod** replaced hand-written `typeof` body checks.
- Cookies: **@fastify/cookie** replaced the hand-rolled cookie parser/builder.
- Metadata HTTP: **ky** for the TMDB and TheTVDB clients (real HTTP error detection via
  `isHTTPError` instead of searching error text for "404"; TheTVDB's re-login-and-retry on a
  401 uses ky's retry hook). The response types stay hand-written; **tmdb-ts** was considered and skipped (a third-party SDK to keep up
  with, and TheTVDB would still need our own client).
- Episode filename parsing: **@ctrl/video-filename-parser** (a port of Sonarr's parser).
  *Kept:* our own folder-name parser (`parse-title-year.ts`), because the library mangles
  names like `Example..Show (2012)`.
- Passwords: **@node-rs/argon2** (Argon2id) replaced scrypt; old scrypt hashes still verify
  and are rehashed on the next login.
- Processes: **execa** for short-lived commands only (ffprobe, subtitle extraction and the
  like, via `runCommand`).
  *Kept:* plain `spawn` for long-running ffmpeg transcodes, because the session listens to
  the process's events directly, and our own ffmpeg argument builder (fluent-ffmpeg is archived).
- Shared `/api` types in `packages/domain/src/api.ts`, used by `apps/server` and `apps/web`.
- Playback file serving: **@fastify/send** (Range, ETag, content-type) instead of hand-rolled
  Range parsing; probe/subtitle caching: **lru-cache**. Subtitle re-timing after a seek was
  removed rather than replaced: the browser's own WebVTT parser exposes cues the player
  shifts directly.
- Player UI: kept as our own Svelte controls styled with daisyUI (owner's call, 2026-11-09)
  — they span the whole file and restart the transcode on seeks past the transcoded range,
  which off-the-shelf players' sliders don't model. A player library (Vidstack, Plyr) is
  a possible follow-up.
- UI: rebuilt on **daisyUI 5 + Tailwind v4**.

**Deployment & stack**
- Single self-hosted app process, internally modular (clean package boundaries, could be
  split into services later without a rewrite). "Single instance" means one app process —
  Postgres runs as its own container, which is accepted.
- Backend: Node.js + TypeScript. Frontend: SvelteKit (TessaTV's own UI).
- Database: Postgres. ORM: **Drizzle** (plain-TS schema, no codegen, narrow per-package
  repository functions — fits the interface-driven module boundaries better than Prisma's
  generated client).
- Job scheduling (indexer polling, download monitoring, library scans, metadata refresh):
  **pg-boss** (Postgres-backed queue and cron, in its own `pgboss` schema) — no Redis/BullMQ,
  since job volume here is low-throughput and latency-tolerant, and this avoids a third container.
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
  account rather than maintaining a second parallel user system. Accounts/sessions live in
  `packages/auth` (decided 2026-10-20), used by `apps/server` now and by `jellyfin-compat`
  later (the lint boundary already allows it). Jellyfin-shaped tokens aren't issued yet —
  no Jellyfin REST client is targeted in M3.
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
    jobs/                  # JobDefinition/JobScheduler, a thin wrapper over pg-boss
                          # (done — one job registered so far)
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
against the same paths skips anything already imported. Matching uses `LibraryNode.sourceKey`
(the raw scanned folder name, e.g. movies by folder name at the root, series by folder
name at the root, episodes by `(season, episode)` under their series/season) — **never**
`title`. This was a real bug, not a design guess: once auto-identify got wired into
import, every re-import of an already-identified item created a duplicate, because
identify overwrites `title` with the provider's canonical name and the matching logic used
to key on `title`. `sourceKey` is set once at creation and never touched again. One
side effect worth knowing: two *different* source folders that happen to be the same real
show (e.g. a library with both `Ink Master` and `Ink.Master` folders for different
seasons) are no longer accidentally merged by a title-matching coincidence — each becomes
its own series node, and both independently resolve to the same external id on identify.
This was deliberately requested as a real feature rather than left alone — see
`mergeDuplicateSeries` under "Metadata" below.

Filename/foldername parsing is deliberately scoped to **documented, public conventions**,
not tuned against any one library's files (that was an explicit correction mid-build —
see git history around the parser-hardening commits):
- Movies: Radarr/Jellyfin's `Title (Year)` folder convention, tolerant of trailing
  provider-id tags (`{tmdb-123}`, `[imdbid-tt...]`). A movie's video file(s) must be
  **directly inside** its folder — deliberately not recursive, so a folder that happens to
  contain a nested duplicate library root gets reported as "no video file found" instead of
  being misidentified as one giant movie.
- TV episodes: parsed by `@ctrl/video-filename-parser` (a port of Sonarr's parser) — `SxxExx`,
  `NxEE`, absolute/anime-style numbering (season defaults to 1, since that convention carries
  no season info), and a multi-episode file is read as its first episode (one file = one
  Unit) — read from the filename itself, not the season-folder name, since real
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

The candidates route searches by the node's `sourceKey` (folder name, with its `(Year)`),
**not** `title`: after a wrong identify `title` is already the wrong match's canonical name, so
searching it would just find the same wrong answer. `?query=` overrides with typed text, and
the response carries `source` (the folder name) and `query`. The UI's "Fix match" button on a
title page (admins only; `IdentifyDialog.svelte`) lists those candidates with poster, title,
year and overview beside the scanned folder name, and applies the pick via `identify`.

**Episode titles** (`syncEpisodeTitles` / `syncSeriesEpisodeTitles`): an episode's title is
first guessed from its filename, and a rescan matches an existing episode by `(season,
episode)` and only repoints its file, so a bad guess used to stay forever. `MetadataProvider`
has an optional `fetchEpisodes`; `TvdbMetadataProvider` implements it
(`/series/{id}/episodes/default/eng`, paged, aired order; cached by `CachedMetadataProvider`
under `episodes:<id>`). The sync sets each episode node + unit title to the provider's name
for that season/episode, skipping episodes the provider doesn't list (absolute-numbered anime
mapped to season 1 mostly won't line up and keep their parsed title). It runs at the end of
`importFolders` (so a rescan fixes titles), in the `metadata-refresh` job, and right after a
manual identify of a series. The endpoint shape was written from TheTVDB's v4 docs and unit
tests with a fake client, not yet run against the live API.

`POST /api/library/auto-identify` (`autoIdentifyLibrary` in `packages/library`) sweeps
every root node, picks the right provider for its media kind, and auto-applies the top
search candidate — the "auto" policy built on the same primitives as the manual flow.
`POST /api/library/import` now calls this automatically after scanning, so newly-imported
items get identified without a separate manual call (the sweep already skips anything
already identified, so this is cheap on every import run). `refreshLibraryMetadata`
(same package, shares the root-node/provider-resolution helper with `autoIdentifyLibrary`
via `listIdentifiableRoots`) re-fetches details for already-identified nodes instead of
searching for new matches — this is what the `metadata-refresh` job (see "Jobs" below)
runs on a schedule.
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

**Duplicate-series merging** (`mergeDuplicateSeries`/`confirmSeriesMerge` in
`packages/library`): two root series nodes that end up sharing the same `(provider,
externalId)` — i.e. two source folders turned out to be the same real show — get merged.
The policy, confirmed in a decision: merge automatically only when **unambiguous**,
otherwise ask. "Unambiguous" is re-checked at merge time, not trusted from whenever the
original identify happened: re-derive each node's originally-searched title from its
`sourceKey` and re-run `search()` — exactly one candidate on both sides means merge; more
than one on either side means the original identification was itself a guess among
options, so merging on top of it would compound that guess, and it's reported in
`pending` for `POST /api/library/merge-duplicates/confirm` instead. The merge itself
reparents the duplicate's season nodes onto the primary (earliest-created wins), falling
back to the same per-episode `(season, episode)` identity `importShows` already uses when
both sides happen to have the same season number. `POST /api/library/import` runs this
automatically (series only — merging movie duplicates raises a different, out-of-scope
question: which file should win). Scoped to series because that's the reported case;
movie-duplicate merging would need a file-selection policy this doesn't attempt.

### Acquisition subsystem (not yet built)

Subtitle acquisition (the first acquisition feature, built before video) has its own plan and
status: `docs/SUBTITLE-ACQUISITION.md`. `packages/subtitles` exists (S1: OpenSubtitles, scoring,
sidecar files, a 30-minute sweep job); playback of downloaded subtitles is S2.

One `Indexer` port (`search`, `fetchDownloadPayload`, `capabilities`) and one
`DownloadClient` port (`add`, `getStatus`, `remove`), each implemented by torrent and
Usenet adapters. Torznab and Newznab are the same underlying XML protocol, so both indexer
adapter families share a `newznab-protocol` helper package — the first concrete place the
no-duplication requirement bites. The `acquisition` package's orchestration
(search → decide → grab → monitor → import) is written once, parameterized by `MediaType`
and by which indexer/download-client instances are enabled; it has no protocol- or
media-type-specific branches. M4/M5 in the roadmap below exist specifically to prove this
holds when the second protocol is added.

### Streaming subsystem (built — started by the server, no playback routes yet)

`packages/streaming` deliberately knows nothing about Jellyfin; `jellyfin-compat` translates
`DeviceProfile`/`PlaybackInfoResponse` to and from these shapes at its boundary. Pipeline:

1. `probeMedia(path)` runs ffprobe and maps it to a `MediaProbe` (normalized container,
   per-stream codec/profile/bit depth/HDR flag/absolute stream index, text vs image
   subtitles; embedded cover art is dropped from `videoStreams`).
2. `resolvePlaybackPlan(probe, clientCapabilities, options)` — pure — returns
   `direct-play` (serve the file), `remux` (copy video into HLS, audio copied or
   re-encoded), or `transcode` (re-encode video), plus generic `TranscodeReason`s for why
   direct play wasn't possible. It takes a `MediaProbe` rather than a domain `MediaFile`
   so it stays pure; the caller probes first. It prefers an HLS segment container that can
   carry the source video as-is (HEVC/AV1 copy needs fMP4) before falling back to a
   transcode; bitrate is capped to the client's budget minus audio and never inflated
   above the source's own bitrate.
3. `startTranscodeSession(plan, { accel, directory, startTimeSeconds })` spawns one ffmpeg
   writing `index.m3u8` + segments into `directory`, exposing `-progress`-parsed
   `progress`, `waitForPlaylist()`, `stop()` (SIGTERM → SIGKILL), `dispose()` (stop +
   delete output, killing ffmpeg immediately) and a never-rejecting `done`.
4. `TranscodeManager` owns all sessions: `maxConcurrent` running ffmpegs
   (`TranscodeCapacityError` past that; finished sessions don't count), reaping anything
   not `touch()`ed for `idleTimeoutMs`, and `seek()`, which keeps the session if that
   position is already transcoded and restarts ffmpeg there if not. Its ids stay stable
   across seeks. `start()` clears `session-*` directories orphaned by a crash — only those,
   so a misconfigured `TRANSCODE_DIR` can't get a user's files deleted.

**HDR.** A PQ/HLG source on a client without `supportsHdr` gets `VideoRangeNotSupported`,
and every video transcode of an HDR source is tone-mapped to tagged BT.709 8-bit SDR
(`toneMapFilters`). Always in software — see the implementation note on `tonemap_vaapi`.

**Subtitles** are off unless `subtitleStreamIndex` is passed. Text subtitles become a
`sidecar` action and don't affect delivery (direct play stays direct play); the caller gets
the file from `extractWebVtt`, which reads the whole container (0.3–18s on real files) so
its result should be cached. ASS styling and positioning are lost in that conversion. Image
subtitles (PGS) become `burn-in`, which forces a transcode (`SubtitleBurnInRequired`).

**CPU fallback.** With no usable GPU, `HARDWARE_ACCEL=auto` simply selects software. A GPU
that passed detection but fails on a particular transcode (driver bug, a file it chokes
on) is retried on the CPU by `TranscodeManager` — before the client sees anything — and
that transcode stays on the CPU for its later seeks. Remuxes are never retried: they don't
use the accel, so the CPU would fail identically. Verified with real ffmpeg against a
nonexistent render node: playable on the CPU 0.7s later.

**GPU decode is opt-in.** VAAPI decodes on the CPU and only encodes on the GPU unless
`VAAPI_HARDWARE_DECODE=true`. Found on the owner's server (AMD Polaris): ffmpeg hit corrupt
data mid-file, the UVD decoder ring timed out, the driver's GPU reset failed, and the whole
machine hung — the fallback ladder never got a chance, since nothing in Node was running.
The CPU decoder just reports an error on the same data.

Config: `HARDWARE_ACCEL` (`auto`/`none`/`vaapi`), `VAAPI_DEVICE`, `VAAPI_HARDWARE_DECODE`, `TRANSCODE_DIR`,
`MAX_CONCURRENT_TRANSCODES`.

Hardware accel is a `HardwareAccel` strategy whose only job is producing a `VideoPipeline`
(pre-`-i` args, `-vf` chain, encoder args); stream mapping, keyframe alignment and HLS
muxing live once in `buildTranscodeArgs` and are shared by every strategy.
`selectHardwareAccel(mode)` resolves `auto`/`none`/`vaapi`: `auto` silently falls back to
software, an explicit `vaapi` that doesn't work throws. Adding NVENC/QSV = add to the
`HardwareAccelKind` union, one new strategy class, and a branch in `selectHardwareAccel`
— nothing else changes. `VaapiAccel` falls back per request: hardware decode only when
the GPU supports that codec **and** bit depth, otherwise software decode + `hwupload`;
target codecs the GPU can't encode are delegated wholesale to the software strategy.

`streaming`'s tests include one integration file (`ffmpeg.integration.test.ts`) that runs
real ffmpeg on a lavfi-synthesized 10-bit HEVC + 5.1 AC-3 sample (remux, software
transcode, and VAAPI transcode when a working device is detected) — it skips when ffmpeg
isn't on `PATH`, so run tests inside `nix develop`.

### Playback, UI and watch history (built)

`apps/server` routes (all behind login):
- `GET /api/browse/home` — continue watching, next up, shows, movies; `GET
  /api/browse/title/:id` — a movie or series with seasons, per-episode progress and `next`
  (what "play" means). Artwork is read straight from `metadata_cache`, never a provider.
- `GET /api/playback/:unitId` (duration, audio/subtitle tracks, next episode), `POST
  .../start {capabilities, startSeconds, audioStreamIndex, subtitleStreamIndex}` →
  direct-play URL (`.../file`, Range-capable) or an HLS URL under
  `/api/transcodes/:id/:sessionId/`. The session id is in the path so requests from before
  a seek get 410 instead of the new run's same-named segments. `POST .../seek
  {transcodeId, seconds}` keeps or restarts the transcode. Text subtitles are served as
  WebVTT on the source's timeline; the player moves the browser's parsed cues by the HLS
  start offset instead of re-parsing WebVTT on the server. Files (direct play and HLS
  output) go through **@fastify/send** for Range/ETag/content-type, probe and subtitle
  results through **lru-cache** (`fetch` dedupes concurrent lookups). Request bodies and
  params are zod schemas; `ClientCapabilities`' schema `satisfies` the TS type.
- `POST /api/progress/:unitId {positionSeconds, durationSeconds, ended}` — one
  `watch_progress` row per (user, unit) (migration 0006); ≥90% counts as watched, <30s isn't resumable.
  `continueWatching`/`nextUp`/`pickNextUnit` live in `packages/library`.
- Two separate notions of "watched": `completed` is about the *current* viewing (a rewatch
  clears it; resume, continue watching, next up and autoplay go by it), while `watched_at`
  (migration 0011, backfilled from completed rows) is sticky — the upsert keeps
  `greatest(old, new)`, so no save can clear or rewind it. The UI's watched check mark uses
  `watched` (from `watched_at`), so it survives a rewatch.
- **Watch history is never deleted as a side effect.** Both `watch_progress` foreign keys
  are `ON DELETE RESTRICT` (migration 0010), so Postgres refuses to delete a unit, its
  node or a user that still has history. Code that removes a unit must first move its
  history with `LibraryRepository.moveWatchProgress` (the series merge does this for a
  duplicate episode: the newer position wins, watched if either was). The only deliberate
  changes are the user's own: `POST /api/progress/watched {unitIds, watched}` marks
  episodes, seasons or a movie watched (position set to the end, `watched_at` kept at
  `greatest`) or unwatched (`watched_at` cleared, position kept), and `DELETE
  /api/progress/:unitId/position` forgets a saved position (the × on Continue watching).
  The title page's ⋯ menus call these; `WatchedMenu.svelte` + `lib/watched.ts`.

The UI (`/`, `/title/[id]`, `/watch/[unitId]` — names chosen not to collide with Jellyfin
routes) asks the *browser* what it can decode (`detectCapabilities`: `canPlayType` for
progressive files and `MediaSource.isTypeSupported` for HLS, only counting a codec both
accept) and sends that as `ClientCapabilities`. The player has its own controls because a
transcode's timeline only covers what's been transcoded: its seek bar spans the whole file
and restarts ffmpeg when seeking past the transcoded range. hls.js plays HLS everywhere
except Apple browsers (native HLS, needed for AirPlay/iOS fullscreen) — Chromium ≥ ~150
also claims native HLS, but its demuxer rejects our fMP4 segments. Progress is reported
every 10s, on pause and on unload, but never before the current stream has actually
played — otherwise a failed start reports position 0 and wipes the saved resume point.
At the end of an episode a 10s countdown auto-plays the next one.

**Always a playable stream (fallback ladder).** Capability detection can be wrong (a
browser claims a codec it can't decode, a file has a codec detail no check sees), and
ffmpeg can fail on a damaged file, so instead of failing playback steps down a
`FallbackLevel` (`packages/streaming/src/playback-plan.ts`): **0** the normal plan → **1**
re-encode everything to H.264 8-bit + stereo AAC in MPEG-TS (no direct play, no stream
copy) → **2** also CPU-only, with ffmpeg told to push through corrupt input (`-fflags
+genpts+discardcorrupt -err_detect ignore_err -max_error_rate 1`) → **3** also ≤720p and no
burned-in subtitles, and the GPU gets another try (a 4K HEVC source can't be decoded in
realtime on the CPU: measured 0.28× at level 2 for a 4K HDR remux, vs 0.96× at 720p). The
server steps down by itself when ffmpeg can't produce a first segment (`POST .../start`
takes `fallbackLevel` and answers with the level it reached; 422 only when level 3 fails
too; 503 for capacity is never retried). The player steps down when the browser can't
decode (a media error on direct play / native HLS; an hls.js fatal error after its own
`recoverMediaError` + `swapAudioCodec` tries), when a seek's restart fails (502), when the
position hasn't moved for 20s while it should be playing, or when 4s of playback produced
no picture. Within a player the level only goes up. Verified in Firefox: an AVI wrongly
offered for direct play failed with "Failed to init decoder" and was playing a level-1
transcode 3s after opening.

**Stats for nerds** (admins only: the chart button or `i` in the player): browser-side
numbers (resolution, dropped frames, buffer, hls.js bandwidth and last segment download,
volume and normalization gain, every fallback step) plus `GET
/api/playback/:unitId/stats?transcodeId=` (`requireAdmin`): the file, source streams, the
plan and its reasons, output codecs, ffmpeg state and speed, how far ahead it's transcoded,
and where video is decoded and encoded on what device — the GPU's name comes from libva's
`VAAPI driver:` line at startup (`parseVaapiDriverName`), the CPU's from `os.cpus()`.

**Maximum resolution** (admin Settings page, "Playback"): `ServerSettings.maxStreamHeight`
(2160/1440/1080/720/480 or no limit) caps every stream: `POST .../start` passes it to
`resolvePlaybackPlan` as `maxHeight`, so a taller file is transcoded down instead of played
as-is (reason `VideoResolutionNotSupported`). Settings are key/value rows in
`server_setting` (migration 0012; `GET`/`PATCH /api/settings`, admin-only), validated
when read so a retired or out-of-range value falls back to the default rather than
breaking playback. Read on every start, so a change applies from the next video.

**Autoplay can be refused.** Firefox blocks audible autoplay on a page that hasn't been
clicked yet (a new tab, a reload, the full reload SvelteKit does after a rebuild), and some
Gecko forks require a click per play; `play()` then rejects with `NotAllowedError`. The
player shows a large play button in that case rather than sitting silently paused.

**File health check** (`FileHealthMonitor`, `packages/streaming/src/file-health.ts`): a
background loop decodes every media file end to end on the CPU — `nice -n 19`, one thread,
`-readrate 4` — and records the result in `file_health` (migration 0015). Damage is a
non-zero exit *or any output at `-v error`* (which hides warnings such as odd timestamps):
ffmpeg exits 0 on plenty of real corruption — a HEVC stream with broken references, a
Matroska element overrunning its parent — and only logs it. Found by corrupting a HEVC
file: the exit code alone missed it, though H.264 in MP4 exited 183. Order: never-checked files (newest import first), files whose
size changed, then each file again after 90 days. It waits while any transcode is running,
and skips a file it can't run on (missing, ffmpeg absent) until the next restart. It is a
loop rather than a pg-boss job because one check of a long film outlasts a job's 15-minute
expiry. `POST .../start` begins a damaged file at fallback level 2 (CPU-only, error-tolerant,
so no direct play), and the stats for nerds show the result. Not a guarantee: a file that
decodes cleanly on the CPU can still upset a GPU decoder, which is why GPU decode is opt-in.

It is a server setting, `fileHealthCheck` (admin Settings page → "File health check", on by
default). The monitor reads it before every file and every 15s during one, so turning it off
kills the check in progress at once; results stay stored but stop affecting playback while
it's off, which is the way out of a false positive. The same card shows progress from
`GET /api/file-health` (admin-only; refreshed every 10s while the page is open): files
checked of total, how many are waiting, what's being decoded right now, and the damaged
files with ffmpeg's first error. `waiting` means paused for a running transcode; `idle`,
nothing left to check.

**Full speed** (`fileHealthFullSpeed`, a second toggle on the same card; off by default)
is for catching up on a big library: ffmpeg runs without `-readrate` and without the
one-thread limit, and the monitor stops pausing for transcodes. It stays at `nice -n 19`,
so playback still wins any contention for the CPU. It's read like the on/off setting, and
a change restarts the file in progress so it takes effect immediately (the decode of that
file starts over). It doesn't switch itself off.

**Memory diagnostics** (`apps/server/src/diagnostics.ts`, opt-in via `DIAGNOSTICS_DIR`, how-to
in `docs/DEPLOYMENT.md`): built on Node's own `v8` and `inspector` modules. A timer logs heap
numbers; V8's sampling heap profiler stays on; and the first time the heap passes
`DIAGNOSTICS_CAPTURE_AT_MB` a live-allocation profile and a full heap snapshot are written.
It exists because a leak (~170 MB/min on the owner's server, from ~25 s after startup, no
traffic needed) never reproduced locally or in a synthetic 9,000-episode library scan, so
the evidence has to come out of the leaking process itself.

**Scan query fan-out and unbounded paging** (leak review, 2026-11-11): `listChildren` and
`listUnits` used to run one `external_id` query per row, and the importer lists the library root
once per movie, so a scan queued millions of queries in the pg pool (the scan runs ~25 s after
boot via pg-boss's `missed: "once"`, matching the leak's timing). They now load a whole
listing's external ids in one query (`loadExternalIdsGrouped`). `TvdbClient.getAllPages` also
throws if `links.next` doesn't advance or passes 200 pages, instead of collecting forever.
Neither is confirmed as the leak — only the diagnostics capture will say.

**Volume normalization** (on by default, toggle in the player, remembered per browser):
the `loudness-scan` job (pg-boss, every 15 min, ≤10 min per run so it fits pg-boss's job
expiry) measures each file's default audio stream with ffmpeg's `ebur128` filter (EBU R128 /
ITU-R BS.1770 integrated loudness), newest imports first, at `nice -n 19`, and stores it in
`audio_loudness` (migration 0007; a failure is stored with its error, not retried). The
player levels to **−23 LUFS** (broadcast standard; ±12 dB cap, silence left alone —
`normalizationGainDb`) through the same Web Audio gain node + limiter as the 200% boost, so
direct play, remux and transcode all get it without re-encoding. Measured here: ~5s per TV
episode, ~140s for a lossless DTS-HD film track; one real episode measured −32.6 LUFS
(+9.6 dB). Once the gain node exists it carries volume and mute too, because browsers
disagree on whether the element's own volume applies to a Web Audio source. The graph is
only built after a user interaction (a suspended AudioContext would silence the video) and
never for Safari's native HLS (its media-element source outputs silence), so normalization
is unavailable for HLS on iOS/Safari.

**Library scan** (admin Settings page at `/settings`): library folders live in
`library_folder` (migration 0008), each tagged movies or shows. The `library-scan` job runs
every 15 minutes, and "Scan now" / adding a folder share the same `LibraryScanner`, so scans
never overlap. A scan runs the same `importFolders` pipeline as `POST /api/library/import`
(scan, create, auto-identify, merge duplicate series), then reconciles: every known file
under a reachable folder is checked on disk, and its unit is marked `missing` or `available`
again — nothing is deleted, so watch history survives. A folder that can't be read, **or is
empty**, is skipped for that run (an unmounted drive's mount point is usually empty), never
read as "everything was deleted". One `isPlayable(unit)` rule (has a file and is
`available`) drives the library, next up, continue watching and autoplay; titles with no
playable units drop off the home page (`listRootsWithPlayableUnits`, a recursive CTE).
Two bugs the first real scan exposed, both fixed: (1) a file that was renamed or replaced
(e.g. `Grey's.Anatomy.S01E01…` → `Greys.Anatomy.S01E01…`, `.mp4` → `.mkv`) was skipped as
"already imported" because the episode/movie existed, so the new file was ignored and the
old one marked missing — now `relinkIfReplaced` points the existing unit at the new file
when its old file is gone (same unit, so watch history carries over; if both files exist the
current link wins), and orphaned `media_file` rows are deleted at the end of the scan. On
the real library: 271 relinked, 1,454 of 1,470 files playable (the rest are unparseable
names like `S01X01` webisodes, or duplicate copies). (2) Merging series deleted the
duplicate node, so the next scan of its folder recreated it — the survivor now keeps the
duplicate's folder name in `library_node.source_aliases` (migration 0009), which import
lookups match on. (3) `confirmSeriesMerge` with the same id on both sides matched every
episode against itself and deleted the whole series, cascading its watch history; it now
rejects anything but two different top-level series (400 from the route).

Migrations now run at startup (`runMigrations`), so deploying a new version needs no
manual step; it shares `drizzle-kit migrate`'s bookkeeping table.

### Deployment (Docker)

Full guide, including NixOS `oci-containers` against the host's `services.postgresql`:
`docs/DEPLOYMENT.md`. `docker/Dockerfile` builds one image (server + UI + ffmpeg + Mesa/Intel
VA drivers, Debian 12): the build stage reinstalls production dependencies into fresh
`node_modules` (`pnpm install --prod` over an existing install leaves dev packages in the
virtual store, which roughly doubled the app layer), and the runtime runs as the
unprivileged `node` user under `tini`, with a `/health` `HEALTHCHECK`. Any uid works, which
is what lets NixOS run it as a host user for Postgres peer auth over the mounted
`/run/postgresql` socket (`DATABASE_URL=postgresql://tessatv@%2Frun%2Fpostgresql/tessatv`).
Because it isn't root, VAAPI needs the render node's group **by number** (`group_add`).
`docker/docker-compose.yml` runs the app + its own Postgres (bound to `127.0.0.1`); set
`MEDIA_ROOT` (mounted read-only at the same path, so library paths match). Serves on 8096
(Jellyfin's port). Earlier smoke test on the real machine: VAAPI 4K HDR tone-mapping + PGS
burn-in at ~2× realtime. `loadConfig` treats empty env values as unset: env files pass
`.env.example`'s blank `TMDB_API_KEY=` through as `""`, which used to fail validation and
stop the container at startup.

### Jellyfin compatibility layer (not yet built)

Pure adapter/BFF: owns Jellyfin's routes, JSON shapes, auth header conventions, and
WebSocket session protocol; contains no business logic. Phased: (1) auth + server
discovery + read-only browse, (2) images/artwork, (3) direct play, (4) transcode
negotiation + HLS delivery + progress reporting, (5) deeper coverage (resume/watched state,
collections, playlists, favorites, search). Live TV is out of scope (different acquisition
model entirely) — stub as unsupported.

### Auth (built)

`domain` defines `User`/`AuthSession` and the `UserRepository`/`AuthSessionRepository`
ports; `persistence` implements them (`app_user` — `user` is reserved in Postgres — and
`auth_session`); `packages/auth`'s `AuthService` holds the logic:
- Passwords: Argon2id via `@node-rs/argon2` (library defaults: 19 MiB, t=2, p=1; parameters
  are encoded in each hash so they can be raised later), NFKC-normalized, constant-time
  compare. Hashes from before the switch (`scrypt$...`) still verify and are rehashed on the
  next login; remove that legacy path once no `scrypt$` hashes remain in `app_user`. Unknown usernames are
  verified against a dummy hash so login timing doesn't reveal which accounts exist.
- Sessions: 256-bit random bearer tokens; only their SHA-256 is stored, so a leaked
  session table isn't usable. No expiry — a session lasts until logout (deleting the row).
  `lastSeenAt` is rewritten at most every 5 minutes.
- Usernames are unique case-insensitively (a `lower(username)` unique index); passwords
  need 8+ characters.
- First-run setup (`POST /api/auth/setup`) creates the first account (an admin) and only
  works while there are no users — enforced atomically with a transaction-scoped advisory
  lock, so concurrent setup requests can't both win (covered by a Postgres-backed test).

`apps/server` locks down **every** `/api` route by default with an `onRequest` hook
(deny-by-default, matched case-insensitively since routing is), except `GET
/api/auth/session` (needs-setup + current user, what the UI routes on), `POST
/api/auth/setup`, `/login`, `/logout`. The browser gets the token as an HttpOnly,
SameSite=Lax cookie via `@fastify/cookie` (`Secure` only over HTTPS — the LAN setup is plain HTTP); other
clients send `Authorization: Bearer <token>` (the login/setup responses also return it).
Non-`/api` routes (`/health`, Jellyfin discovery, the UI itself) stay public. The UI's
root layout load sends people to `/setup`, `/login`, or the app based on
`/api/auth/session`. Not yet: roles beyond the single admin flag (every user can do
everything), editing or removing users, login rate limiting.

### Single sign-on (built)

OpenID Connect through `openid-client` (authorization code + PKCE + state + nonce), built
for Authentik but provider-agnostic. Everything is configured on the Settings page and
stored in `server_setting` (key `oidc`, migration 0012; `ServerSettings.oidc`), so no
restart or env var is involved:
- **Accounts come from the provider.** Anyone it lets through gets a TessaTV account on
  their first sign-in, named after `preferred_username` (fallback: `email`, then `sub`),
  linked by the provider's `sub` (`app_user.oidc_subject`, migration 0013, which also
  makes `password_hash` nullable — SSO accounts have no password and `POST
  /api/auth/login` refuses them). An existing account with the same username (the local
  admin) is linked on first SSO login, so Tessa keeps one account either way. Members of
  the configured **admin group** (from the `groups` claim) are admins, re-evaluated on every
  sign-in (an account that also has a password can be promoted this way but never
  demoted, so a provider mistake can't lock the local admin out); an optional **required group** turns everyone else away with a reason on the
  login page. Usernames the provider hands out that already belong to someone else linked
  to a *different* subject fail with `username_taken`.
- **Password login stays** for accounts that have one, folded under the SSO button on the
  login page, so a provider outage can't lock the admin out.
- **Secrets**: the client secret is sealed with `SecretBox` (AES-256-GCM, key derived from
  `APP_SECRET` with HKDF per purpose) before it's stored, and the API never returns it
  (`hasClientSecret` only; saving without a secret keeps the saved one). The sign-in's
  state/nonce/PKCE verifier travel in a sealed, 10-minute `tessatv_oidc` cookie scoped to
  `/api/auth/oidc`, so there's no server-side pending-login table and a callback from
  another browser (or forged) is rejected.
- **Addresses**: the public URL the admin enters is what the callback is rebuilt on, since
  behind a reverse proxy Fastify sees the proxy's address. Saving with SSO enabled runs
  discovery first and refuses an issuer that doesn't answer (422 `issuer_unreachable`);
  the issuer is stored exactly as the provider states it, and a trailing slash typed
  wrong is retried the other way (Authentik's issuers end in one; `OidcClient.check`).
  Plain-HTTP issuers are allowed (LAN/Tailscale homelabs).
- Routes: `GET /api/auth/oidc/login` (redirects to the provider) and
  `GET /api/auth/oidc/callback` (back to `/`, or `/login?error=…`), both public;
  `GET/PATCH /api/settings` and `GET /api/users` are admin-only. `SsoDependencies.
  onAccountCreated` fires once per new account (the hook the Jellyfin history import
  uses). Tests: `apps/server/src/routes/oidc.test.ts` runs full sign-ins against
  `oauth2-mock-server`; `packages/auth/src/oidc.test.ts` covers discovery.

**Authentik setup** (what the Settings card expects):
1. Authentik → *Applications → Providers → Create → OAuth2/OpenID Provider*. Client type
   *Confidential*; redirect URI = the one the Settings card shows
   (`<TessaTV's address>/api/auth/oidc/callback`); signing key: any. Copy the client ID
   and client secret.
2. Create an *Application* bound to that provider (slug e.g. `tessatv`). On the provider's
   overview, copy the *OpenID Configuration Issuer* — it looks like
   `https://auth.example.com/application/o/tessatv/`.
3. Scopes: the provider's default `openid`, `email`, `profile` are enough; the `groups`
   claim comes from Authentik's default *profile* scope mapping. If groups are missing,
   add the built-in `authentik default OAuth Mapping: OpenID 'profile'` scope mapping.
4. In TessaTV's Settings → Single sign-on: TessaTV's address (as users reach it), the
   issuer, client ID + secret, the Authentik group whose members should be admins, and
   optionally a group that's required to sign in at all. Save; the login page now shows
   the button.

### Jellyfin watch-history import (built)

Settings → *Import from Jellyfin* saves a Jellyfin address and API key (`server_setting`
key `jellyfin`; the key is sealed with `SecretBox` like the OIDC secret and never returned;
saving checks it by listing users, 422 `jellyfin_unreachable` otherwise). `POST
/api/jellyfin/import` (admin, one run at a time) runs `packages/jellyfin-import`:
- **Source**: the official `@jellyfin/sdk` behind a small `JellyfinHistorySource`
  interface (tests fake it). Per user, two filtered `/Items` queries (`IsPlayed`,
  `IsResumable`), not the whole library. The SDK's type declarations omit file extensions,
  so this package alone compiles with `moduleResolution: Bundler`; its emitted JS is plain ESM.
- **Matching a Jellyfin item to a unit** (`match.ts`): file path first — exact, else the
  longest shared trailing path if it's unique, so a different mount point (`/media` vs
  `/data/tessatv`) works — then the series' provider id (`tvdb`, `tmdb`, `imdb`) plus
  season and episode numbers, or the movie's own id. Ambiguity means no match; the import
  reports how many items weren't matched. `LibraryRepository.listUnitLocations` supplies
  every unit's path and its own and ancestors' external ids.
- **People**: matched to TessaTV accounts by username (case-insensitive). History for a
  Jellyfin user with no account goes into `held_watch_history` (migration 0014) and is
  moved into their real history by `claimHeldHistory` the first time they sign in through
  SSO (`SsoDependencies.onAccountCreated`).
- **Merge rules** (`importHistory`): an imported row replaces the stored position only if
  its `updatedAt` is newer; `watched_at` only moves forward. Nothing is ever deleted, so
  re-running is safe and never undoes what someone watched here since.

### Jobs (done — metadata refresh; more job types come with acquisition)

`packages/jobs`' `JobScheduler` wraps pg-boss: each registered `JobDefinition` (`name`,
`cron`, `handler`) gets a `singleton` queue (so two server processes never run the same job
at once), a cron schedule, and a worker. Schedules live in pg-boss's own `pgboss` schema and
survive restarts; a run missed while the server was down happens once on the next start
(`missed: "once"`). A handler that throws is recorded and retried by pg-boss without
affecting other jobs. `apps/server` registers one job today, `metadata-refresh` (daily at
04:00 UTC, matching `CachedMetadataProvider`'s TTL), running `refreshLibraryMetadata` from
`packages/library`. Indexer polling and download-status monitoring will register their own
`JobDefinition`s the same way once `acquisition` exists.

## Roadmap

Reordered from the original acquisition-first sequence per an earlier decision to get a
watchable player working sooner, before both acquisition protocols are complete:

- **M1 — Core domain + persistence + manual library + minimal UI.** ✅ Done.
- **M2 — Metadata.** ✅ Done.
- **M3 — Streaming + watchable in Jellyfin Mobile.** `streaming`'s `PlaybackPlan`/
  `TranscodeSession` (including hardware-accel strategy selection), Jellyfin discovery,
  first-run setup + login, and TessaTV's own UI at the root with browse, direct play and HLS
  transcode — using Jellyfin Mobile's native player when running inside it — enough for
  the official Jellyfin iOS app to connect, log in, browse, and play content end-to-end.
  This is the "watchable" milestone. (Jellyfin REST phases moved later — see Decisions.)
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
- **M3** 🔄: `streaming` verified against real ffmpeg/ffprobe and real library files
  (probe sweep over the whole library; remux/software/VAAPI sessions on a representative
  sample). Remaining: connect Jellyfin Mobile on iOS to the running server, complete
  first-run setup, log in, browse the library, and play a file via both direct play and a forced-transcode path (including
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
# server: http://localhost:8080 (also serves the built UI at /)
# web (vite HMR): http://localhost:5173 (proxies /api to the server)

# Build + test everything
pnpm turbo run build test

# Deploy (after creating .env from .env.example; NixOS: see docs/DEPLOYMENT.md)
MEDIA_ROOT=/path/to/media docker compose -f docker/docker-compose.yml up -d --build

# Lint — MUST run from the repo root, not per-package (see note below)
pnpm lint

# Every /api call needs a session. Log in once and reuse the token (first-run setup is the
# UI's /setup page, or POST /api/auth/setup with the same body):
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"<user>","password":"<password>"}' | jq -r .token)
AUTH="Authorization: Bearer $TOKEN"   # pass as -H "$AUTH" on the curls below

# Trigger a manual library import
curl -X POST http://localhost:8080/api/library/import -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"moviesPath":"/path/to/movies","showsPath":"/path/to/shows"}'

# Identify a movie/series against TMDB
curl http://localhost:8080/api/library/<id>/metadata/candidates -H "$AUTH"
curl -X POST http://localhost:8080/api/library/<id>/metadata/identify -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"externalId":"<tmdb id>"}'

# Auto-identify every un-identified item in the library at once
curl -X POST http://localhost:8080/api/library/auto-identify -H "$AUTH"

# Find/merge root series nodes that share an external id (auto-merges unambiguous ones)
curl -X POST http://localhost:8080/api/library/merge-duplicates -H "$AUTH"
curl -X POST http://localhost:8080/api/library/merge-duplicates/confirm -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"primaryNodeId":"<id>","duplicateNodeId":"<id>"}'

# Wipe library data for a clean re-import (dev only — does not touch the pgboss schema)
docker exec docker-postgres-1 psql -U tessatv -d tessatv -c \
  "TRUNCATE TABLE media_file, unit, library_node, external_id, metadata_cache RESTART IDENTITY CASCADE;"

# Run a registered job now instead of waiting for its schedule (from packages/jobs)
node --env-file=../../.env -e "const { PgBoss } = await import('pg-boss'); \
  const b = new PgBoss(process.env.DATABASE_URL); await b.start(); \
  await b.send('metadata-refresh'); await b.stop();" --input-type=module
```

`.env` (git-ignored) needs `DATABASE_URL`, `APP_SECRET` (32+ chars), and optionally
`TMDB_API_KEY` / `TVDB_API_KEY`. The server's `dev` script loads it via Node's native
`--env-file` flag — Turborepo does **not** forward the shell's exported env vars through
its task graph, so relying on `source .env` alone silently breaks under `turbo watch`.

`packages/persistence`'s `library-repository.test.ts` and `user-repository.test.ts` need a
running Postgres (the same
one `db:migrate` targets) — unlike every other test in the repo, which is pure-function
only. Run `docker compose -f docker/docker-compose.yml up -d postgres` first if `pnpm
turbo run test` fails only on those files. (`user-repository.test.ts`'s concurrent
first-user test skips itself when the dev database already has accounts, rather than
deleting them.)

### Non-obvious implementation notes

- The Dockerfile had never built before this (it didn't copy `turbo.json`/
  `tsconfig.base.json`), and without `.dockerignore` it would also have copied host
  `node_modules`, build output and `.env` into the image.
- `nixpkgs#chromium` + `playwright-core` (installed outside the repo) works for UI tests,
  but only with `LD_LIBRARY_PATH` unset — this machine's environment points it at an
  alsa-lib built against a newer glibc.

- `eslint-plugin-boundaries` only works when ESLint runs **once from the repo root**
  (`pnpm lint` → `eslint .`). Running it per-package (`eslint src` inside a package
  directory) silently does nothing — the plugin's path matching breaks under that cwd.
  It also needs `eslint-import-resolver-typescript` (not the plain `node` resolver) to
  correctly follow pnpm's symlinked workspace packages to their real path.
- Movie folder scanning is deliberately non-recursive — see "Library / manual import"
  above. This was a real bug caught during manual testing, not a design guess.
- Episode filename parsing relies on public conventions (via @ctrl/video-filename-parser)
  rather than being iteratively patched to fit one library's files — that distinction was an
  explicit course-correction mid-build. Movie *folder-name* parsing is still ours, because the
  library mangles names like `Example..Show (2012)`.
- `apps/server` serves the UI by importing `@tessatv/web/handler` (SvelteKit adapter-node's
  built handler) as Fastify's not-found handler — so the UI on :8080 shows the last *build*, not the vite dev server.
  adapter-node assumes `https` unless a protocol header says otherwise, which made SSR's
  same-origin `fetch("/api/...")` fail over plain-HTTP LAN; the server now always sets
  `x-tessatv-forwarded-proto` from Fastify's own view of the connection (so clients can't
  spoof it) and points adapter-node's `PROTOCOL_HEADER` at it.
- To test first-run setup end-to-end without consuming the real dev database's one-time
  setup, run a second server against a throwaway database: `CREATE DATABASE tessatv_e2e`,
  `db:migrate` with `DATABASE_URL` pointed at it, `PORT=8081 node apps/server/dist/index.js`,
  then drop it. Headless Chromium works from `nix build nixpkgs#chromium` + `playwright-core`
  — but run it with `env -u LD_LIBRARY_PATH`: the dev shell's library path leaks an older
  glibc and Chromium fails to start otherwise.
- `tsx --watch` runs as a supervisor process that respawns a child worker on file
  changes — `ps aux` shows two node processes for the server (the outer one keeps
  `--watch` in its args, the respawned child doesn't). If something goes wrong and the
  child stops tracking changes, `ps aux | grep node` and killing the whole tree (not just
  one PID) is the reliable fix — this happened once mid-build and silently served stale
  code (no crash, no error) until caught by a live response not matching the latest code.
- Don't trust a running dev server's behavior as proof the latest code is deployed —
  verify the response shape itself changed (e.g. a new field you just added) before
  trusting live-test results, exactly because of the above.
- Any field whose job is "stable identity for matching" (like `LibraryNode.sourceKey`)
  must be verified by writing to it once and then *mutating a different field* (like
  `title`) and re-running the matching logic — a test that only ever creates fresh rows
  can't catch a matching bug that only shows up after something else changes the row.
  The `sourceKey` bug shipped past the original test suite for exactly this reason: every
  existing test created-then-asserted, never created-then-renamed-then-rematched.
- When a migration needs a new `NOT NULL` column and there's no sane default, check
  whether the affected tables can just be emptied first (dev data, nothing externally
  referenced) rather than engineering a backfill — `TRUNCATE ... CASCADE` then migrate is
  simpler and more honest than a default value that's wrong for already-written rows.
- VAAPI capability detection runs tiny real encodes/decodes against the device at startup
  (~0.6s here) instead of trusting `ffmpeg -encoders`/`-hwaccels` (which only list what was
  *compiled in*, not what this GPU/driver can do) or a per-vendor table. On this AMD iGPU:
  encode H.264/HEVC/AV1; decode H.264 8-bit, HEVC 8/10, AV1 8/10, VP9 8/10 — **not**
  10-bit H.264 (Hi10P anime) or MPEG-2/MPEG-4 (XviD), which correctly get software decode +
  hardware encode. Decode support must be matched on codec *and* bit depth together.
- `tonemap_vaapi` fails on this AMD iGPU ("VAAPI driver doesn't support HDR"), so
  tone-mapping always runs in software, and `VaapiAccel` goes hardware decode + scale →
  `hwdownload` → software tone-map → `hwupload` → hardware encode. Scaling *before* the
  float-point tone-map is what makes this viable: 4K HDR → 1080p measured 0.5× realtime
  scaling after, ~1.2–1.7× with this order. Verified visually on a real 4K PQ file.
- Burn-in overlays after tone-mapping and scales the subtitle track to the target size
  first (0.32× → 0.65–0.88× on 4K HDR). That's still below realtime with a transcoded
  DTS track on this machine, so 4K HDR + PGS may buffer; 480p SDR + PGS runs at ~60×.
- ffmpeg can take 12–40s+ to exit on SIGTERM with burn-in while its filter graph drains.
  `stop()` escalates to SIGKILL after 5s, which leaves no `#EXT-X-ENDLIST`, and anything
  reading that playlist as VOD waits forever. `dispose()` skips straight to SIGKILL because
  the output is being deleted anyway — otherwise every seek would stall for 5s.
- Most Matroska files don't report per-stream bitrates (998 of 1,470 in the real library),
  so `audio.bitRate` being null is the normal case, not an edge case.
- `DrizzleLibraryRepository.updateNode`'s SQL `SET` clause only listed the fields that had
  ever needed updating *so far* (title, sortTitle, monitored, qualityProfileId) — it
  silently dropped `parentId`, because no feature before series-merging ever needed to
  reparent a node. The series-merge tests all passed because the in-memory test fakes do
  `this.nodes.set(node.id, node)`, persisting every field by construction — a fake that
  complete can never catch a real repository silently dropping one. Only showed up live,
  against the real Postgres, as a season quietly staying attached to a node that had just
  been deleted. Fixed by adding `parentId` to the `SET` clause and adding a real
  Postgres-backed test (`library-repository.test.ts`) specifically for `updateNode`
  persisting every mutable field — the first persistence test in the repo that isn't a
  pure-function mapper test, deliberately, because this class of bug needs one.
