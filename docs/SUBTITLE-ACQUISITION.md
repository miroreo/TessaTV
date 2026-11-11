# Subtitle acquisition — plan

Status (2026-11-11): **S1 and S2 built, not yet live-tested.** The owner said to start building, so
the "build it in" answer to Q1 is taken. What exists: `packages/subtitles` (provider port,
OpenSubtitles adapter, scorer, language normalization, charset/zip handling, file hash, sidecar
naming, `SubtitleService` with throttling and pause-on-quota, `SubtitleAcquirer`, sweep, sidecar
discovery), migration 0016 and `DrizzleSubtitleRepository` (tested on a real Postgres), and in
`apps/server` a `subtitle-sweep` job (every 30 minutes, needs OpenSubtitles credentials) and a
`subtitle-discovery` job (every 15 minutes, always on). Configuration is env vars
(`OPENSUBTITLES_*`, `SUBTITLE_LANGUAGES`, `SUBTITLE_HEARING_IMPAIRED`), not a settings page yet.

Playback (S2): subtitle files beside the video are listed after the embedded tracks in
`GET /api/playback/:unitId`, with indexes from `EXTERNAL_SUBTITLE_INDEX_BASE` (10000) up, so the
existing player picks them like any track and the UI needed no change. Picking one doesn't touch
how the video is delivered; its VTT comes from `/api/playback/:unitId/subtitles/external/:id.vtt`
(ffmpeg, with `-sub_charenc` when the file isn't UTF-8, checked against real ffmpeg). Discovery
records files found beside videos as `sidecar-found`, and drops records whose file is gone: a
deleted *downloaded* subtitle is blacklisted so it isn't fetched again, and a directory that can't
be read (an offline share) is skipped rather than wiping its records. Language codes on external
tracks are three-letter (`eng`) to match embedded tags; a few languages have two codes (`fra`
vs `fre`), so a remembered choice may not carry across those.

Not built: Subdl, settings/UI, a "search now"/blacklist button, per-unit queued jobs. Deviations
from this plan: no `packages/jobs` payload extension yet (the sweep, newest first within a time
budget, covers new imports; Q11 stays open for the later per-unit "search now").

> **Verification caveat.** This was written from the repo plus prior knowledge of the provider
> APIs. The cloud container could not reach the providers' documentation pages (outbound proxy
> returned 403) and web search only returned titles. Every provider fact below (quotas, auth,
> endpoints, library maintenance status) is marked **[verify]** and must be re-checked against
> the live docs before any code is written. Treat the numbers as orders of magnitude.

## 1. Goal and scope

Automatically find, download, store and serve subtitles ("captions") for every playable `Unit`
in the library, in the languages and flavors the owner prefers, from public subtitle providers.
Subtitles are the first *acquisition* feature because they are small, synchronous and
low-risk, and they force the shared parts of acquisition (wanted list, search, rank, attempt
ledger, retry, jobs) to exist before the heavy parts (indexers, download clients) do.

Out of scope for v1: generating subtitles (Whisper), re-syncing timing (alass/ffsubsync),
translating, OCR of PGS/VobSub, per-user language preferences (see Q6).

## 2. What exists today (verified in the repo)

- `packages/streaming`: `probeMedia` reports embedded `subtitleStreams` (language, forced,
  default, `isTextBased`); `extractWebVtt(path, streamIndex)` runs ffmpeg to produce WebVTT on
  the source timeline. The playback routes cache it in an `lru-cache` and serve it at
  `/api/playback/:unitId/subtitles/:index.vtt`. The player shifts parsed cues by the HLS start
  offset, so the server never re-times VTT. PGS/image subtitles are burn-in only.
- Playback only knows subtitles as **embedded stream indexes**. External files are invisible to
  it. Serving downloaded subtitles needs a second kind of "subtitle option" (see §9).
- `packages/jobs`: `JobScheduler` over pg-boss, but `JobDefinition` is **cron-only**
  (`name`, `cron`, `handler()` with no payload). Per-unit, event-driven work needs an extension.
- `packages/library`: scan/import, `@ctrl/video-filename-parser` for filenames, `sourceKey`
  matching, `syncEpisodeTitles`. Import is where "new file → wanted subtitles" must hook in.
- `packages/domain`: `Unit` (`sequence`, `externalIds`), `MediaFile` (`path`, `checksum`),
  `ExternalId` (`provider`, `providerId` for TMDB/TVDB/IMDB), `Release`, `ReleaseParser`.
