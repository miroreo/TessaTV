# TessaTV
## Reference Materials
When you need project-specific context, consult these files:
- **Architecture**: docs/ARCHITECTURE.md
Read only what the current task requires.

## Library-first (decided 2026-11-09)
- Prefer existing open source libraries over hand-rolled code.
- Build UI from open source components.
- Repeat code only when strictly necessary
- Make no assumtions: when a choice is unclear, ask
- Prefer code modifications to rewrites
- Before writing a parser, client, validator, or helper by hand, check
whether a maintained library covers it.

## Allowed operations
- File read: always OK
- git commit: OK (no direct push to main)
- File delete: only files you created
- Everything else: ask first
- Remote file read: ask first (ssh)

## Working rules

- Use `nix develop -c pnpm ...` for every command. Run `pnpm lint` from the repo root only
  (per-package runs silently check nothing).
- Commits may be unsigned: the owner set this as a standing project rule (2026-11-10), so
  `--no-gpg-sign` needs no further permission on this project.
- Commit messages include "why":
  - Good: fix: prevent duplicate API calls on rapid button clicks
  - Bad: fix bug
- Never commit `.env` or API keys (`TMDB_API_KEY`, `TVDB_API_KEY`, `APP_SECRET`).
- `tsx --watch` can go stale: kill the whole watch tree before trusting a live result.
- Live verification (real media in `/data/tessatv`, ffmpeg + VAAPI, Postgres in docker, the
  Jellyfin Mobile app) only works on the owner's machine, not in a cloud container.
- Every `/api` route is login-gated by default (see "Auth" in the architecture doc).
- UI page paths must never reuse Jellyfin route names (`/Items`, `/Users`, `/System`, …):
  routing is case-insensitive for Jellyfin clients.
