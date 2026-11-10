import { basename, dirname } from "node:path";
import send from "@fastify/send";
import {
  isCompletedPosition,
  type LibraryRepository,
  type LoudnessRepository,
  normalizationGainDb,
  type MediaFile,
  type PlaybackInfoResponse,
  type PlaybackSessionResponse,
  type Unit,
  type WatchProgressRepository,
} from "@tessatv/domain";
import { findRoot, listUnitsUnder } from "@tessatv/library";
import {
  type ClientCapabilities,
  extractWebVtt,
  type ManagedTranscode,
  type MediaProbe,
  type PlaybackPlan,
  probeMedia,
  resolvePlaybackPlan,
  TranscodeCapacityError,
  type TranscodeManager,
} from "@tessatv/streaming";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { type Catalog, unitSummary } from "./catalog.js";

export interface PlaybackDependencies {
  readonly libraryRepository: LibraryRepository;
  readonly progressRepository: WatchProgressRepository;
  readonly catalog: Catalog;
  readonly transcodes: TranscodeManager;
  /** Optional so a deployment without the scan job simply plays unlevelled audio. */
  readonly loudnessRepository?: LoudnessRepository;
  /** Test seams. */
  readonly probe?: (path: string) => Promise<MediaProbe>;
  readonly extractSubtitles?: (path: string, streamIndex: number) => Promise<string>;
}

const videoCodecSupport = z.object({
  codec: z.string(),
  maxWidth: z.number().optional(),
  maxHeight: z.number().optional(),
  maxBitDepth: z.number().optional(),
  profiles: z.array(z.string()).optional(),
});

/** Mirrors `ClientCapabilities`; `satisfies` keeps the two from drifting apart. */
const capabilitiesSchema = z.object({
  directPlayContainers: z.array(z.string()),
  videoCodecs: z.array(videoCodecSupport),
  audioCodecs: z.array(z.object({ codec: z.string(), maxChannels: z.number().optional() })),
  maxBitrate: z.number().positive().optional(),
  supportsHdr: z.boolean().optional(),
  hls: z.object({
    segmentContainers: z.array(z.enum(["mpegts", "fmp4"])),
    videoCodecs: z.array(z.enum(["h264", "hevc", "av1"])),
    audioCodecs: z.array(z.enum(["aac", "mp3", "ac3", "eac3", "opus", "flac"])),
    maxAudioChannels: z.number().int().positive().optional(),
  }),
}) satisfies z.ZodType<ClientCapabilities>;

const unitParams = z.object({ unitId: z.string() });
const streamIndex = z.number().int().nonnegative().optional();
const seconds = z.number().nonnegative();

/** Only what ffmpeg's HLS muxer writes — never a path. */
const HLS_FILE = /^[\w-]+\.(m3u8|m4s|ts|mp4)$/;