- `packages/auth/secret-box.ts`: app-level encryption already exists, planned for exactly this
  ("indexer credentials encrypted at rest") — reuse it for provider credentials.
- Nothing subtitle-related is stored in Postgres yet.

## 3. Library-first evaluation

The repo rule is: check for a maintained library before writing anything by hand.

| Need | Candidate | Verdict |
|---|---|---|
| Whole feature, zero code | **Bazarr** (Python service; subtitle manager for Sonarr/Radarr, ~20 providers, scoring, language profiles). Writes sidecar files next to media. | Real option — see Q1. Needs Sonarr/Radarr or a path mapping; GPL; separate container; no TessaTV integration beyond picking up the files it writes. [verify current status] |
| Provider logic | **subliminal** (Python lib, many providers, scoring) | Python; we'd have to shell out or run a service. Not a fit for a Node process. |
| OpenSubtitles client | `opensubtitles.com` npm wrapper (and older `opensubtitles-api`, which targets the deprecated v1 XML-RPC API) | The REST API is ~3 endpoints (`/login`, `/subtitles`, `/download`). With **ky** already in the repo (used for TMDB/TVDB) a thin client is smaller than a dependency we'd have to audit. Checked on npm 2026-11-11: `opensubtitles.com` is 9 KB, plain JS, last published Feb 2024; `opensubtitles-api` targets the old API and was last published 2022. **Decided: ky.** |
| Subdl, SubSource, Jimaku clients | none worth using | Thin **ky** clients behind our own `SubtitleProvider` port, same pattern as `TmdbClient`. |
| Format conversion SRT/ASS → WebVTT | **ffmpeg** (already a hard dependency; `extractWebVtt` already does it) | Reuse. ffmpeg takes a subtitle *file* as `-i` just as well as a stream in a container. No new dependency. |
| Parsing/cleaning cues (strip ads, "watermark" lines, SDH tags) | `subtitle` (npm, SRT/WebVTT parse/stringify) [verify maintenance]; `subsrt-ts` | Only if we decide to post-process. Not needed for v1. |
| Charset detection (many SRTs are cp1252, cp1250, GBK…) | **chardet** / `jschardet` + **iconv-lite** | Needed: ffmpeg assumes UTF-8 and mangles others. Use libs, don't hand-roll. |
| Archive extraction (Subdl, Podnapisi deliver ZIPs) | **fflate** or **yauzl** | Use a lib. |
| OpenSubtitles file hash (64-bit sum of size + first/last 64 KiB) | tiny npm packages exist | ~20 lines; Checked 2026-11-11: no maintained npm package (`moviehash`, `opensubtitles-hash` don't exist). Hand-rolled in `movie-hash.ts`, tested against a synthetic file. |
| Language codes (ISO 639-1/2/3, BCP 47) | `iso-639-3`, `bcp-47` | Use a lib; providers disagree (`en`, `eng`, `pt-BR`, `zh-TW`). |
| Rate limiting / quota | **bottleneck** or `p-throttle` | Use a lib, one limiter per provider. |
| Scoring | none (subliminal/Bazarr's are Python) | Hand-written pure function; ~60 lines + table. It encodes our policy. Reuse `@ctrl/video-filename-parser` to parse the subtitle's release string and the video's name. |
| Retry/backoff, scheduling | **pg-boss** (already in) | Use per-job retry options; don't write a retry loop. |
| Auto-sync timing | alass (Rust), ffsubsync (Python) | Later, optional, external binary. |

## 4. Providers

Candidates, ordered by recommendation. Everything under "terms" is **[verify]**.

| Provider | Access | Auth | Matching keys | Limits / terms (from memory) | Recommendation |
|---|---|---|---|---|---|
| **OpenSubtitles.com** | Official REST API v1 | App **API key** per consumer + user login (JWT) for downloads; `User-Agent` must identify the app | `moviehash`, `imdb_id`, `tmdb_id`, `parent_tmdb_id`/`parent_imdb_id` + `season_number` + `episode_number`, `query`, `languages`, `hearing_impaired`, `foreign_parts_only`, `ai_translated`, `machine_translated` | Download quota per account per day (single digits to tens for free, ~1000 for VIP), plus per-second request limit; 429 on both. The quota is the binding constraint for a bulk library backfill. | **v1.** Largest catalog, official API, hash matching, TMDB ids (we already store them). |
| **Subdl** | Free JSON API | API key | `tmdb_id`, `imdb_id`, `film_name`, `season_number`, `episode_number`, `languages`, `subs_per_page`; results carry a ZIP link | Free key, limits unclear. No hash search. | **v1.** Cheap second source; avoids the OpenSubtitles quota. |
| **SubSource** | JSON API (successor to Subscene's community after it shut down in 2024) | API key [verify it exists/is stable] | title/imdb/season | unknown | **v2 candidate**, check first. |
| **Jimaku** | JSON API, anime only | API key | AniList/TMDB ids | unknown | **v2, only if the library has anime** (it has absolute-numbered anime per the architecture doc). |
| **Podnapisi** | No official API; Bazarr/subliminal scrape it | none | title, season/episode, language | Scraping: fragile, ToS grey area | **Later, opt-in** if at all. |
| **Addic7ed** | No API; scraping (a third-party "Gestdown" proxy exists) | Login/cookies | TV only, show+season+episode+release group | Aggressive anti-bot; fragile | **Later, opt-in**, TV only. |
| **Subscene** | Shut down in 2024 | — | — | — | Drop. The coordinator's "Subscene alternatives" = SubSource/Subdl. |
| Assrt, Legendas.tv, Zimuku, Titulky … | scraping, regional | various | — | — | Out of scope; add only on request, per-language. |

Policy: v1 ships only providers with an **official, keyed API** (OpenSubtitles.com, Subdl).
Scraping providers are separate adapters behind the same port, off by default, because they
break without notice and may violate terms. Each provider's key/credential is entered in
Settings (admin) and stored through `secret-box`; the server never calls a provider without one.

Privacy: requests to providers carry only a generic `User-Agent` (`TessaTV/<version>`), the
file hash, external ids, language and season/episode. Never file paths, library names, or
usernames.

## 5. Provider abstraction

Same shape as `MetadataProvider`: a narrow port in the new package, one adapter per provider,
a thin client per provider using ky, a fake in tests. Nothing outside the adapter knows a
provider's wire format.

```ts
// packages/subtitles/src/subtitle-provider.ts  (proposed)
interface SubtitleQuery {
  kind: "movie" | "episode";
  languages: readonly Language[];            // BCP 47, ordered by preference
  externalIds: { tmdb?: string; imdb?: string; tvdb?: string };   // series ids for episodes
  title: string; year: number | null;
  season?: number; episode?: number;
  movieHash?: string;                         // OpenSubtitles 64-bit hash
  fileName: string;                           // basename only, parsed for release group/source
  durationSeconds?: number; fps?: number;
}
interface SubtitleCandidate {
  provider: string; providerId: string;
  language: Language; format: "srt" | "ass" | "vtt" | "sub" | "zip";
  flags: { forced: boolean; hearingImpaired: boolean; aiTranslated: boolean; machineTranslated: boolean };
  releaseName: string | null;                 // what the uploader says it syncs to
  matchedBy: ("hash" | "imdb" | "tmdb" | "tvdb" | "title")[];
  downloadCount: number | null; rating: number | null; uploadedAt: Date | null;
}
interface SubtitleProvider {
  readonly id: string;
  readonly capabilities: { hashSearch: boolean; languages: "any" | readonly string[]; media: readonly ("movie"|"episode")[] };
  search(query: SubtitleQuery): Promise<SubtitleCandidate[]>;
  download(candidate: SubtitleCandidate): Promise<{ bytes: Uint8Array; fileName: string }>;  // unzips, never decodes charset
}
```

Cross-cutting behavior lives **once**, in a `SubtitleService`, not in adapters: per-provider
throttle and daily-quota accounting, error classification (`RateLimited`, `QuotaExhausted`,
`AuthFailed`, `Transient`), provider health/circuit-breaker (skip a provider for N minutes
after repeated failures), charset normalization, and archive handling. Adapters throw typed
errors; they do not retry.

## 6. Matching and scoring

Search all enabled providers in parallel for the wanted languages, merge, score, pick the best
above a minimum.

Search keys, in order of trust: **file hash** (exact release sync; OpenSubtitles only) →
**TMDB/IMDB id** (+ season/episode; we already have `ExternalId`s from M2, TheTVDB for series
means we need the TVDB→IMDB/TMDB mapping the metadata layer may or may not expose — check) →
**title + year**. Title-only searches are fuzzy and need a minimum-score floor.

Score (adapted from the Bazarr/subliminal idea; weights are a starting table to tune, not
measurements):

| Signal | Points |
|---|---|
| matched by file hash | +100 (and short-circuits: take it) |
| id match (tmdb/imdb) with correct season+episode | +50 |
| release group equals ours | +15 |
| source (WEB-DL / BluRay / …) equals | +10 |
| resolution / video codec equals | +5 each |
| language is exactly the wanted one vs. a regional variant | +10 / +5 |
| hearing-impaired flag equals the preference | +10; wrong flag −10 |
| forced flag equals the request; wrong flag **−100** (a forced track is not a full track) | |
| `machine_translated` / `ai_translated` | −30 unless the owner opted in |
| download count / rating | up to +10 (tie-break only) |
| runtime within tolerance of our duration (when the provider reports it) | +5; wildly off −50 |

A file-hash hit is accepted without release-name agreement; everything else must reach a
minimum (implemented as an absolute 60 points, `MIN_ACCEPTED_SCORE`). Below it: record "no
acceptable match", don't download. The scorer is a pure function with a table-driven test.
We parse both release strings with `@ctrl/video-filename-parser`, the lib already in use.

Embedded subtitles count: if the probe already shows a text track in the wanted language with
the wanted flags, the unit is **satisfied** and nothing is searched (configurable, Q5).

## 7. Languages, forced, SDH

Server-wide **subtitle profile** (zod-validated, in `ServerSettings`):

```
languages: [{ code: "en", forced: "also" | "only" | "never", hearingImpaired: "prefer" | "avoid" | "only" | "any" }, …]
upgradeUntilScore: number   // keep looking for better ones until a candidate scores >= this
useEmbedded: boolean        // embedded text track satisfies the language
allowMachineTranslated: boolean
```

Order is priority; each entry is a separate "slot" the unit needs filled (e.g. `en` full +
`en` forced for foreign-dialogue-only parts). Per-library-folder or per-series overrides come
later (a profile id on the node) — don't build it now, but keep the slot model so it fits.
Per-user preference affects only *which track the player selects*, not what is downloaded
(Q6).

## 8. Storage

Recommendation: **sidecar file is the source of truth for playback; Postgres is the ledger.**

- **File**: next to the video, in the Jellyfin/Plex-compatible convention
  `Name (2020).en.srt`, `Name (2020).en.forced.srt`, `Name (2020).en.sdh.srt` [verify exact
  suffixes Jellyfin accepts for the SDH flag]. Reasons: the library is the user's; other
  tools (Jellyfin, Plex, Infuse, VLC, Bazarr) read these with no integration; survives a DB
  loss; rename/move of the video keeps working if the library renamer moves sidecars with the
  video (the importer must learn that). Store the provider's original text re-encoded as
  **UTF-8**, original format (SRT/ASS kept as-is — ASS styling is only lost at serve-time
  conversion).
- **DB**: new `subtitle_file` (id, `media_file_id`, `unit_id`, language, forced, hearing_impaired,
  `source`: `downloaded` | `sidecar-found`, provider, provider_id, score, path, sha256,
  format, created_at) and `subtitle_attempt` (unit/slot, provider, outcome, retry-after,
  candidate ids rejected). `subtitle_file` rows let the UI list/delete/replace and let scoring
  know what we already have; **blacklist** rows stop a rejected candidate (user marked bad)
  from returning. The library scan also *discovers* sidecars the user placed by hand and
  records them as `sidecar-found` so they count as satisfying a slot.
- Rejected alternative: store subtitle text in Postgres/blobs. Gains nothing for playback,
  breaks "files are the truth", bloats backups.
- Alternative worth a decision only if the media folders are read-only (Q4): a `SUBTITLES_DIR`
  mirror tree. Costs: other apps don't see them.

## 9. Serving and WebVTT for HLS

Browsers and the Jellyfin Mobile web view want WebVTT; we keep the original on disk and convert
on demand, exactly as embedded tracks already work:

1. Playback info (`GET /api/playback/:unitId`) merges two lists into one `subtitleStreams`
   option set: embedded tracks (`kind: "embedded", index`) and external (`kind: "external",
   subtitleFileId`). `StreamOption` in `packages/domain/src/api.ts` gets a discriminator;
   `subtitleStreamIndex` in the start request becomes a tagged choice.
2. The VTT route gets a sibling: `/api/playback/:unitId/subtitles/external/:fileId.vtt`,
   served via the same `lru-cache` + `extractWebVtt`, generalized to take a file path (ffmpeg
   `-i file.srt -f webvtt`). Because it's on the source timeline, the player's existing cue
   shifting by the HLS start offset applies unchanged. **No HLS subtitle playlists are
   needed**: the sidecar-VTT approach already works for direct play, remux and transcode, so
   the "no subtitles in HLS" gap in the status notes is closed by this, not by muxing.
3. Image subtitles (PGS) are untouched: still burn-in only. Downloaded subtitles are always
   text.
4. Edge cases to test: UTF-8 BOM, non-UTF-8 input (charset detection happens at *download*,
   file is stored as UTF-8), SRT with overlapping cues, ASS with embedded newlines,
   zero-length files, subtitles whose timing is for a different cut (§6 runtime check;
   sync correction is out of scope).

## 10. Job integration

pg-boss is already the scheduler. Needs one extension in `packages/jobs`: today a
`JobDefinition` is cron + no payload, which is right for sweeps but not for "fetch subtitles
for unit X". Proposal (keeps the wrapper narrow):

- `JobDefinition` gains an optional `queue` handler form: `handler(payload)`, plus
  `JobScheduler.enqueue(name, payload, { singletonKey, startAfter })`. pg-boss already
  supports payloads, `singletonKey` (dedupe a unit's pending job), retries with exponential
  backoff, and rate-limited concurrency (`localConcurrency`/batch), so no new infrastructure.
- Jobs:
  - `subtitles-sweep` (cron, daily): find units with an **unfilled slot** whose
    `retry-after` has passed; enqueue `subtitles-fetch` per unit. This also backfills an
    existing library, at a pace the provider quotas allow.
  - `subtitles-fetch` (queued, per unit): build query → search providers → score → download
    best → write sidecar → record `subtitle_file`/`subtitle_attempt`. Concurrency 1–2.
  - Triggered on import: `importFolders` enqueues `subtitles-fetch` for new units (after
    probe, so embedded tracks are known). Also a manual "search now" in the UI (admin),
    and a "replace" for a bad subtitle that blacklists the old candidate.
- **Backoff for "not found yet"**: new releases often have no subtitle for days. Retry after
  1 d, 3 d, 7 d, then every 30 d for N months; stop after that until a manual search.
  Quota exhausted → `startAfter` the provider's reset, don't burn retries.
- **Upgrade pass**: while a slot's best score < `upgradeUntilScore` and the file is younger
  than ~2 weeks, re-search weekly.
- Provider fairness: one bottleneck limiter per provider shared by all workers, so a library
  backfill can't trip a rate limit and get the key banned.

## 11. Proposed package layout and the shared acquisition shape

Subtitles, video releases and metadata assets all follow the same loop:
**wanted → search → rank → acquire → place → record → retry later**. The differences are real:
a subtitle `acquire` is a synchronous HTTP download; a video `acquire` is an asynchronous grab
via a download client that must be monitored, then imported. A shared abstraction has to
express "acquire returns either an artifact or a pending handle" or it will be wrong for one
of them. Since `acquisition` (M4) is unbuilt, the rule of three says don't design the
generic engine from one example.

Recommendation: build the **vocabulary** generic now, the **engine** later.

- `packages/domain` (pure): `AcquisitionKind = "video" | "subtitle" | "metadata-asset"`;
  `WantedSlot` (unit id, kind, slot key such as `en/forced`, state, `retryAfter`);
  `AcquisitionAttempt` (slot, provider, outcome, reason, at); `CandidateScore` (total +
  per-signal breakdown, for UI "why this one"). Subtitle-specific types stay in `subtitles`.
- `packages/subtitles` (new): `SubtitleProvider` port, adapters + clients, scorer, charset/
  archive normalization, sidecar naming/writing, `SubtitleService`. Depends inward on `domain`
  only; `persistence` supplies `SubtitleRepository` (port in `domain/ports`) — same boundary
  rule as metadata. Probably `library` calls it on import, `apps/server` registers the jobs
  and routes (`/api/subtitles/...`, admin-only for settings/search-now).
- When M4 arrives: extract what is **proven shared** (slot/attempt ledger, backoff policy,
  per-provider throttle + health) into `packages/acquisition`, and make `Indexer`/
  `DownloadClient` the second user of it. If extraction needs more than moving code, the
  vocabulary was wrong and we fix it then, with two real examples. This mirrors the M5 "no
  changes to acquisition" proof point already in the roadmap.
- Metadata assets (artwork, trailers) can reuse the same ledger; they are the third example
  that would confirm the shape.

## 12. Settings and UI (sketch)

- Settings → Subtitles (admin): providers (enable, key/login, test button showing remaining
  quota), language profile (§7), min score, embedded handling, upgrade window.
- Title/episode page: a subtitles panel listing embedded + external tracks, "Search" (shows
  ranked candidates with score breakdown, manual pick), "Delete", "Blacklist & replace".
- Library page: count of units missing a wanted language, with a "backfill" button.
- UI built on daisyUI per the library-first rule; shared response types in `domain/api.ts`.

## 13. Phasing

1. **S1 — Core + one provider.** domain types, migration, `packages/subtitles` (port, scorer,
   charset, writer, OpenSubtitles adapter), `jobs` payload extension, `subtitles-fetch`
   triggered on import and a manual endpoint. Verify against a real library (needs the
   owner's machine/key).
2. **S2 — Playback.** external subtitle options in playback info, VTT route, UI track picker,
   sidecar discovery in the scan.
3. **S3 — Second provider + backfill sweep + settings/UI.** Subdl, quota accounting,
   upgrade pass, blacklist.
4. **S4 — Optional:** SubSource/Jimaku, scraping providers (opt-in), sync correction, forced
   detection heuristics. Extract `packages/acquisition` as M4 begins.

## 14. Risks

- **Quota.** OpenSubtitles' daily download cap makes a 2,000-file library a multi-week
  backfill on a free account. Mitigate: Subdl second, hash match first (fewer wasted
  downloads), dedupe by `singletonKey`, don't re-download a candidate already tried.
- **Wrong-cut subtitles.** Even a good score can drift out of sync. Mitigate: runtime check,
  easy replace/blacklist; auto-sync is S4.
- **Provider churn** (Subscene closing is the example). Port isolation + per-provider health +
  scraping providers opt-in.
- **Write access to media folders.** The container may mount media read-only (Q4).
- **Anime numbering.** Absolute-numbered shows are mapped to season 1; subtitle sources number
  differently. Expect poor matches until the metadata layer exposes proper mappings.
- **Not live-verifiable here.** Provider calls need the owner's keys and machine, same as the
  streaming work.

## 15. Open questions

Defaults in bold are the recommendation if the owner has no preference.

1. **Build vs integrate.** Build the provider layer in TessaTV, or tell users to run **Bazarr**
   beside it and have TessaTV only discover the sidecars it writes (S2 only)? Bazarr is
   mature but Python, GPL, wants Sonarr/Radarr, and the user has just rejected duplicated
   moving parts in the library-first refactor *and* wants acquisition built in. **Build.**
2. **v1 providers.** **OpenSubtitles.com + Subdl**; are scraping providers (Podnapisi,
   Addic7ed) acceptable at all, even opt-in?
3. **OpenSubtitles account.** Does the owner have (or want) a VIP account/API key? It decides
   how fast a backfill can run. Whose API consumer key does the app use: one shipped with the
   app (their terms may not allow sharing a key across installs [verify]) or each owner's
   own? **Each owner's own.**
4. **Media folders writable?** **Sidecar next to the video** vs a separate `SUBTITLES_DIR`.
5. **Embedded tracks** satisfy a language, so don't download? **Yes** (toggle).
6. **Language preferences**: server-wide profile only (**yes for v1**) or per-user from the
   start (playback track auto-select is per user either way)?
7. **Languages** the owner actually wants, and whether forced and SDH tracks matter to them.
8. **Machine/AI-translated** subtitles allowed? **No.**
9. **Auto-sync** (alass/ffsubsync) wanted eventually, and is installing another binary in the
   Docker image/Nix flake acceptable?
10. **Existing library backfill** automatically on enabling, or only on demand?
11. **Job payloads in `packages/jobs`.** OK to extend `JobDefinition`/`JobScheduler` with
    queued, payload-carrying jobs (needed for per-unit work)?
12. **Series ids.** Episodes are identified via TheTVDB; providers key on IMDB/TMDB. Does
    `MetadataProvider` expose cross-ids, or do we add that to `fetchDetails`?
