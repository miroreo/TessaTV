import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import send from "@fastify/send";
import {
  EXTERNAL_SUBTITLE_INDEX_BASE,
  isCompletedPosition,
  isPlayable,
  type FileHealthRepository,
  type LibraryRepository,
  type LoudnessRepository,
  normalizationGainDb,
  type MediaFile,
  type PlaybackInfoResponse,
  type PlaybackSessionResponse,
  type PlaybackStatsResponse,
  type ServerSettingsRepository,
  type StreamOption,
  type SubtitleFile,
  type SubtitleRepository,
  type Unit,
  type WatchProgressRepository,
} from "@tessatv/domain";
import { findRoot, listUnitsUnder } from "@tessatv/library";
import {
  type ClientCapabilities,
  extractWebVtt,
  type FallbackLevel,
  type ManagedTranscode,
  MAX_FALLBACK_LEVEL,
  type MediaProbe,
  type PlaybackPlan,
  probeMedia,
  resolvePlaybackPlan,
  TranscodeCapacityError,
  type TranscodeManager,
} from "@tessatv/streaming";
import { detectEncoding, toThreeLetterLanguage } from "@tessatv/subtitles";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { requireAdmin } from "../require-admin.js";
import { type Catalog, unitSummary } from "./catalog.js";

export interface PlaybackDependencies {
  readonly libraryRepository: LibraryRepository;
  readonly progressRepository: WatchProgressRepository;
  readonly catalog: Catalog;
  readonly transcodes: TranscodeManager;
  /** The admin's stream resolution cap; without it, streams are uncapped. */
  readonly settings?: ServerSettingsRepository;
  /** Optional so a deployment without the scan job simply plays unlevelled audio. */
  readonly loudnessRepository?: LoudnessRepository;
  /** Optional: without it every file is trusted, as before the decode check existed. */
  readonly fileHealthRepository?: FileHealthRepository;
  /** Optional: without it only subtitle tracks inside the file are offered. */
  readonly subtitleRepository?: SubtitleRepository;
  /** Test seams. */
  readonly probe?: (path: string) => Promise<MediaProbe>;
  readonly extractSubtitles?: (path: string, streamIndex: number, inputCharset?: string) => Promise<string>;
  /** Test seam: reads a subtitle file's bytes to tell its encoding. */
  readonly readSubtitleFile?: (path: string) => Promise<Uint8Array>;
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

/** Every fallback level failed, so there's nothing left to try. */
class UnplayableError extends Error {}

const where = (side: "hardware" | "software") => (side === "hardware" ? "gpu" : "cpu");

function transcodeStats(transcode: ManagedTranscode): NonNullable<PlaybackStatsResponse["transcode"]> {
  const { plan, session, videoPipeline } = transcode;
  const result = session.result;
  return {
    mode: plan.mode,
    fallbackLevel: plan.fallbackLevel,
    reasons: plan.reasons,
    segmentContainer: plan.segmentContainer,
    video: !plan.video
      ? null
      : plan.video.kind === "copy"
        ? { action: "copy", codec: plan.video.codec, width: null, height: null, bitrate: null }
        : {
            action: "transcode",
            codec: plan.video.codec,
            width: plan.video.width,
            height: plan.video.height,
            bitrate: plan.video.bitrate,
          },
    audio: !plan.audio
      ? null
      : plan.audio.kind === "copy"
        ? { action: "copy", codec: plan.audio.codec, channels: null, bitrate: null }
        : { action: "transcode", codec: plan.audio.codec, channels: plan.audio.channels, bitrate: plan.audio.bitrate },
    subtitle: plan.subtitle?.kind ?? null,
    encoder: videoPipeline
      ? {
          decode: where(videoPipeline.decode),
          decodeDevice: videoPipeline.decodeDevice,
          encode: where(videoPipeline.encode),
          encodeDevice: videoPipeline.encodeDevice,
          accel: transcode.accelKind,
        }
      : null,
    hardwareError: transcode.hardwareError,
    state: session.state,
    error: result?.error ?? null,
    speed: session.progress.speed,
    transcodedUntilSeconds: transcode.startTimeSeconds + session.progress.outTimeSeconds,
    startTimeSeconds: transcode.startTimeSeconds,
  };
}
const streamIndex = z.number().int().nonnegative().optional();
const seconds = z.number().nonnegative();
const fallbackLevel = z
  .number()
  .int()
  .min(0)
  .max(MAX_FALLBACK_LEVEL)
  .transform((level) => level as FallbackLevel);

/** CPU-only and told to push through corrupt input: see `FallbackLevel`. */
const DAMAGED_FILE_FALLBACK_LEVEL = 2;

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
  const subtitles = new LRUCache<string, string, { path: string; index: number; inputCharset?: string }>({
    max: 20,
    fetchMethod: (_key, _stale, { context }) =>
      (deps.extractSubtitles ?? ((path, index, inputCharset) => extractWebVtt(path, index, inputCharset ? { inputCharset } : {})))(
        context.path,
        context.index,
        context.inputCharset,
      ),
  });
  // Which subtitle file a transcode was started with, so a seek (which only restarts ffmpeg) can
  // hand the same one back. Bounded: transcodes come and go without telling this.
  const externalChoices = new LRUCache<string, string>({ max: 200 });

