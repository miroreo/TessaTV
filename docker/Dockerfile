FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm turbo run build

FROM node:22-slim AS runtime
# VAAPI drivers: Mesa covers AMD (and older Intel), intel-media-va-driver covers Intel Gen8+.
# Harmless without a GPU — HARDWARE_ACCEL=auto falls back to software.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg mesa-va-drivers intel-media-va-driver \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo ./
ENV NODE_ENV=production
EXPOSE 8096
CMD ["node", "apps/server/dist/index.js"]
