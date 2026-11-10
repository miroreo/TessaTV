# TessaTV — notes for Claude sessions

Start with `docs/ARCHITECTURE.md`: it holds the locked decisions, current status, package
boundaries, and "Non-obvious implementation notes" (real bugs already found — read them
before touching related code). This file only holds the working rules.

## Library-first (decided 2026-11-09)

The owner's standing rule: **prefer an existing open source library over hand-rolled code,
repeat code only when strictly necessary, and build UI from open source components.**
Make no assumptions: when a choice is unclear, ask. The detailed rules, the libraries
already chosen, and the deliberate exceptions are in `docs/ARCHITECTURE.md` under
"Library-first". Before writing a parser, client, validator, or helper by hand, check
whether a maintained library covers it.

## Working rules

- Use `nix develop -c pnpm ...` for every command. Run `pnpm lint` from the repo root only
  (per-package runs silently check nothing).
- Never commit `.env` or API keys (`TMDB_API_KEY`, `TVDB_API_KEY`, `APP_SECRET`).
- `tsx --watch` can go stale: kill the whole watch tree before trusting a live result.
- Live verification (real media in `/data/tessatv`, ffmpeg + VAAPI, Postgres in docker, the
  Jellyfin Mobile app) only works on the owner's machine, not in a cloud container.
- Every `/api` route is login-gated by default (see "Auth" in the architecture doc).
- UI page paths must never reuse Jellyfin route names (`/Items`, `/Users`, `/System`, …):
  routing is case-insensitive for Jellyfin clients.