  /** Subtitle files beside the video, in a stable order, so their position in it is their index. */
  async function externalSubtitles(unitId: string): Promise<SubtitleFile[]> {
    const files = (await deps.subtitleRepository?.listForUnit(unitId)) ?? [];
    return files.filter((file) => ["srt", "ass", "ssa", "vtt"].includes(file.format)).sort((a, b) => a.path.localeCompare(b.path));
  }

  function externalSubtitleUrl(unitId: string, file: SubtitleFile): string {
    return `/api/playback/${unitId}/subtitles/external/${file.id}.vtt`;
  }

  /** Splits a chosen subtitle index into an embedded track for the plan, or a file served separately. */
  async function resolveSubtitleChoice(unitId: string, index: number | undefined): Promise<{ embedded?: number; externalUrl?: string }> {
    if (index === undefined) return {};
    if (index < EXTERNAL_SUBTITLE_INDEX_BASE) return { embedded: index };
    const file = (await externalSubtitles(unitId))[index - EXTERNAL_SUBTITLE_INDEX_BASE];
    return file ? { externalUrl: externalSubtitleUrl(unitId, file) } : {};
  }

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
      subtitleUrl: subtitleUrl(unitId, transcode.plan) ?? externalChoices.get(transcode.id) ?? null,
      reasons: transcode.plan.reasons,
      fallbackLevel: transcode.plan.fallbackLevel,
      hasVideo: transcode.plan.video !== null,
    };
  }

  /**
   * Starts the stream at `level`, stepping down a level each time a plan can't be made or
   * ffmpeg fails to produce a first segment, so a start only fails when even the most
   * compatible stream does. Being at capacity isn't the stream's fault, so that's not retried.
   */
  async function startStream(
    unitId: string,
    media: MediaProbe,
    capabilities: ClientCapabilities,
    options: { startSeconds: number; audioStreamIndex?: number; subtitleStreamIndex?: number; maxHeight?: number },
    level: FallbackLevel,
  ): Promise<PlaybackSessionResponse> {
    let lastError: Error | null = null;
    for (let current = level; current <= MAX_FALLBACK_LEVEL; current = (current + 1) as FallbackLevel) {
      let plan: PlaybackPlan;
      try {
        plan = resolvePlaybackPlan(media, capabilities, {
          ...(options.audioStreamIndex !== undefined ? { audioStreamIndex: options.audioStreamIndex } : {}),
          ...(options.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: options.subtitleStreamIndex } : {}),
          ...(options.maxHeight !== undefined ? { maxHeight: options.maxHeight } : {}),
          fallbackLevel: current,
        });
      } catch (error) {
        lastError = error as Error;
        continue;
      }
      if (plan.mode === "direct-play") {
        return {
          mode: plan.mode,
          url: `/api/playback/${unitId}/file`,
          transcodeId: null,
          startTimeSeconds: 0,
          subtitleUrl: subtitleUrl(unitId, plan),
          reasons: plan.reasons,
          fallbackLevel: plan.fallbackLevel,
          hasVideo: media.videoStreams.length > 0,
        };
      }
      try {
        return hlsResponse(unitId, await transcodes.begin(plan, options.startSeconds));
      } catch (error) {
        if (error instanceof TranscodeCapacityError) throw error;
        lastError = error as Error;
        app.log.warn({ path: media.path, fallbackLevel: current, error: lastError.message }, "stream failed to start; stepping down");
      }
    }
    throw new UnplayableError(lastError?.message ?? "No playable stream");
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
    const next = siblings.slice(position + 1).find(isPlayable) ?? null;
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
      subtitleStreams: [
        ...media.subtitleStreams.map((stream) => ({
          index: stream.index,
          label: `${streamLabel(stream)}${stream.isForced ? " · forced" : ""}${stream.isTextBased ? "" : " · burned in"}`,
          language: stream.language,
          isDefault: stream.isDefault,
          isForced: stream.isForced,
          isTextBased: stream.isTextBased,
        })),
        ...(await externalSubtitles(playable.unit.id)).map(
          (file, position): StreamOption => ({
            index: EXTERNAL_SUBTITLE_INDEX_BASE + position,
            label: `${file.language.toUpperCase()}${file.forced ? " · forced" : ""}${file.hearingImpaired ? " · SDH" : ""} · ${file.format.toUpperCase()} file`,
            language: toThreeLetterLanguage(file.language) ?? file.language,
            isDefault: false,
            isForced: file.forced,
            isTextBased: true,
            isExternal: true,
          }),
        ),
      ],
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
          fallbackLevel: fallbackLevel.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { capabilities, startSeconds, audioStreamIndex, subtitleStreamIndex } = request.body;
      const playable = await loadPlayable(request.params.unitId);
      if (!playable) return reply.code(404).send({ error: "not_found" });
      const media = await probeOr404(playable.file, reply);
      if (!media) return reply;
      const settings = await deps.settings?.get();
      const maxHeight = settings?.maxStreamHeight ?? undefined;
      // A file the background check found badly damaged starts on the CPU-only, error-tolerant level —
      // unless an admin turned the check off, which also sets its findings aside. Minor findings
      // (a few concealed errors, or audio-only ones) don't change how the file plays.
      const damaged = settings?.fileHealthCheck !== false && (await deps.fileHealthRepository?.get(playable.file.id))?.severity === "major";
      const startLevel = Math.max(request.body.fallbackLevel ?? 0, damaged ? DAMAGED_FILE_FALLBACK_LEVEL : 0) as FallbackLevel;
      const subtitle = await resolveSubtitleChoice(playable.unit.id, subtitleStreamIndex);
      try {
        const response = await startStream(
          playable.unit.id,
          media,
          capabilities,
          {
            startSeconds: startSeconds ?? 0,
            ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
            ...(subtitle.embedded !== undefined ? { subtitleStreamIndex: subtitle.embedded } : {}),
            ...(maxHeight !== undefined ? { maxHeight } : {}),
          },
          startLevel,
        );
        if (!subtitle.externalUrl) return response;
        // A subtitle file never changes how the video is delivered; it just rides along.
        if (response.transcodeId) externalChoices.set(response.transcodeId, subtitle.externalUrl);
        return { ...response, subtitleUrl: subtitle.externalUrl };
      } catch (error) {
        if (error instanceof TranscodeCapacityError) return reply.code(503).send({ error: "busy", message: error.message });
        if (error instanceof UnplayableError) return reply.code(422).send({ error: "unplayable", message: error.message });
        throw error;
      }
    },
  );

  /** Restarts the transcode at `seconds` unless that point is already transcoded. */
  app.post(
    "/api/playback/:unitId/seek",
    { schema: { params: unitParams, body: z.object({ transcodeId: z.string(), seconds }) } },
    async (request, reply) => {
      let transcode: ManagedTranscode | null;
      try {
        transcode = await transcodes.seek(request.body.transcodeId, request.body.seconds);
      } catch (error) {
        // The client answers this by starting over a fallback level down.
        app.log.warn({ error: (error as Error).message }, "transcode failed to restart after a seek");
        return reply.code(502).send({ error: "transcode_failed", message: (error as Error).message });
      }
      if (!transcode) return reply.code(404).send({ error: "not_found" });
      return hlsResponse(request.params.unitId, transcode);
    },
  );

  app.get(
    "/api/playback/:unitId/stats",
    {
      preHandler: requireAdmin,
      schema: { params: unitParams, querystring: z.object({ transcodeId: z.string().optional() }) },
    },
    async (request, reply) => {
      const playable = await loadPlayable(request.params.unitId);
      if (!playable) return reply.code(404).send({ error: "not_found" });
      const media = await probeOr404(playable.file, reply);
      if (!media) return reply;
      const health = await deps.fileHealthRepository?.get(playable.file.id);
      const transcode = request.query.transcodeId ? transcodes.inspect(request.query.transcodeId) : null;
      const sourceVideo = transcode?.plan.video?.kind === "transcode" ? transcode.plan.video.source : media.videoStreams[0];
      const audioIndex = transcode?.plan.audio?.streamIndex;
      const sourceAudio = media.audioStreams.find((stream) => stream.index === audioIndex) ?? media.audioStreams[0];
      const response: PlaybackStatsResponse = {
        file: {
          path: media.path,
          container: media.container,
          sizeBytes: media.sizeBytes,
          bitRate: media.bitRate,
          health: health
            ? {
                checkedAt: health.checkedAt.toISOString(),
                error: health.error,
                severity: health.severity,
                videoErrors: health.videoErrors,
                audioErrors: health.audioErrors,
              }
            : null,
        },
        sourceVideo: sourceVideo
          ? {
              codec: sourceVideo.codec,
              profile: sourceVideo.profile,
              width: sourceVideo.width,
              height: sourceVideo.height,
              bitDepth: sourceVideo.bitDepth,
              frameRate: sourceVideo.frameRate,
              isHdr: sourceVideo.isHdr,
            }
          : null,
        sourceAudio: sourceAudio
          ? {
              codec: sourceAudio.codec,
              channels: sourceAudio.channels,
              sampleRate: sourceAudio.sampleRate,
              language: sourceAudio.language,
            }
          : null,
        transcode: transcode ? transcodeStats(transcode) : null,
      };
      return response;
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
    "/api/playback/:unitId/subtitles/external/:file",
    { schema: { params: z.object({ unitId: z.string(), file: z.string().regex(/^[\w-]+\.vtt$/) }) } },
    async (request, reply) => {
      const record = await deps.subtitleRepository?.get(request.params.file.replace(/\.vtt$/, ""));
      if (!record || record.unitId !== request.params.unitId) return reply.code(404).send({ error: "not_found" });
      let bytes: Uint8Array;
      try {
        bytes = await (deps.readSubtitleFile ?? readFile)(record.path);
      } catch {
        return reply.code(404).send({ error: "file_unavailable", message: "The subtitle file is gone" });
      }
      // Downloaded files are UTF-8 already; ones put there by hand may not be, and ffmpeg must be told.
      const encoding = detectEncoding(bytes);
      const vtt = await subtitles.fetch(`ext:${record.id}:${record.createdAt.getTime()}:${record.path}`, {
        context: { path: record.path, index: 0, ...(encoding === "utf-8" ? {} : { inputCharset: encoding }) },
      });
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

  /** Marks episodes or movies watched or unwatched by hand, e.g. a whole season at once, in viewing order. */
  app.post(
    "/api/progress/watched",
    { schema: { body: z.object({ unitIds: z.array(z.string()).min(1).max(1000), watched: z.boolean() }) } },
    async (request, reply) => {
      const { unitIds, watched } = request.body;
      const units = await Promise.all(unitIds.map((id) => libraryRepository.getUnit(id)));
      if (units.some((entry) => entry === null)) return reply.code(404).send({ error: "not_found" });
      if (watched) await progressRepository.markWatched(request.user!.id, unitIds, new Date());
      else await progressRepository.markUnwatched(request.user!.id, unitIds);
      return reply.code(204).send();
    },
  );

  /** Discards a saved position: the next play starts from the beginning. */
  app.delete("/api/progress/:unitId/position", { schema: { params: unitParams } }, async (request, reply) => {
    if (!(await libraryRepository.getUnit(request.params.unitId))) return reply.code(404).send({ error: "not_found" });
    await progressRepository.forgetPosition(request.user!.id, request.params.unitId);
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
      const completed = ended === true || isCompletedPosition(positionSeconds, durationSeconds);
      const now = new Date();
      await progressRepository.save({
        userId: request.user!.id,
        unitId: request.params.unitId,
        positionSeconds,
        durationSeconds,
        completed,
        watchedAt: completed ? now : null,
        updatedAt: now,
      });
      return reply.code(204).send();
    },
  );
}