export function registerPlaybackRoutes(server: FastifyInstance, deps: PlaybackDependencies): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const { libraryRepository, progressRepository, catalog, transcodes } = deps;
  // `fetch` shares one in-flight lookup between concurrent requests for the same key.
  const probes = new LRUCache<string, MediaProbe>({
    max: 500,
    fetchMethod: (path) => (deps.probe ?? probeMedia)(path),
  });
  const subtitles = new LRUCache<string, string, { path: string; index: number }>({
    max: 20,
    fetchMethod: (_key, _stale, { context }) => (deps.extractSubtitles ?? extractWebVtt)(context.path, context.index),
  });

  async function loadPlayable(unitId: string): Promise<{ unit: Unit; file: MediaFile } | null> {
    const unit = await libraryRepository.getUnit(unitId);
    const file = unit?.mediaFileId ? await libraryRepository.getMediaFile(unit.mediaFileId) : null;
    return unit && file ? { unit, file } : null;
  }

  /** Probes, translating a file that's gone from disk into a 404 rather than a 500. */
  async function probeOr404(file: MediaFile, reply: FastifyReply): Promise<MediaProbe | null> {
    try {
      return (await probes.fetch(file.path)) ?? null;
    } catch (error) {
      app.log.warn({ path: file.path, error }, "probe failed");
      await reply.code(404).send({ error: "file_unavailable", message: `Can't read ${file.path}` });
      return null;
    }
  }

  /** Serves one file from disk with Range, ETag and content-type handled by @fastify/send. */
  async function sendFile(request: FastifyRequest, reply: FastifyReply, path: string, cacheControl: string) {
    const result = await send(request.raw, `/${encodeURIComponent(basename(path))}`, {
      root: dirname(path),
      cacheControl: false,
    });
    if (result.type === "error") return reply.code(result.statusCode).send({ error: "not_found" });
    return reply.code(result.statusCode).headers({ ...result.headers, "cache-control": cacheControl }).send(result.stream);
  }

  function subtitleUrl(unitId: string, plan: PlaybackPlan): string | null {
    return plan.subtitle?.kind === "sidecar" ? `/api/playback/${unitId}/subtitles/${plan.subtitle.streamIndex}.vtt` : null;
  }

  function hlsResponse(unitId: string, transcode: ManagedTranscode): PlaybackSessionResponse {
    return {
      mode: transcode.plan.mode,
      url: `/api/transcodes/${transcode.id}/${transcode.session.id}/index.m3u8`,
      transcodeId: transcode.id,
      startTimeSeconds: transcode.startTimeSeconds,
      subtitleUrl: subtitleUrl(unitId, transcode.plan),
      reasons: transcode.plan.reasons,
    };
  }

  function streamLabel(stream: { index: number; language: string | null; title: string | null; codec: string }) {
    return [stream.title ?? stream.language?.toUpperCase() ?? `Track ${stream.index}`, stream.codec.toUpperCase()].join(" · ");
  }

  app.get("/api/playback/:unitId", { schema: { params: unitParams } }, async (request, reply) => {
    const playable = await loadPlayable(request.params.unitId);
    if (!playable) return reply.code(404).send({ error: "not_found" });
    const media = await probeOr404(playable.file, reply);
    if (!media) return reply;

    const root = await findRoot(libraryRepository, playable.unit.libraryNodeId);
    const siblings = root ? await listUnitsUnder(libraryRepository, root.id) : [];
    const position = siblings.findIndex((unit) => unit.id === playable.unit.id);
    const next = siblings.slice(position + 1).find((unit) => unit.mediaFileId !== null) ?? null;
    const progress = await progressRepository.get(request.user!.id, playable.unit.id);
    const loudness = await deps.loudnessRepository?.get(playable.file.id);

    const response: PlaybackInfoResponse = {
      unit: unitSummary(playable.unit, progress),
      title: root ? await catalog.title(root) : null,
      durationSeconds: media.durationSeconds,
      audioStreams: media.audioStreams.map((stream) => ({
        index: stream.index,
        label: `${streamLabel(stream)} · ${stream.channels}ch`,
        language: stream.language,
        isDefault: stream.isDefault,
      })),
      subtitleStreams: media.subtitleStreams.map((stream) => ({
        index: stream.index,
        label: `${streamLabel(stream)}${stream.isForced ? " · forced" : ""}${stream.isTextBased ? "" : " · burned in"}`,
        language: stream.language,
        isDefault: stream.isDefault,
        isForced: stream.isForced,
        isTextBased: stream.isTextBased,
      })),
      next: next ? unitSummary(next, null) : null,
      normalization:
        loudness?.integratedLufs != null
          ? { audioStreamIndex: loudness.streamIndex, gainDb: normalizationGainDb(loudness.integratedLufs) }
          : null,
    };
    return response;
  });

  app.post(
    "/api/playback/:unitId/start",
    {
      schema: {
        params: unitParams,
        body: z.object({
          capabilities: capabilitiesSchema,
          startSeconds: seconds.optional(),
          audioStreamIndex: streamIndex,
          subtitleStreamIndex: streamIndex,
        }),
      },
    },
    async (request, reply) => {
      const { capabilities, startSeconds, audioStreamIndex, subtitleStreamIndex } = request.body;
      const playable = await loadPlayable(request.params.unitId);
      if (!playable) return reply.code(404).send({ error: "not_found" });
      const media = await probeOr404(playable.file, reply);
      if (!media) return reply;

      let plan: PlaybackPlan;
      try {
        plan = resolvePlaybackPlan(media, capabilities, {
          ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
          ...(subtitleStreamIndex !== undefined ? { subtitleStreamIndex } : {}),
        });
      } catch (error) {
        return reply.code(400).send({ error: "unplayable", message: (error as Error).message });
      }

      if (plan.mode === "direct-play") {
        const response: PlaybackSessionResponse = {
          mode: plan.mode,
          url: `/api/playback/${playable.unit.id}/file`,
          transcodeId: null,
          startTimeSeconds: 0,
          subtitleUrl: subtitleUrl(playable.unit.id, plan),
          reasons: plan.reasons,
        };
        return response;
      }
      try {
        return hlsResponse(playable.unit.id, await transcodes.begin(plan, startSeconds ?? 0));
      } catch (error) {
        if (error instanceof TranscodeCapacityError) return reply.code(503).send({ error: "busy", message: error.message });
        throw error;
      }
    },
  );

  /** Restarts the transcode at `seconds` unless that point is already transcoded. */
  app.post(
    "/api/playback/:unitId/seek",
    { schema: { params: unitParams, body: z.object({ transcodeId: z.string(), seconds }) } },
    async (request, reply) => {
      const transcode = await transcodes.seek(request.body.transcodeId, request.body.seconds);
      if (!transcode) return reply.code(404).send({ error: "not_found" });
      return hlsResponse(request.params.unitId, transcode);
    },
  );

  // Direct play: the file itself; @fastify/send handles Range so the player can seek.
  app.get("/api/playback/:unitId/file", { schema: { params: unitParams } }, async (request, reply) => {
    const playable = await loadPlayable(request.params.unitId);
    if (!playable) return reply.code(404).send({ error: "not_found" });
    return sendFile(request, reply, playable.file.path, "private, no-cache");
  });

  app.get(
    "/api/playback/:unitId/subtitles/:file",
    { schema: { params: z.object({ unitId: z.string(), file: z.string().regex(/^\d+\.vtt$/) }) } },
    async (request, reply) => {
      const playable = await loadPlayable(request.params.unitId);
      if (!playable) return reply.code(404).send({ error: "not_found" });
      const index = Number.parseInt(request.params.file, 10);
      const media = await probeOr404(playable.file, reply);
      if (!media) return reply;
      if (!media.subtitleStreams.some((stream) => stream.index === index && stream.isTextBased)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const vtt = await subtitles.fetch(`${index}:${playable.file.path}`, { context: { path: playable.file.path, index } });
      return reply.header("content-type", "text/vtt; charset=utf-8").send(vtt);
    },
  );

  app.get(
    "/api/transcodes/:id/:sessionId/:file",
    { schema: { params: z.object({ id: z.string(), sessionId: z.string(), file: z.string() }) } },
    async (request, reply) => {
      const transcode = transcodes.touch(request.params.id);
      if (!transcode) return reply.code(404).send({ error: "not_found" });
      // A request for an older ffmpeg run (from before a seek) must not get the new run's
      // identically-named segments.
      if (transcode.session.id !== request.params.sessionId) return reply.code(410).send({ error: "gone" });
      if (!HLS_FILE.test(request.params.file)) return reply.code(404).send({ error: "not_found" });
      // The playlist grows as ffmpeg works; segments never change once listed.
      const cacheControl = request.params.file.endsWith(".m3u8") ? "no-cache" : "private, max-age=3600";
      return sendFile(request, reply, `${transcode.session.outputDirectory}/${request.params.file}`, cacheControl);
    },
  );

  app.delete("/api/transcodes/:id", { schema: { params: z.object({ id: z.string() }) } }, async (request, reply) => {
    await transcodes.end(request.params.id);
    return reply.code(204).send();
  });

  app.post(
    "/api/progress/:unitId",
    {
      schema: {
        params: unitParams,
        body: z.object({ positionSeconds: seconds, durationSeconds: z.number().positive().optional(), ended: z.boolean().optional() }),
      },
    },
    async (request, reply) => {
      if (!(await libraryRepository.getUnit(request.params.unitId))) return reply.code(404).send({ error: "not_found" });
      const { positionSeconds, ended } = request.body;
      const durationSeconds = request.body.durationSeconds ?? null;
      await progressRepository.save({
        userId: request.user!.id,
        unitId: request.params.unitId,
        positionSeconds,
        durationSeconds,
        completed: ended === true || isCompletedPosition(positionSeconds, durationSeconds),
        updatedAt: new Date(),
      });
      return reply.code(204).send();
    },
  );
}
