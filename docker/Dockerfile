# syntax=docker/dockerfile:1
#
# TessaTV server + web UI in one image. Build from the repo root:
#   docker build -f docker/Dockerfile -t tessatv .
# See docs/DEPLOYMENT.md for running it (docker compose, or NixOS oci-containers).

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# Installs the pnpm version pinned by package.json's `packageManager`.
RUN corepack enable
WORKDIR /repo

FROM base AS build
# `pnpm fetch` needs only the lockfile, so the download layer stays cached across
# source-only changes; the install after it then runs offline.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
RUN pnpm turbo run build
# Reinstall production dependencies only, into fresh node_modules (`--prod` over an existing
# install leaves the dev packages in the virtual store), and drop build caches.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
      .turbo apps/*/.turbo packages/*/.turbo apps/web/.svelte-kit \
  && pnpm install --frozen-lockfile --offline --prod

FROM ${NODE_IMAGE} AS runtime
# ffmpeg/ffprobe for probing and transcoding. VAAPI drivers: Mesa covers AMD (and older
# Intel), intel-media-va-driver covers Intel Gen8+. Harmless without a GPU: HARDWARE_ACCEL=auto
# falls back to software. tini reaps ffmpeg children and forwards signals to node.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg mesa-va-drivers intel-media-va-driver tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /repo ./
# Transcode scratch space; mount a volume or tmpfs here.
RUN install -d -o node -g node /transcodes
ENV NODE_ENV=production \
    PORT=8096 \
    TRANSCODE_DIR=/transcodes
# Runs as the image's unprivileged `node` user (uid 1000) by default; override with
# `--user` to match a host account (see docs/DEPLOYMENT.md for peer auth over a socket).
USER node
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
