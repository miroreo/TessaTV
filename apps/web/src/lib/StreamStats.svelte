<script lang="ts" module>
  /** One step down the fallback ladder, as the player saw it. */
  export interface FallbackEvent {
    readonly level: number;
    readonly reason: string;
    readonly atSeconds: number;
  }
</script>

<script lang="ts">
  import type { PlaybackSessionResponse, PlaybackStatsResponse } from "@tessatv/domain";
  import { api, formatTime } from "$lib/api.js";
  import Icon from "$lib/Icon.svelte";
  import type Hls from "hls.js";
  import { onDestroy } from "svelte";

  /**
   * Admin-only "stats for nerds": the browser's side (decode, buffer, network) read live from
   * the video element and hls.js, the server's side (source, plan, encoder, ffmpeg speed)
   * polled from `/api/playback/:unitId/stats`.
   */
  let {
    unitId,
    video,
    hls,
    engine,
    session,
    position,
    volume,
    muted,
    normalizationDb,
    fallbacks,
    lastFragment,
    onclose,
  }: {
    unitId: string;
    video: HTMLVideoElement;
    hls: Hls | null;
    engine: string;
    session: PlaybackSessionResponse | null;
    /** Source position, in seconds. */
    position: number;
    volume: number;
    muted: boolean;
    /** Gain normalization is applying, or null when it isn't. */
    normalizationDb: number | null;
    fallbacks: readonly FallbackEvent[];
    /** The most recent HLS segment download, tracked by the player since the stream started. */
    lastFragment: { bytes: number; ms: number } | null;
    onclose: () => void;
  } = $props();

  const SERVER_POLL_MS = 2000;
  const CLIENT_POLL_MS = 500;

  let server = $state<PlaybackStatsResponse | null>(null);
  let serverError = $state<string | null>(null);
  let client = $state({ width: 0, height: 0, dropped: 0, total: 0, buffer: 0, viewport: "" });
  let bandwidth = $state<number | null>(null);

  async function pollServer() {
    try {
      const query = session?.transcodeId ? `?transcodeId=${session.transcodeId}` : "";
      server = await api<PlaybackStatsResponse>(fetch, `/api/playback/${unitId}/stats${query}`);
      serverError = null;
    } catch (cause) {
      serverError = (cause as Error).message;
    }
  }

  function pollClient() {
    const quality = video.getVideoPlaybackQuality?.();
    let buffer = 0;
    for (let range = 0; range < video.buffered.length; range++) {
      if (video.buffered.start(range) <= video.currentTime + 0.5 && video.buffered.end(range) >= video.currentTime) {
        buffer = video.buffered.end(range) - video.currentTime;
      }
    }
    client = {
      width: video.videoWidth,
      height: video.videoHeight,
      dropped: quality?.droppedVideoFrames ?? 0,
      total: quality?.totalVideoFrames ?? 0,
      buffer,
      viewport: `${video.clientWidth}×${video.clientHeight}×${window.devicePixelRatio}`,
    };
    bandwidth = hls && Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null;
  }

  $effect(() => {
    void session?.transcodeId;
    void pollServer();
    const timer = setInterval(() => void pollServer(), SERVER_POLL_MS);
    return () => clearInterval(timer);
  });

  const clientTimer = setInterval(pollClient, CLIENT_POLL_MS);
  onDestroy(() => clearInterval(clientTimer));

  const megabits = (bits: number | null | undefined) => (bits ? `${(bits / 1_000_000).toFixed(1)} Mbps` : "—");
  const bytes = (count: number | null | undefined) =>
    !count ? "—" : count > 1e9 ? `${(count / 1e9).toFixed(2)} GB` : `${(count / 1e6).toFixed(1)} MB`;
  const device = (side: "gpu" | "cpu", name: string | null) => `${side.toUpperCase()}${name ? ` · ${name}` : ""}`;

  const rows = $derived.by(() => {
    const transcode = server?.transcode ?? null;
    const source = server?.sourceVideo;
    const audio = server?.sourceAudio;
    // Only shown when the playlist declares codecs; ffmpeg's don't, and the output rows cover it.
    const level = hls?.levels[hls.currentLevel];
    const streamCodecs = level?.videoCodec || level?.audioCodec ? `${level.videoCodec ?? "—"} / ${level.audioCodec ?? "—"}` : null;
    const out: [string, string][] = [
      ["Unit", unitId],
      ["Mode", session ? `${session.mode}${session.reasons.length ? ` (${session.reasons.join(", ")})` : ""}` : "—"],
      ["Fallback level", `${session?.fallbackLevel ?? 0} / 3`],
      ["Player", engine],
      ["Viewport / Frames", `${client.viewport} / ${client.dropped} dropped of ${client.total}`],
      ["Current res", client.width ? `${client.width}×${client.height}` : "no picture"],
      ...(streamCodecs ? ([["Codecs (stream)", streamCodecs]] as [string, string][]) : []),
      ["Volume / Normalized", `${muted ? "muted" : `${Math.round(volume * 100)}%`} / ${normalizationDb === null ? "off" : `${normalizationDb > 0 ? "+" : ""}${normalizationDb} dB`}`],
      ["Buffer health", `${client.buffer.toFixed(2)} s`],
      ["Connection speed", bandwidth ? `${Math.round(bandwidth / 1000)} Kbps` : "—"],
      ["Network activity", lastFragment ? `${Math.round(lastFragment.bytes / 1024)} KB in ${Math.round(lastFragment.ms)} ms` : "—"],
      ["Position", formatTime(position)],
    ];
    if (server) {
      out.push(
        ["File", `${server.file.path}`],
        ["Container / Size / Bitrate", `${server.file.container} / ${bytes(server.file.sizeBytes)} / ${megabits(server.file.bitRate)}`],
        [
          "Decode check",
          server.file.health
            ? server.file.health.severity === "clean"
              ? `clean (checked ${new Date(server.file.health.checkedAt).toLocaleDateString()})`
              : `${server.file.health.severity} (${server.file.health.videoErrors} video, ${server.file.health.audioErrors} audio errors): ${server.file.health.error}`
            : "not checked yet",
        ],
        [
          "Source video",
          source
            ? `${source.codec}${source.profile ? ` (${source.profile})` : ""} ${source.width}×${source.height} ${source.bitDepth}-bit${source.frameRate ? ` ${source.frameRate.toFixed(3)} fps` : ""}${source.isHdr ? " HDR" : ""}`
            : "none",
        ],
        ["Source audio", audio ? `${audio.codec} ${audio.channels}ch${audio.sampleRate ? ` ${audio.sampleRate / 1000} kHz` : ""}${audio.language ? ` (${audio.language})` : ""}` : "none"],
      );
    }
    if (transcode) {
      const video = transcode.video;
      const audioOut = transcode.audio;
      out.push(
        [
          "Output video",
          !video ? "none" : video.action === "copy" ? `copy (${video.codec})` : `${video.codec} ${video.width}×${video.height} @ ${megabits(video.bitrate)}`,
        ],
        [
          "Output audio",
          !audioOut ? "none" : audioOut.action === "copy" ? `copy (${audioOut.codec})` : `${audioOut.codec} ${audioOut.channels}ch @ ${Math.round((audioOut.bitrate ?? 0) / 1000)} Kbps`,
        ],
        ["Segments", `${transcode.segmentContainer}${transcode.subtitle ? ` · subtitles ${transcode.subtitle}` : ""}`],
        [
          "Decode",
          transcode.encoder ? device(transcode.encoder.decode, transcode.encoder.decodeDevice) : "— (video copied)",
        ],
        [
          "Encode",
          transcode.encoder
            ? `${device(transcode.encoder.encode, transcode.encoder.encodeDevice)}${transcode.encoder.accel !== "none" ? ` (${transcode.encoder.accel.toUpperCase()})` : ""}`
            : "— (video copied)",
        ],
        ["ffmpeg", `${transcode.state}${transcode.speed !== null ? ` · ${transcode.speed.toFixed(2)}× realtime` : ""}`],
        ["Transcoded ahead", `${Math.max(0, transcode.transcodedUntilSeconds - position).toFixed(0)} s (to ${formatTime(transcode.transcodedUntilSeconds)})`],
      );
      if (transcode.hardwareError) out.push(["GPU failure", transcode.hardwareError]);
      if (transcode.error) out.push(["ffmpeg error", transcode.error]);
    } else if (server && session?.mode === "direct-play") {
      out.push(["Server", "serving the file as-is (no ffmpeg)"]);
    }
    for (const event of fallbacks) out.push([`Fell back → ${event.level}`, `at ${formatTime(event.atSeconds)}: ${event.reason}`]);
    if (serverError) out.push(["Server stats", serverError]);
    return out;
  });
</script>

<!-- Stops clicks reaching the video underneath, which would toggle playback. -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="stats absolute top-14 left-4 z-10 max-h-[70vh] max-w-[min(36rem,calc(100vw-2rem))] overflow-auto rounded bg-black/75 p-3 font-mono text-xs"
  onpointerup={(event) => event.stopPropagation()}
  onclick={(event) => event.stopPropagation()}
>
  <button type="button" class="btn btn-ghost btn-circle btn-xs absolute top-1 right-1" onclick={onclose} aria-label="Close stats" title="Close (i)">
    <Icon name="close" class="size-4" />
  </button>
  <table>
    <tbody>
      {#each rows as [label, value] (label)}
        <tr>
          <th class="pr-3 text-right align-top font-normal whitespace-nowrap opacity-70">{label}</th>
          <td class="break-all select-text">{value}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
